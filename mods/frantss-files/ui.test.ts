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
    editors: [],
    texts: {},
    commands: [],
    notices: [],
    shared: {},
    zoom: 0.8,
    cwd: "/repo",
    on: null,
    directories: new Map(),
    executions: [],
    tasks: [],
    held: new Map(),
    notifications: 0,
    watchEvents: [],
    activeDirectories: 0,
    maxDirectories: 0,
    layout: null,
    elements: 0,
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
    write_to_clipboard(text) {
      state.clipboard = text;
    },
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
    state.elements++;
    const node: any = { childNodes: [], styles: [], handlers: {} };
    const proxy = new Proxy(node, {
      get(target, name) {
        if (name in target) return target[name];
        if (name === "then") return undefined;
        return (...args) => {
          if (String(name).startsWith("on_")) {
            assert.notEqual(phase, "layout", "Handlers must be registered outside list layout");
            node.handlers[name] = args.at(-1);
            // One handler per button, as GPUI keeps them.
            if (name === "on_mouse_down") node.handlers[`${name}:${args[0]}`] = args.at(-1);
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
    "gpui-kit": {
      View: class {},
      div: element,
      svg: element,
      image(path) {
        const node = element();
        node.src = path;
        return node;
      },
    },
    "gpui-base": {
      v_flex: element,
      h_flex: element,
      Scrollbar: { vertical: element },
      v_resizable: element,
      resizable_panel: element,
      Button: { new: (id) => element().id(id) },
      Editor: { new: element },
      Input: { new: element },
      InputState: {},
      EditorState: {
        new(options) {
          const code = {
            options,
            released: false,
            release() {
              code.released = true;
            },
          };
          state.editors.push(code);
          return code;
        },
      },
      TextView: {
        markdown(_id, markdown) {
          const node = element();
          node.markdown = markdown;
          return node;
        },
      },
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
      ["shared", (key) => state.shared[key] ?? null],
      [
        "setShared",
        (key, value) => {
          state.shared[key] = value;
        },
      ],
      ["panes", () => []],
      [
        "focused",
        () => ({ cwd: state.cwd, pane: null, terminal: state.on ? `${state.on}/t1` : null }),
      ],
      ["props", () => null],
      ["layout", () => state.layout],
      ["window", () => ({ platform: "macos" })],
      ["settings", () => ({ zoom: state.zoom })],
      ["theme", () => palette],
    ]),
  };
  natives.herdr.readTextFile = async (path) => {
    if (!(path in state.texts)) throw new Error(`Unexpected read ${path}`);
    return state.texts[path];
  };
  natives.herdr.notify = (notice) => state.notices.push(notice);
  if (!refresh)
    natives.herdr.exec = async (command, args, options) => {
      state.commands.push([command, ...args, options?.on ?? null]);
      return state.run?.(command, args) ?? { code: 0, stdout: "", stderr: "" };
    };
  if (refresh)
    natives.herdr.exec = async (command, args, options) => {
      state.executions.push({ command, args, options });
      if (command === "sh") {
        const path = args.at(-1);
        if (path === state.directoryError) throw new Error("Cannot list folder");
        state.activeDirectories++;
        state.maxDirectories = Math.max(state.maxDirectories, state.activeDirectories);
        try {
          const entries = await (state.held.get(path) ?? state.directories.get(path) ?? []);
          return {
            code: 0,
            stdout: entries.map((entry) => `${entry.dir ? "d" : "f"}\0${entry.name}\0`).join(""),
            stderr: "",
          };
        } finally {
          state.activeDirectories--;
        }
      }
      if (command === "git" && args.includes("--show-toplevel"))
        return { code: 0, stdout: options.cwd, stderr: "" };
      if (command === "git" && args.includes("status"))
        return { code: 0, stdout: state.gitStatus ?? " M changed.ts\0", stderr: "" };
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
    entryCount: 0,
    folders: new Set(),
    marks: {},
    generation: 0,
    invalidated: new Set(),
    fullRefresh: false,
    pending: new Set(),
    kept: new Map(),
    file: null,
    fileText: null,
    fileError: null,
    code: null,
    source: false,
    menu: null,
    pressed: null,
    editing: null,
    editError: null,
    handle: { focus() {} },
    nameInput: (() => {
      let value = "";
      return {
        value: () => value,
        set_value(next) {
          value = next;
        },
        focus() {},
      };
    })(),
    root: "/repo",
    context: JSON.stringify({ cwd: "/repo", on: null }),
  });
  const watch = files.watch.bind(files);
  if (refresh) files.watch = () => {};
  else {
    files.toggle = (path) => state.calls.push(["toggle", path]);
    files.openInFresh = (path) => state.calls.push(["fresh", path]);
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

test("hidden Files renders retain state and skip row work without forcing a reveal refresh", async () => {
  const h = await harness();
  const entries = new Map([["", [{ name: "kept.ts", dir: false }]]]);
  h.files.entries = entries;
  h.files.entryCount = 1;
  h.files.stale = false;
  h.files.loading = true;
  h.files.loadingRendered = false;
  h.state.layout = {
    children: [
      { id: "panel", hidden: true },
      { id: "panel-body", active: "files" },
    ],
  };
  const rows = h.files.rows.bind(h.files);
  h.files.rows = () => assert.fail("Hidden Files built its row model");
  h.render();
  assert.equal(h.state.elements, 1);
  assert.equal(h.state.lists.length, 0);
  assert.equal(h.files.entries, entries);
  assert.equal(h.files.stale, false);
  assert.equal(h.files.loadingRendered, false);
  h.files.rows = rows;
  h.files.loading = false;
  h.state.layout.children[0].hidden = false;
  h.files.refresh = () => assert.fail("A reveal forced an unnecessary refresh");
  h.render();
  assert.equal(h.state.lists.length, 1);
  h.state.layout.children[0].hidden = true;
  h.files.stale = true;
  h.render();
  assert.equal(h.files.stale, true);
  let refreshes = 0;
  h.files.refresh = () => refreshes++;
  h.state.layout.children[0].hidden = false;
  h.render();
  h.render();
  assert.equal(refreshes, 1);
});

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
  seedEntryCount(h.files);
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
  h.state.lists.at(-1).node.handlers.on_item_click("dir-0/file-300.ts", h.cx);
  assert.equal(h.files.file, "dir-0/file-300.ts");
  assert.deepEqual(h.state.calls, []);
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
  seedEntryCount(h.files);
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
const seedEntryCount = (files) => {
  files.entryCount = [...files.entries.values()].reduce(
    (total, entries) => total + entries.length,
    0,
  );
};

test("unchanged directory reconciliation does not rescan unrelated expanded folders", async () => {
  const h = await expandedFiles();
  const folders = h.files.folders,
    iterate = folders[Symbol.iterator].bind(folders);
  let visits = 0;
  folders[Symbol.iterator] = function* () {
    for (const folder of iterate()) {
      visits++;
      yield folder;
    }
  };
  h.files.applyFolder("", h.files.entries.get(""), h.files.context, h.files.generation);
  visits = 0;
  for (const path of ["", "src", "tests"])
    h.files.applyFolder(path, h.files.entries.get(path), h.files.context, h.files.generation);
  assert.equal(visits, 0);
});

test("an expansion during a pending listing is pruned by its unchanged parent", async () => {
  const h = await expandedFiles();
  const held = deferred();
  h.state.held.set("/repo/src", held.promise);
  h.files.refresh(h.cx, ["/repo/src/old.ts"]);
  await ticks();
  h.files.toggle("src/removed", h.cx);
  await ticks();
  assert.equal(h.files.folders.has("src/removed"), true);
  held.resolve(h.files.entries.get("src"));
  await h.drain();
  assert.equal(h.files.folders.has("src/removed"), false);
  assert.equal(h.files.entries.has("src/removed"), false);
  assert.equal(h.files.folders.has("tests"), true);
});

test("Files reuses row metadata until directory contents or expansion changes", async () => {
  const h = await expandedFiles();
  const rows = h.files.rows();
  assert.equal(h.files.rows(), rows);
  h.files.applyFolder("src", h.files.entries.get("src"), h.files.context, h.files.generation);
  assert.equal(h.files.rows(), rows);
  h.files.applyFolder(
    "src",
    [{ name: "saved.ts", dir: false }],
    h.files.context,
    h.files.generation,
  );
  const changed = h.files.rows();
  assert.notEqual(changed, rows);
  assert.ok(changed.some((row) => row.path === "src/saved.ts"));
  h.files.toggle("src", h.cx);
  assert.ok(!h.files.rows().some((row) => row.path.startsWith("src/")));
  h.files.toggle("src", h.cx);
  await h.drain();
  assert.ok(h.files.rows().some((row) => row.path === "src/next.ts"));
});

test("cached Files metadata follows Git marks and restored places", async () => {
  const h = await expandedFiles();
  const rows = h.files.rows();
  h.state.gitStatus = "!! src/\0";
  h.files.refresh(h.cx);
  await h.drain();
  assert.notEqual(h.files.rows(), rows);
  assert.ok(h.files.rows().find((row) => row.path === "src/next.ts").ignored);
  h.state.cwd = "/other";
  h.state.directories.set("/other", [{ name: "other.ts", dir: false }]);
  h.files.refresh(h.cx);
  await h.drain();
  assert.deepEqual(
    Array.from(h.files.rows() as { path: string }[], (row) => row.path),
    ["other.ts"],
  );
  h.state.cwd = "/repo";
  h.files.refresh(h.cx);
  await h.drain();
  assert.ok(h.files.rows().some((row) => row.path === "src/next.ts" && row.ignored));
  assert.ok(!h.files.rows().some((row) => row.path === "other.ts"));
});

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
  seedEntryCount(h.files);
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
  if (h.files.folders.has("src")) h.files.toggle("src", h.cx);
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

const ticks = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

test("Files overlaps two sibling listings but applies them in original order", async () => {
  const h = await expandedFiles();
  const src = deferred(),
    tests = deferred();
  h.state.held.set("/repo/src", src.promise);
  h.state.held.set("/repo/tests", tests.promise);
  h.files.refresh(h.cx);
  await ticks();
  const overlap = h.state.maxDirectories;
  tests.resolve([{ name: "second.ts", dir: false }]);
  await ticks();
  assert.equal(h.files.entries.get("tests")[0].name, "old.ts");
  src.resolve([{ name: "first.ts", dir: false }]);
  await h.drain();
  assert.equal(overlap, 2);
  assert.equal(h.state.maxDirectories, 2);
  assert.equal(h.files.entries.get("src")[0].name, "first.ts");
  assert.equal(h.files.entries.get("tests")[0].name, "second.ts");
});

test("reverse directory completion preserves deterministic global entry limits", async () => {
  const h = await expandedFiles();
  h.files.entries.set("src", []);
  h.files.entries.set("tests", []);
  for (let i = 0; i < 9; i++) {
    h.files.entries.get("").push({ name: `filler-${i}`, dir: true });
    h.files.entries.set(
      `filler-${i}`,
      Array.from({ length: 500 }, (_, j) => ({ name: `file-${j}`, dir: false })),
    );
  }
  seedEntryCount(h.files);
  const src = deferred(),
    tests = deferred();
  h.state.held.set("/repo/src", src.promise);
  h.state.held.set("/repo/tests", tests.promise);
  h.files.refresh(h.cx, ["/repo/src/file", "/repo/tests/file"]);
  await ticks();
  tests.resolve(Array.from({ length: 300 }, (_, i) => ({ name: `second-${i}`, dir: false })));
  await ticks();
  src.resolve(Array.from({ length: 300 }, (_, i) => ({ name: `first-${i}`, dir: false })));
  await h.drain();
  assert.equal(h.files.entries.get("src").length, 300);
  assert.equal(h.files.entries.get("tests").length, 189);
  assert.equal(
    [...h.files.entries.values()].reduce((total, entries) => total + entries.length, 0),
    5000,
  );
  assert.equal(h.files.limited, true);
});

test("directory batch errors retain earlier progress and stop subsequent batches", async () => {
  const h = await expandedFiles();
  h.files.folders.add("other");
  h.files.entries.set("other", [{ name: "old.ts", dir: false }]);
  seedEntryCount(h.files);
  h.state.directoryError = "/repo/tests";
  h.files.refresh(h.cx, ["/repo/src/file", "/repo/tests/file", "/repo/other/file"]);
  await h.drain();
  assert.equal(h.files.entries.get("src")[0].name, "next.ts");
  assert.equal(h.files.entries.get("other")[0].name, "old.ts");
  assert.deepEqual(listedFolders(h.state), ["/repo/src", "/repo/tests"]);
  assert.equal(h.files.error, "Error: Cannot list folder");
});

test("a stale directory batch cannot apply results or start later directory and Git commands", async () => {
  const h = await expandedFiles();
  const src = deferred(),
    tests = deferred();
  h.state.held.set("/repo/src", src.promise);
  h.state.held.set("/repo/tests", tests.promise);
  h.files.refresh(h.cx, ["/repo/src/file", "/repo/tests/file"]);
  await ticks();
  h.state.cwd = "/other";
  h.files.refresh(h.cx);
  src.resolve([{ name: "obsolete.ts", dir: false }]);
  tests.resolve([]);
  await h.drain();
  assert.equal(h.files.root, "/other");
  assert.equal(h.files.entries.has("src"), false);
  assert.ok(
    h.state.executions
      .filter((call) => call.command === "git")
      .every((call) => call.options.cwd === "/other"),
  );
});

test("parent listings prune deleted nested folders before later batches fetch them", async () => {
  const h = await expandedFiles();
  h.files.entries.set("src", [{ name: "deep", dir: true }]);
  h.files.folders.add("src/deep");
  h.files.entries.set("src/deep", [{ name: "old.ts", dir: false }]);
  seedEntryCount(h.files);
  h.files.refresh(h.cx);
  await h.drain();
  assert.deepEqual(listedFolders(h.state), ["/repo", "/repo/src", "/repo/tests"]);
  assert.equal(h.files.folders.has("src/deep"), false);
  assert.equal(h.files.entries.has("src/deep"), false);
});

test("child-first watcher events apply the parent before fetching a deleted child", async () => {
  const h = await expandedFiles();
  h.files.entries.set("src", [{ name: "deep", dir: true }]);
  h.files.folders.add("src/deep");
  h.files.entries.set("src/deep", [{ name: "old.ts", dir: false }]);
  seedEntryCount(h.files);
  h.state.directoryError = "/repo/src/deep";
  h.files.refresh(h.cx, ["/repo/src/deep/old.ts", "/repo/src/deep"]);
  await h.drain();
  assert.deepEqual(listedFolders(h.state), ["/repo/src"]);
  assert.equal(h.files.entries.has("src/deep"), false);
  assert.equal(h.files.error, null);
});

test("Files restores cloned context rows immediately and then reconciles the full tree", async () => {
  const h = await expandedFiles();
  h.files.refresh(h.cx);
  await h.drain();
  const entries = h.files.entries,
    folders = h.files.folders;
  h.state.cwd = "/other";
  h.state.directories.set("/other", [{ name: "other.ts", dir: false }]);
  h.files.refresh(h.cx);
  await h.drain();
  const held = deferred();
  h.state.held.set("/repo", held.promise);
  h.state.cwd = "/repo";
  h.files.refresh(h.cx);
  assert.equal(h.files.entries.get("src")[0].name, "next.ts");
  assert.equal(h.files.folders.has("src"), true);
  assert.equal(h.files.entryCount, 4);
  assert.notEqual(h.files.entries, entries);
  assert.notEqual(h.files.folders, folders);
  assert.equal(h.files.pending.size, 0);
  const start = h.state.executions.length;
  held.resolve([{ name: "fresh.ts", dir: false }]);
  await h.drain();
  assert.equal(h.files.entries.get("")[0].name, "fresh.ts");
  assert.equal(h.files.folders.size, 0);
  assert.equal(h.files.entryCount, 1);
  assert.equal(
    h.state.executions
      .slice(start)
      .find((call) => call.command === "sh")
      .args.at(-1),
    "/repo",
  );
});

test("Files snapshots distinguish machines for the same checkout path", async () => {
  const h = await harness(true);
  h.state.directories.set("/repo", [{ name: "local.ts", dir: false }]);
  h.files.refresh(h.cx);
  await h.drain();
  h.state.on = "server";
  h.state.directories.set("/repo", [{ name: "remote.ts", dir: false }]);
  h.files.refresh(h.cx);
  assert.equal(h.files.entries.has(""), false);
  await h.drain();
  assert.equal(h.files.entries.get("")[0].name, "remote.ts");
  h.state.on = null;
  h.state.directories.set("/repo", [{ name: "local.ts", dir: false }]);
  h.files.refresh(h.cx);
  assert.equal(h.files.entries.get("")[0].name, "local.ts");
  await h.drain();
});

test("Files evicts old context snapshots after twenty entries", async () => {
  const h = await harness(true);
  h.state.directories.set("/repo", [{ name: "original.ts", dir: false }]);
  h.files.refresh(h.cx);
  await h.drain();
  for (let i = 0; i < 21; i++) {
    h.state.cwd = `/repo-${i}`;
    h.files.refresh(h.cx);
    await h.drain();
  }
  assert.equal(h.files.kept.size, 20);
  h.state.cwd = "/repo";
  h.files.refresh(h.cx);
  assert.equal(h.files.entries.has(""), false);
  await h.drain();
});

test("Files revisits the oldest snapshot when saving the outgoing place fills the cache", async () => {
  const h = await harness(true);
  h.state.directories.set("/repo", [{ name: "original.ts", dir: false }]);
  h.files.refresh(h.cx);
  await h.drain();
  for (let i = 0; i < 20; i++) {
    h.state.cwd = `/repo-${i}`;
    h.files.refresh(h.cx);
    await h.drain();
  }
  assert.equal(h.files.kept.size, 20);
  h.state.cwd = "/repo";
  h.files.refresh(h.cx);
  assert.equal(h.files.entries.get("")[0].name, "original.ts");
  assert.equal(h.files.kept.size, 20);
  await h.drain();
});

const fileEntries = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ name: `file-${i}`, dir: false }));
const countedEntries = (files) =>
  [...files.entries.values()].reduce((total, entries) => total + entries.length, 0);

test("Files entry budget stays exact across apply, replace, shrink, and global truncation", async () => {
  const h = await harness(true);
  const apply = (path, entries) => {
    h.files.applyFolder(path, entries, h.files.context, h.files.generation);
    assert.equal(h.files.entryCount, countedEntries(h.files));
  };
  apply(
    "",
    ["src", "tests", ...Array.from({ length: 9 }, (_, i) => `filler-${i}`)].map((name) => ({
      name,
      dir: true,
    })),
  );
  for (let i = 0; i < 9; i++) {
    const folder = `filler-${i}`;
    h.files.folders.add(folder);
    apply(folder, fileEntries(500));
  }
  h.files.folders.add("src");
  h.files.folders.add("tests");
  apply("src", fileEntries(300));
  apply("tests", fileEntries(300));
  assert.equal(h.files.entries.get("tests").length, 189);
  assert.equal(h.files.entryCount, 5000);
  apply("src", fileEntries(100));
  assert.equal(h.files.entryCount, 4800);
  apply("tests", fileEntries(700));
  assert.equal(h.files.entries.get("tests").length, 389);
  assert.equal(h.files.entryCount, 5000);
  const previous = h.files.entries.get("src");
  apply("src", fileEntries(100));
  assert.equal(h.files.entries.get("src"), previous);
});

test("Files nested closure subtracts each cached folder once and retains the per-folder cap", async () => {
  const h = await harness(true);
  h.files.applyFolder("", [{ name: "src", dir: true }], h.files.context, h.files.generation);
  h.files.folders.add("src");
  h.files.applyFolder("src", [{ name: "deep", dir: true }], h.files.context, h.files.generation);
  h.files.folders.add("src/deep");
  h.files.applyFolder("src/deep", fileEntries(700), h.files.context, h.files.generation);
  assert.equal(h.files.entries.get("src/deep").length, 500);
  assert.equal(h.files.entryCount, 502);
  h.files.closeFolder("src");
  assert.equal(h.files.entryCount, 1);
  assert.equal(h.files.entryCount, countedEntries(h.files));
  h.files.closeFolder("src");
  assert.equal(h.files.entryCount, 1);
});

test("applying Files directory results does not rescan Map entries for its budget", async () => {
  const h = await harness(true);
  const entries = h.files.entries;
  let scans = 0;
  entries.entries = () => {
    scans++;
    return Map.prototype.entries.call(entries);
  };
  h.files.applyFolder("", [{ name: "src", dir: true }], h.files.context, h.files.generation);
  h.files.folders.add("src");
  h.files.applyFolder("src", fileEntries(100), h.files.context, h.files.generation);
  h.files.applyFolder("src", fileEntries(200), h.files.context, h.files.generation);
  assert.equal(scans, 0);
  assert.equal(h.files.entryCount, 201);
});

function findNode(node, matches) {
  if (node?.styles?.some(matches)) return node;
  return (node?.childNodes ?? []).map((child) => findNode(child, matches)).find(Boolean);
}
const byId =
  (id) =>
  ([key, value]) =>
    key === "id" && value === id;
const textOf = (node) =>
  typeof node === "string" ? node : (node?.childNodes ?? []).map(textOf).join("");

test("a clicked file previews below the tree as code, with Fresh behind the pen", async () => {
  const h = await harness();
  h.state.texts["/repo/src/main.ts"] = "const a = 1;\n";
  assert.equal(findNode(h.render(), byId("files-fresh")), undefined);
  h.files.show("src/main.ts", h.cx);
  await h.drain();
  const [code] = h.state.editors;
  assert.equal(code.options.language, "js");
  assert.equal(code.options.value, "const a = 1;\n");
  assert.equal(code.options.readonly, true);
  const tree = h.render();
  assert.ok(textOf(tree).includes("src/main.ts"));
  findNode(tree, byId("files-fresh")).handlers.on_click({}, h.cx);
  assert.deepEqual(h.state.calls, [["fresh", "src/main.ts"]]);
  findNode(tree, byId("files-close")).handlers.on_click({}, h.cx);
  assert.equal(h.files.file, null);
  assert.equal(code.released, true);
});

test("a changed file reloads its preview, and unchanged text keeps the view", async () => {
  const h = await harness();
  h.state.texts["/repo/a.ts"] = "one";
  h.files.show("a.ts", h.cx);
  await h.drain();
  const first = h.files.code;
  h.files.show("a.ts", h.cx);
  await h.drain();
  assert.equal(h.files.code, first);
  h.state.texts["/repo/a.ts"] = "two";
  h.files.show("a.ts", h.cx);
  await h.drain();
  assert.equal(first.released, true);
  assert.equal(h.files.code.options.value, "two");
});

test("markdown renders by default and switches to its source", async () => {
  const h = await harness();
  h.state.texts["/repo/README.md"] = "# Title\n";
  h.files.show("README.md", h.cx);
  await h.drain();
  assert.equal(h.files.code, null);
  let tree = h.render();
  const rendered = (node) =>
    typeof node === "object" && "markdown" in node
      ? node.markdown
      : (node?.childNodes ?? []).map(rendered).find((value) => value !== undefined);
  assert.equal(rendered(tree), "# Title\n");
  const source = findNode(tree, byId("files-source"));
  assert.equal(textOf(source), "Source");
  source.handlers.on_click({}, h.cx);
  assert.equal(h.files.code.options.language, "markdown");
  tree = h.render();
  assert.equal(rendered(tree), undefined);
  assert.equal(textOf(findNode(tree, byId("files-source"))), "Rendered");
  findNode(tree, byId("files-source")).handlers.on_click({}, h.cx);
  assert.equal(h.files.code, null);
});

test("binary files explain themselves, and images show without reading text", async () => {
  const h = await harness();
  h.state.texts["/repo/app.bin"] = "a\0b";
  h.files.show("app.bin", h.cx);
  await h.drain();
  assert.ok(textOf(h.render()).includes("Binary file · no text preview"));
  h.files.show("logo.png", h.cx);
  await h.drain();
  const source = (node) =>
    typeof node === "object" && "src" in node
      ? node.src
      : (node?.childNodes ?? []).map(source).find((value) => value !== undefined);
  assert.equal(source(h.render()), "/repo/logo.png");
  h.files.on = "server";
  assert.ok(textOf(h.render()).includes("Images on another machine cannot be previewed"));
});

async function menuHarness() {
  const h = await harness();
  h.files.entries.set("", [
    { name: "src", dir: true },
    { name: "a.ts", dir: false },
  ]);
  h.files.entries.set("src", [{ name: "main.ts", dir: false }]);
  h.files.folders.add("src");
  h.files.refresh = (_cx, paths) => h.state.calls.push(["refresh", paths]);
  const press = (path, x = 40, y = 30, width = 300, height = 600) => {
    const tree = h.render();
    h.state.lists.at(-1).node.handlers.on_item_secondary_click(path, {}, h.cx);
    findNode(tree, byId("files")).handlers["on_mouse_down:right"](
      { button: "right", local_position: { x, y }, bounds: { x: 0, y: 0, width, height } },
      h.cx,
    );
    return findNode(h.render(), byId("files-menu"));
  };
  const pick = (action) =>
    findNode(h.render(), byId(`files-menu-${action}`)).handlers.on_click({}, h.cx);
  return { h, press, pick };
}

test("a right-clicked row opens its menu where the press landed, kept inside the panel", async () => {
  const { h, press } = await menuHarness();
  const menu = press("a.ts", 40, 30);
  assert.ok(menu.styles.some(([key, value]) => key === "left" && value === 40 / 0.8));
  assert.ok(textOf(menu).includes("Open in Fresh"));
  assert.ok(textOf(press("src")).startsWith("Collapse"));
  const low = press("a.ts", 280, 590);
  const left = low.styles.find(([key]) => key === "left")[1],
    top = low.styles.find(([key]) => key === "top")[1];
  assert.ok(left + 210 <= 300 / 0.8 && top < 590 / 0.8);
  findNode(h.render(), byId("files-menu")).handlers.on_mouse_down_out({ button: "left" }, h.cx);
  assert.equal(h.files.menu, null);
});

test("the menu copies paths, previews, and opens Fresh", async () => {
  const { h, press, pick } = await menuHarness();
  press("src/main.ts");
  pick("copy");
  assert.equal(h.state.clipboard, "/repo/src/main.ts");
  press("src/main.ts");
  pick("copy-relative");
  assert.equal(h.state.clipboard, "src/main.ts");
  press("src/main.ts");
  pick("fresh");
  assert.deepEqual(h.state.calls, [["fresh", "src/main.ts"]]);
  h.state.texts["/repo/src/main.ts"] = "x";
  press("src/main.ts");
  pick("preview");
  assert.equal(h.files.file, "src/main.ts");
});

test("Move to Trash asks for a second click, then trashes and refreshes", async () => {
  const { h, press, pick } = await menuHarness();
  press("a.ts");
  pick("trash");
  assert.equal(h.state.commands.length, 0);
  assert.ok(textOf(h.render()).includes("Click again to move to Trash"));
  pick("trash");
  await h.drain();
  assert.deepEqual(h.state.commands.at(-1).slice(-2), ["/repo/a.ts", null]);
  assert.deepEqual(JSON.parse(JSON.stringify(h.state.calls.at(-1))), ["refresh", ["/repo/a.ts"]]);
  h.state.run = () => ({ code: 127, stdout: "", stderr: "" });
  press("src");
  pick("trash");
  pick("trash");
  await h.drain();
  assert.equal(h.state.notices[0].body, "This machine has no trash command.");
});

test("rename and new entries take their name in the tree and refuse clashes", async () => {
  const { h, press, pick } = await menuHarness();
  press("a.ts");
  pick("rename");
  assert.equal(h.files.nameInput.value(), "a.ts");
  assert.ok(h.files.withEdit(h.files.rows()).find((row) => row.path === "a.ts").editing);
  h.files.nameInput.set_value("src");
  h.files.applyEdit(h.cx);
  assert.equal(h.files.editError, "src already exists");
  h.files.nameInput.set_value("b.ts");
  h.files.applyEdit(h.cx);
  await h.drain();
  assert.deepEqual(h.state.commands.at(-1), ["mv", "-n", "/repo/a.ts", "/repo/b.ts", null]);
  assert.equal(h.files.editing, null);
  press("src");
  pick("new-file");
  const rows = h.files.withEdit(h.files.rows());
  const at = rows.findIndex((row) => row.editing);
  assert.equal(rows[at - 1].path, "src");
  assert.equal(rows[at].depth, 1);
  h.state.texts["/repo/src/new.ts"] = "";
  h.files.nameInput.set_value("new.ts");
  h.files.applyEdit(h.cx);
  await h.drain();
  assert.equal(h.state.commands.at(-1)[0], "sh");
  assert.equal(h.state.commands.at(-1).at(-2), "/repo/src/new.ts");
  assert.equal(h.files.file, "src/new.ts");
  press("a.ts");
  pick("new-folder");
  h.files.key("escape", h.cx);
  assert.equal(h.files.editing, null);
});

test("Open in shows the installed apps beside the menu and opens files as each app takes them", async () => {
  const { h, press } = await menuHarness();
  h.state.shared["frantss.apps"] = ["zed"];
  h.state.run = (command, args) =>
    command === "open" && args[0] === "-Ra"
      ? { code: args[1] === "Finder" || args[1] === "Zed" ? 0 : 1, stdout: "", stderr: "" }
      : undefined;
  press("src/main.ts");
  assert.deepEqual(
    Array.from(h.files.apps as { key: string }[], (app) => app.key),
    ["zed"],
  );
  await h.drain();
  assert.deepEqual(
    Array.from(h.files.apps as { key: string }[], (app) => app.key),
    ["finder", "zed"],
  );
  assert.deepEqual(JSON.parse(JSON.stringify(h.state.shared["frantss.apps"])), ["finder", "zed"]);
  const opener = findNode(h.render(), byId("files-menu-open-in"));
  assert.equal(findNode(h.render(), byId("files-menu-apps")), undefined);
  opener.handlers.on_hover(true, h.cx);
  const apps = findNode(h.render(), byId("files-menu-apps"));
  assert.ok(textOf(apps).includes("Finder") && textOf(apps).includes("Zed"));
  findNode(apps, byId("files-app-zed")).handlers.on_click({}, h.cx);
  assert.deepEqual(h.state.commands.at(-1), ["open", "-a", "Zed", "/repo/src/main.ts", null]);
  assert.equal(h.files.menu, null);
  press("src");
  findNode(h.render(), byId("files-menu-open-in")).handlers.on_click({}, h.cx);
  findNode(h.render(), byId("files-app-finder")).handlers.on_click({}, h.cx);
  assert.deepEqual(h.state.commands.at(-1), ["open", "-a", "Finder", "/repo/src", null]);
  press("a.ts");
  h.files.key("down", h.cx);
  for (let i = 0; i < 4; i++) h.files.key("down", h.cx);
  h.files.key("right", h.cx);
  assert.equal(h.files.menu.sub, true);
  h.files.key("enter", h.cx);
  assert.deepEqual(h.state.commands.at(-1), ["open", "-R", "/repo/a.ts", null]);
  const tree = h.render();
  findNode(tree, byId("files")).handlers["on_mouse_down:left"](
    {
      button: "left",
      local_position: { x: 250, y: 10 },
      bounds: { x: 0, y: 0, width: 300, height: 600 },
    },
    h.cx,
  );
  findNode(tree, byId("files-root")).handlers.on_click({}, h.cx);
  const header = findNode(h.render(), byId("files-menu"));
  assert.ok(textOf(header).startsWith("Open in"));
  findNode(header, byId("files-app-zed")).handlers.on_click({}, h.cx);
  assert.deepEqual(h.state.commands.at(-1), ["open", "-a", "Zed", "/repo", null]);
  h.files.on = "server";
  assert.equal(findNode(h.render(), byId("files-root")).handlers.on_click, undefined);
  assert.equal(findNode(press("a.ts"), byId("files-menu-open-in")), undefined);
});
