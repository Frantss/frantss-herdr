import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

async function harness(refresh = false) {
  let phase = "render";
  const state: any = {
    lists: [],
    rows: [],
    calls: [],
    zoom: 0.8,
    cwd: "/repo",
    on: null,
    directories: new Map(),
    executions: [],
    tasks: [],
    held: new Map(),
    notifications: 0,
    watchEvents: [],
  };
  const cx: any = {
    spawn(callback) {
      const task = Promise.resolve().then(() => callback(cx));
      state.tasks.push(task);
      return task;
    },
    notify() {
      state.notifications++;
    },
    async sleep() {},
  };
  async function drain() {
    for (let start = 0; start < state.tasks.length;) {
      const batch = state.tasks.slice(start);
      start = state.tasks.length;
      await Promise.all(batch);
    }
    state.tasks = [];
  }
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
      [
        "focused",
        () => ({ cwd: state.cwd, pane: null, terminal: state.on ? `${state.on}/t1` : null }),
      ],
      ["layout", () => null],
      ["window", () => ({ platform: "macos" })],
      ["settings", () => ({ zoom: state.zoom })],
      ["theme", () => palette],
    ]),
  };
  if (refresh)
    natives.herdr.exec = async (command, args, options) => {
      state.executions.push({ command, args, options });
      if (command === "sh") {
        const path = args.at(-1);
        if (path === state.directoryError) throw new Error("Cannot list folder");
        const entries = await (state.held.get(path) ?? state.directories.get(path) ?? []);
        return {
          code: 0,
          stdout: entries.map((entry) => `${entry.dir ? "d" : "f"}\0${entry.name}\0`).join(""),
          stderr: "",
        };
      }
      if (command === "git" && args.includes("--show-toplevel"))
        return { code: 0, stdout: options.cwd, stderr: "" };
      if (command === "git" && args.includes("status"))
        return { code: 0, stdout: " M changed.ts\0", stderr: "" };
      throw new Error(`Unexpected command ${command}`);
    };
  if (refresh)
    natives.herdr.watchFolder = async () => {
      const paths = state.watchEvents.shift();
      if (!paths) throw new Error("Watcher stopped");
      return paths;
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
    generation: 0,
    invalidated: new Set(),
    fullRefresh: false,
    pending: new Set(),
    root: "/repo",
    context: JSON.stringify({ cwd: "/repo", on: null }),
  });
  const watch = files.watch.bind(files);
  if (refresh) files.watch = () => {};
  else {
    files.toggle = (path) => state.calls.push(["toggle", path]);
    files.open = (path) => state.calls.push(["open", path]);
  }
  return {
    files,
    state,
    cx,
    drain,
    watch,
    render: () => files.render(cx),
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

const deferred = () => {
  let resolve;
  const promise = new Promise<any[]>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const listedFolders = (state) =>
  state.executions.filter((call) => call.command === "sh").map((call) => call.args.at(-1));
async function expandedFiles() {
  const h = await harness(true);
  for (const path of ["src", "tests"]) {
    h.files.folders.add(path);
    h.files.entries.set(path, [{ name: "old.ts", dir: false }]);
    h.state.directories.set(`/repo/${path}`, [{ name: "next.ts", dir: false }]);
  }
  h.files.entries.set("", [
    { name: "src", dir: true },
    { name: "tests", dir: true },
  ]);
  h.state.directories.set("/repo", h.files.entries.get(""));
  return h;
}

test("file watcher refreshes affected loaded folders and Git marks without listing siblings", async () => {
  const h = await expandedFiles();
  h.files.refresh(h.cx, ["/repo/src/next.ts"]);
  await h.drain();
  assert.deepEqual(listedFolders(h.state), ["/repo/src"]);
  assert.equal(h.files.entries.get("src")[0].name, "next.ts");
  assert.equal(h.files.entries.get("tests")[0].name, "old.ts");
  assert.equal(h.files.marks["/repo/changed.ts"], "M");
});

test("unknown, root, outside, and Git changes use full reconciliation", async () => {
  for (const changed of [
    ["/repo"],
    ["/elsewhere/file"],
    ["/repo/.git/index"],
    ["/repo/unknown/file"],
    ["relative/file"],
    ["C:\\repo\\src\\file.ts"],
    undefined,
  ]) {
    const h = await expandedFiles();
    h.files.refresh(h.cx, changed);
    await h.drain();
    assert.deepEqual(listedFolders(h.state), ["/repo", "/repo/src", "/repo/tests"]);
  }
});

test("invalidations arriving during a listing are refreshed afterwards", async () => {
  const h = await expandedFiles();
  const held = deferred();
  h.state.held.set("/repo/src", held.promise);
  h.files.refresh(h.cx, ["/repo/src/file.ts"]);
  await Promise.resolve();
  h.files.refresh(h.cx, ["/repo/tests/file.ts"]);
  held.resolve([{ name: "saved.ts", dir: false }]);
  await h.drain();
  assert.deepEqual(listedFolders(h.state), ["/repo/src", "/repo/tests"]);
});

test("context changes replace loading state and reject old A→B→A results", async () => {
  const h = await expandedFiles();
  const held = deferred();
  h.state.held.set("/repo", held.promise);
  h.files.refresh(h.cx);
  await Promise.resolve();
  h.state.cwd = "/other";
  h.files.refresh(h.cx);
  assert.equal(h.files.root, "/other");
  h.state.held.delete("/repo");
  h.state.cwd = "/repo";
  h.state.directories.set("/repo", [{ name: "current.ts", dir: false }]);
  h.files.refresh(h.cx);
  held.resolve([{ name: "obsolete.ts", dir: false }]);
  await h.drain();
  assert.equal(h.files.entries.get("")[0].name, "current.ts");
  assert.equal(h.files.loading, false);
  assert.ok(
    h.state.executions
      .filter((call) => call.command === "sh")
      .every((call) => call.options.on === null),
  );
});

test("closing an expanding folder prevents its pending result from restoring entries", async () => {
  const h = await harness(true);
  const held = deferred();
  h.state.held.set("/repo/src", held.promise);
  h.files.toggle("src", h.cx);
  await Promise.resolve();
  h.files.toggle("src", h.cx);
  held.resolve([{ name: "old.ts", dir: false }]);
  await h.drain();
  assert.equal(h.files.entries.has("src"), false);
  assert.equal(h.files.pending.size, 0);
});

test("a changed expanded folder refreshes itself and its loaded parent", async () => {
  const h = await expandedFiles();
  h.files.refresh(h.cx, ["/repo/src"]);
  await h.drain();
  assert.deepEqual(listedFolders(h.state), ["/repo", "/repo/src"]);
});

test("deleted expanded folders are removed before stale descendants are listed", async () => {
  const h = await expandedFiles();
  h.state.directories.set("/repo", [{ name: "tests", dir: true }]);
  h.files.refresh(h.cx, ["/repo/src"]);
  await h.drain();
  assert.deepEqual(listedFolders(h.state), ["/repo"]);
  assert.equal(h.files.folders.has("src"), false);
  assert.equal(h.files.entries.has("src"), false);
  assert.equal(h.files.error, null);
});

test("an obsolete expansion cannot clear a new context's pending folder", async () => {
  const h = await harness(true);
  const old = deferred(),
    current = deferred();
  h.state.held.set("/repo/src", old.promise);
  h.files.toggle("src", h.cx);
  const oldTask = h.state.tasks[0];
  await Promise.resolve();
  h.state.cwd = "/other";
  h.files.refresh(h.cx);
  h.state.cwd = "/repo";
  h.state.directories.set("/repo", [{ name: "src", dir: true }]);
  h.files.refresh(h.cx);
  h.state.held.set("/repo/src", current.promise);
  h.files.toggle("src", h.cx);
  old.resolve([{ name: "obsolete.ts", dir: false }]);
  await oldTask;
  assert.equal(h.files.pending.has("src"), true);
  current.resolve([{ name: "current.ts", dir: false }]);
  await h.drain();
  assert.equal(h.files.entries.get("src")[0].name, "current.ts");
  assert.equal(h.files.pending.size, 0);
});

test("mixed watcher batches ignore lock files and dependency paths before invalidation", async () => {
  const h = await expandedFiles();
  h.state.watchEvents.push([
    "/repo/src/next.ts",
    "/repo/node_modules/pkg/file.js",
    "/repo/.git/index.lock",
  ]);
  h.watch("/repo", h.cx);
  await h.drain();
  assert.deepEqual(listedFolders(h.state), ["/repo/src"]);
});

test("unchanged Files refreshes preserve arrays and marks without notifying", async () => {
  const h = await expandedFiles();
  h.files.refresh(h.cx);
  await h.drain();
  const entries = h.files.entries.get("src"),
    marks = h.files.marks;
  h.state.notifications = 0;
  h.files.refresh(h.cx);
  await h.drain();
  assert.equal(h.state.notifications, 0);
  assert.equal(h.files.entries.get("src"), entries);
  assert.equal(h.files.marks, marks);
});

test("Files notifies on changes, errors, and recovery but suppresses repeated errors", async () => {
  const h = await expandedFiles();
  h.files.refresh(h.cx);
  await h.drain();
  h.state.notifications = 0;
  h.state.directories.set("/repo/src", [{ name: "changed.ts", dir: false }]);
  h.files.refresh(h.cx, ["/repo/src/changed.ts"]);
  await h.drain();
  assert.equal(h.state.notifications, 1);
  h.state.directoryError = "/repo/src";
  h.files.refresh(h.cx, ["/repo/src/file.ts"]);
  await h.drain();
  assert.equal(h.state.notifications, 2);
  h.files.refresh(h.cx, ["/repo/src/file.ts"]);
  await h.drain();
  assert.equal(h.state.notifications, 2);
  h.state.directoryError = null;
  h.files.refresh(h.cx, ["/repo/src/file.ts"]);
  await h.drain();
  assert.equal(h.state.notifications, 3);
});

test("Files completes loading visibly when an intervening render exposed it", async () => {
  const h = await expandedFiles();
  h.files.refresh(h.cx);
  await h.drain();
  h.state.notifications = 0;
  const held = deferred();
  h.state.held.set("/repo", held.promise);
  h.files.refresh(h.cx);
  h.render();
  assert.equal(h.files.loadingRendered, true);
  held.resolve(h.state.directories.get("/repo"));
  await h.drain();
  assert.equal(h.files.loading, false);
  assert.equal(h.state.notifications, 1);
});
