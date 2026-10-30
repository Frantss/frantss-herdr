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
            if (name === "id" && String(args[0]).startsWith("change-")) state.rows.push(node);
          }
          return proxy;
        };
      },
    });
    return proxy;
  }
  const context = vm.createContext({});
  const palette = {
    muted: "#aaaaaa",
    foreground: "#ffffff",
    dim: "#555555",
    selected: "#333333",
    ansi1: "#ff0000",
    ansi2: "#00ff00",
    accent: "#aabbcc",
  };
  const natives = {
    "gpui-kit": { View: class {}, div: element, svg: element, image: element },
    "gpui-base": {
      v_flex: element,
      h_flex: element,
      Scrollbar: { vertical: element },
      InputState: {},
      Input: { new: element },
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
  const Changes = (module.namespace as { default: new () => any }).default;
  const changes = new Changes();
  Object.assign(changes, {
    files: [],
    rows: [],
    diffWidth: 0,
    message: "",
    root: "/repo",
    context: JSON.stringify({ cwd: "/repo", on: null }),
  });
  changes.pick = (path) => state.calls.push(["pick", path]);
  return {
    changes,
    state,
    render: () => changes.render({}),
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

const file = (path: string) => ({ path, status: "M", fresh: false, add: 1, del: 2 });
const text = (node) =>
  typeof node === "string" ? node : (node?.childNodes ?? []).map(text).join(" ");

test("Changes constructs only requested file rows and selects by stable path after reorder", async () => {
  const h = await harness();
  h.changes.files = Array.from({ length: 1000 }, (_, i) => file(`src/file-${i}.ts`));
  h.changes.open = "src/file-300.ts";
  h.render();
  assert.equal(h.state.rows.length, 0);
  const list = h.state.lists.find((list) => list.id === "changes-files");
  assert.equal(list.count, 1000);
  assert.equal(list.extent, 26 * h.state.zoom);
  assert.equal(list.key(300), "src/file-300.ts");
  const rows = h.range(list, 300, 308);
  assert.equal(h.state.rows.length, 8);
  assert.ok(h.state.rows[0].styles.some(([key, value]) => key === "bg" && value === "#333333"));
  assert.ok(text(rows[0]).includes("src/ file-300.ts +1 −2"));
  h.changes.files.reverse();
  h.render();
  h.state.lists.at(-1).node.handlers.on_item_click("src/file-300.ts", {});
  assert.deepEqual(h.state.calls, [["pick", "src/file-300.ts"]]);
});

test("Changes keeps the file viewport capped and preserves empty and error messages", async () => {
  const h = await harness();
  const empty = h.render();
  assert.equal(h.state.lists.length, 0);
  assert.ok(text(empty).includes("No uncommitted changes"));
  h.changes.error = "Cannot read changes";
  assert.ok(text(h.render()).includes("Cannot read changes"));
  h.changes.files = Array.from({ length: 1000 }, (_, i) => file(`file-${i}.ts`));
  const tree = h.render();
  function find(node, id) {
    if (node?.styles?.some(([key, value]) => key === "id" && value === id)) return node;
    return (node?.childNodes ?? []).map((child) => find(child, id)).find(Boolean);
  }
  assert.ok(find(tree, "changes-list").styles.some(([key, value]) => key === "h" && value === 200));
});
