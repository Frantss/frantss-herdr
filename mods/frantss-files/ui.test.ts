import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

async function harness() {
  let phase = "render";
  const state: any = { lists: [], rows: [], calls: [], zoom: 0.8 };
  function element() {
    const node: any = { childNodes: [], styles: [], handlers: {} };
    const proxy = new Proxy(node, {
      get(target, name) {
        if (name in target) return target[name];
        if (name === "then") return undefined;
        return (...args) => {
          if (String(name).startsWith("on_")) {
            assert.notEqual(phase, "layout", "Handlers must be registered outside list layout");
            node.handlers[name] = args.at(-1);
          } else if (name === "when") {
            if (args[0]) args[1](proxy);
          } else if (name === "child") node.childNodes.push(args[0]);
          else if (name === "children") node.childNodes.push(...args[0]);
          else {
            node.styles.push([name, ...args]);
            if (name === "id" && String(args[0]).startsWith("file-")) state.rows.push(node);
          }
          return proxy;
        };
      },
    });
    return proxy;
  }
  const context = vm.createContext({});
  const palette = { background: "#111111", muted: "#aaaaaa", dim: "#555555" };
  const natives = {
    "gpui-kit": { View: class {}, div: element, svg: element, image: element },
    "gpui-base": {
      v_flex: element,
      h_flex: element,
      Scrollbar: { vertical: element },
      v_virtual_list(id, count, extent, key, render) {
        const node = element();
        state.lists.push({ id, count, extent, key, render, node });
        return node;
      },
    },
    herdr: Object.fromEntries([
      ...[
        "exec",
        "readTextFile",
        "writeTextFile",
        "watchFolder",
        "appHome",
        "home",
        "run",
        "notify",
        "terminals",
      ].map((name) => [
        name,
        () => {
          throw new Error(`Unexpected host call ${name}`);
        },
      ]),
      ["spaces", () => []],
      ["panes", () => []],
      ["focused", () => ({ cwd: "/repo", pane: null })],
      ["layout", () => null],
      ["window", () => ({ platform: "macos" })],
      ["settings", () => ({ zoom: state.zoom })],
      ["theme", () => palette],
    ]),
  };
  const modules = new Map<string, vm.Module>();
  async function load(id: string): Promise<vm.Module> {
    if (modules.has(id)) return modules.get(id);
    const native = natives[id];
    const module = native
      ? new vm.SyntheticModule(
          Object.keys(native),
          function () {
            for (const [key, value] of Object.entries(native)) this.setExport(key, value);
          },
          { context },
        )
      : new vm.SourceTextModule(stripTypeScriptTypes(await readFile(new URL(id), "utf8")), {
          context,
          identifier: id,
        });
    modules.set(id, module);
    return module;
  }
  const module = await load(new URL("main.ts", import.meta.url).href);
  await module.link((id, parent) =>
    load(id.startsWith(".") ? new URL(id, parent.identifier).href : id),
  );
  await module.evaluate();
  const Files = (module.namespace as { default: new () => any }).default;
  const files = new Files();
  Object.assign(files, {
    entries: new Map(),
    folders: new Set(),
    marks: {},
    root: "/repo",
    context: JSON.stringify({ cwd: "/repo", on: null }),
  });
  files.toggle = (path) => state.calls.push(["toggle", path]);
  files.open = (path) => state.calls.push(["open", path]);
  return {
    files,
    state,
    render: () => files.render({}),
    range(list, start, end) {
      phase = "layout";
      try {
        return list.render({ start, end });
      } finally {
        phase = "render";
      }
    },
  };
}

test("Files constructs only the requested viewport and dispatches clicks by stable path", async () => {
  const h = await harness();
  h.files.entries.set(
    "",
    Array.from({ length: 10 }, (_, i) => ({ name: `dir-${i}`, dir: true })),
  );
  for (let i = 0; i < 10; i++) {
    h.files.folders.add(`dir-${i}`);
    h.files.entries.set(
      `dir-${i}`,
      Array.from({ length: 499 }, (_, j) => ({ name: `file-${j}.ts`, dir: false })),
    );
  }
  h.render();
  assert.equal(h.state.rows.length, 0);
  assert.equal(h.state.lists.length, 1);
  const list = h.state.lists[0];
  assert.equal(list.count, 5000);
  assert.equal(list.extent, 24 * 0.8);
  assert.equal(list.key(301), "dir-0/file-300.ts");
  h.range(list, 300, 310);
  assert.equal(h.state.rows.length, 10);
  h.files.entries.get("").reverse();
  h.render();
  h.state.lists.at(-1).node.handlers.on_item_click("dir-0/file-300.ts", {});
  assert.deepEqual(h.state.calls, [["open", "dir-0/file-300.ts"]]);
});

test("Files keeps expanded directory order, depth, ignored inheritance, and directory clicks", async () => {
  const h = await harness();
  h.files.entries.set("", [
    { name: "dist", dir: true },
    { name: "main.ts", dir: false },
  ]);
  h.files.entries.set("dist", [{ name: "output.js", dir: false }]);
  h.files.folders.add("dist");
  h.files.marks["/repo/dist"] = "I";
  h.render();
  const list = h.state.lists[0];
  assert.deepEqual(
    Array.from({ length: list.count }, (_, i) => list.key(i)),
    ["dist", "dist/output.js", "main.ts"],
  );
  const rows = h.range(list, 0, 3);
  assert.ok(rows[1].styles.some(([key, value]) => key === "pl" && value === 22));
  assert.ok(
    rows[1].childNodes.some(
      (node) =>
        node?.childNodes?.includes("output.js") &&
        node.styles.some(([key, value]) => key === "text_color" && value === "#555555"),
    ),
  );
  list.node.handlers.on_item_click("dist", {});
  assert.deepEqual(h.state.calls, [["toggle", "dist"]]);
});
