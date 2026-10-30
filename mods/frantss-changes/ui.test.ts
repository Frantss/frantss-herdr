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
    tasks: [],
    notifications: 0,
    status: " M file.ts\0",
    stats: "1\t2\tfile.ts\0",
    diff: "@@ -1 +1 @@\n-old\n+new\n",
    watches: [],
    queryStarts: [],
    queryBlocks: new Map(),
    layout: null,
    elements: 0,
    highlights: [],
    sent: [],
    hostReads: { spaces: 0, panes: 0, focused: 0, paneRecords: 0 },
  };
  const input = () => {
    let value = "";
    return {
      value: () => value,
      set_value(next) {
        value = next;
      },
      focus() {},
    };
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
    stop_propagation() {},
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
  const stored = new Map<string, string>();
  const context = vm.createContext({
    localStorage: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, value),
    },
  });
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
      v_resizable: element,
      Button: { new: (id) => element().id(id) },
      resizable_panel: element,
      Scrollbar: { vertical: element },
      InputState: {},
      Input: { new: element },
      TextareaState: {},
      Textarea: { new: element },
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
      [
        "spaces",
        () => {
          state.hostReads.spaces++;
          return state.spaces ?? [];
        },
      ],
      ["agents", () => state.agents ?? []],
      [
        "hc",
        async (args) => {
          state.sent.push(args);
          return state.hcResult ?? { code: 0, stdout: "", stderr: "" };
        },
      ],
      [
        "panes",
        () => {
          state.hostReads.panes++;
          state.hostReads.paneRecords += state.panes?.length ?? 0;
          return state.panes ?? [];
        },
      ],
      [
        "focused",
        () => {
          state.hostReads.focused++;
          return state.focus ?? { cwd: state.cwd, pane: null, space: "s1" };
        },
      ],
      ["props", () => null],
      ["layout", () => state.layout],
      ["window", () => ({ platform: "macos" })],
      ["settings", () => ({ zoom: state.zoom })],
      ["theme", () => palette],
    ]),
  };
  if (refresh) {
    natives.herdr.exec = async (command, args, options) => {
      if (command === "sh" && args[2] === "trash") {
        state.indexCalls = [...(state.indexCalls ?? []), ["trash", ...args.slice(3)]];
        return state.trashResult ?? { code: 0, stdout: "", stderr: "" };
      }
      if (command === "sh") {
        const side = args[1].startsWith("git show") ? "old" : "new";
        state.highlights.push([side, ...args.slice(3)]);
        if (state.batBlock) await state.batBlock;
        return state.bat?.[side] ?? { code: 0, stdout: "", stderr: "" };
      }
      const query = args.includes("status")
        ? "status"
        : args.includes("--numstat")
          ? args.includes("--cached")
            ? "cached"
            : "unstaged"
          : args.includes("--show-toplevel")
            ? "root"
            : "other";
      state.queryStarts.push(query);
      if (state.queryBlocks.has(query)) await state.queryBlocks.get(query);
      if (state.error) throw new Error(state.error);
      if (args.includes("--show-toplevel")) {
        if (state.block) await state.block;
        return { code: 0, stdout: `${options.cwd}\n${options.cwd}/.git\n`, stderr: "" };
      }
      if (args.includes("status"))
        return {
          code: 0,
          stdout: `## ${state.unborn ? "No commits yet on main" : "main"}\0${state.status}`,
          stderr: "",
        };
      if (args.includes("--numstat"))
        return {
          code: 0,
          stdout: args.includes("--cached") ? (state.cachedStats ?? "") : state.stats,
          stderr: "",
        };
      if (args.includes("diff"))
        return {
          code: 0,
          stdout: args.includes("--cached") ? (state.cachedDiff ?? state.diff) : state.diff,
          stderr: "",
        };
      if (args[0] === "show") return { code: 0, stdout: state.index ?? "", stderr: "" };
      if (args[0] === "log") return { code: 0, stdout: state.lastMessage ?? "", stderr: "" };
      if (["add", "reset", "restore", "commit"].includes(args[0])) {
        state.indexCalls = [...(state.indexCalls ?? []), args];
        return state.indexResult ?? { code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected Git args ${args}`);
    };
    natives.herdr.readTextFile = async () => state.untracked ?? "first\nsecond\n";
    natives.herdr.watchFolder = () => state.watches.shift();
  }
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
    plainRows: [],
    fileLines: null,
    oldSpans: [],
    newSpans: [],
    expanded: new Set(),
    diffWidth: 0,
    message: "",
    root: "/repo",
    on: null,
    hasHead: true,
    closed: false,
    error: null,
    limited: false,
    open: null,
    kept: new Map(),
    commentInput: input(),
    noteInput: input(),
    commitInput: input(),
    commitMessage: "",
    amending: false,
    commitDraft: "",
    acting: null,
    comments: [],
    reviewNote: "",
    target: null,
    agentAddress: null,
    choosingAgent: false,
    tree: false,
    collapsed: new Set(),
    handle: { focus() {} },
    context: JSON.stringify({ cwd: "/repo", on: null }),
  });
  const watch = changes.watch.bind(changes);
  if (refresh) changes.watch = () => {};
  else changes.pick = (path) => state.calls.push(["pick", path]);
  return {
    changes,
    state,
    cx,
    drain,
    watch,
    render: () => changes.render(cx),
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

test("hidden Changes renders retain selection and skip list work without forcing a refresh", async () => {
  const h = await harness();
  const files = [file("kept.ts")];
  h.changes.files = files;
  h.changes.open = "kept.ts";
  h.changes.stale = false;
  h.changes.loading = true;
  h.changes.loadingRendered = false;
  h.state.layout = {
    children: [{ id: "panel", hidden: true, active: "changes" }],
  };
  h.render();
  assert.equal(h.state.elements, 1);
  assert.equal(h.state.lists.length, 0);
  assert.equal(h.changes.files, files);
  assert.equal(h.changes.open, "kept.ts");
  assert.equal(h.changes.stale, false);
  assert.equal(h.changes.loadingRendered, false);
  h.changes.loading = false;
  h.changes.refresh = () => assert.fail("A reveal forced an unnecessary refresh");
  h.state.layout.children[0].hidden = false;
  h.render();
  assert.ok(h.state.lists.some((list) => list.id === "changes-files"));
  h.state.layout.children[0].hidden = true;
  h.changes.stale = true;
  h.render();
  assert.equal(h.changes.stale, true);
  let refreshes = 0;
  h.changes.refresh = () => refreshes++;
  h.state.layout.children[0].hidden = false;
  h.render();
  h.render();
  assert.equal(refreshes, 1);
});

const file = (path: string, section = "unstaged") => ({
  section,
  path,
  status: "M",
  fresh: false,
  add: 1,
  del: 2,
});
// Where a list row's buttons start, from the list's right edge; presses count from there.
const BUTTONS_RIGHT = 88;
function byId(node, id) {
  if (node?.styles?.some(([key, value]) => key === "id" && value === id)) return node;
  return (node?.childNodes ?? []).map((child) => byId(child, id)).find(Boolean);
}
const disabled = (node) => node.styles.some(([key, value]) => key === "disabled" && value);
const text = (node) =>
  typeof node === "string" ? node : (node?.childNodes ?? []).map(text).join(" ");

test("Changes constructs only requested file rows and selects by stable path after reorder", async () => {
  const h = await harness();
  h.changes.files = Array.from({ length: 1000 }, (_, i) => file(`src/file-${i}.ts`));
  h.changes.open = "unstaged:src/file-300.ts";
  h.render();
  assert.equal(h.state.rows.length, 0);
  const list = h.state.lists.find((list) => list.id === "changes-files");
  assert.equal(list.count, 1001);
  assert.equal(list.extent, 26 * h.state.zoom);
  assert.equal(list.key(0), "unstaged:");
  assert.equal(list.key(301), "unstaged:src/file-300.ts");
  const rows = h.range(list, 301, 309);
  assert.equal(h.state.rows.length, 8);
  assert.ok(h.state.rows[0].styles.some(([key, value]) => key === "bg" && value === "#333333"));
  assert.ok(text(rows[0]).includes("src/ file-300.ts +1 −2"));
  h.changes.files.reverse();
  h.render();
  h.state.lists.at(-1).node.handlers.on_item_click("unstaged:src/file-300.ts", {});
  h.state.lists.at(-1).node.handlers.on_item_click("unstaged:", {});
  assert.deepEqual(h.state.calls, [["pick", "unstaged:src/file-300.ts"]]);
});

test("Changes shows files as a tree whose folders collapse on click", async () => {
  const h = await harness();
  h.changes.files = [file("src/lib/a.ts"), file("src/b.ts"), file("README.md")];
  const notify = () => {};
  h.changes.setTree(true, { notify });
  h.render();
  let list = h.state.lists.findLast((list) => list.id === "changes-files");
  assert.deepEqual(
    Array.from({ length: list.count }, (_, i) => list.key(i)),
    [
      "unstaged:",
      "unstaged:src/",
      "unstaged:src/lib/",
      "unstaged:src/lib/a.ts",
      "unstaged:src/b.ts",
      "unstaged:README.md",
    ],
  );
  assert.ok(text(h.range(list, 3, 4)[0]).includes("a.ts +1 −2"));
  assert.ok(!text(h.range(list, 3, 4)[0]).includes("src/"));
  assert.ok(text(h.range(list, 1, 2)[0]).includes("src +2 −4"));
  list.node.handlers.on_item_click("unstaged:src/lib/", { notify });
  h.render();
  list = h.state.lists.findLast((list) => list.id === "changes-files");
  assert.equal(list.count, 5);
  assert.deepEqual(h.state.calls, []);
});

test("Changes reuses header totals across renders of the same file list", async () => {
  const h = await harness();
  let additionsRead = 0,
    deletionsRead = 0;
  h.changes.files = Array.from({ length: 1000 }, (_, i) => ({
    ...file(`file-${i}.ts`),
    get add() {
      additionsRead++;
      return 1;
    },
    get del() {
      deletionsRead++;
      return 2;
    },
  }));
  assert.ok(text(h.render()).includes("+1000 −2000"));
  assert.ok(text(h.render()).includes("+1000 −2000"));
  assert.equal(additionsRead, 1000);
  assert.equal(deletionsRead, 1000);
  h.changes.files = [file("replacement.ts")];
  assert.ok(text(h.render()).includes("+1 −2"));
});

test("Changes totals follow untracked count updates and restored places", async () => {
  const h = await harness(true);
  h.state.status = "?? file.txt\0";
  h.state.stats = "";
  h.changes.refresh(h.cx);
  await h.drain();
  const files = h.changes.files;
  assert.ok(text(h.render()).includes("+2 −0"));
  h.state.untracked = "one\ntwo\nthree\nfour\n";
  await h.changes.load("unstaged:file.txt", h.changes.context, h.cx);
  await h.drain();
  assert.equal(h.changes.files, files);
  assert.ok(text(h.render()).includes("+4 −0"));

  h.state.cwd = "/other";
  h.changes.switchTo(JSON.stringify({ cwd: "/other", on: null }));
  assert.ok(text(h.render()).includes("+0 −0"));
  h.state.cwd = "/repo";
  h.changes.switchTo(JSON.stringify({ cwd: "/repo", on: null }));
  assert.equal(h.changes.files, files);
  assert.ok(text(h.render()).includes("+4 −0"));
});

test("Changes starts the resizable file list at 200 and preserves empty and error messages", async () => {
  const h = await harness();
  const empty = h.render();
  assert.equal(h.state.lists.length, 0);
  assert.ok(text(empty).includes("No uncommitted changes"));
  h.changes.error = "Cannot read changes";
  assert.ok(text(h.render()).includes("Cannot read changes"));
  h.changes.files = Array.from({ length: 1000 }, (_, i) => file(`file-${i}.ts`));
  const tree = h.render();
  function find(node, matches) {
    if (node?.styles?.some(matches)) return node;
    return (node?.childNodes ?? []).map((child) => find(child, matches)).find(Boolean);
  }
  const panel = find(tree, ([key, value]) => key === "size" && value === 200);
  assert.ok(find(panel, ([key, value]) => key === "id" && value === "changes-list"));
});

const deferred = () => {
  let resolve, reject;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

test("unchanged Changes refreshes preserve file and diff arrays without notifying", async () => {
  const h = await harness(true);
  h.changes.refresh(h.cx);
  await h.drain();
  const files = h.changes.files,
    rows = h.changes.rows;
  h.state.notifications = 0;
  h.changes.refresh(h.cx);
  await h.drain();
  assert.equal(h.state.notifications, 0);
  assert.equal(h.changes.files, files);
  assert.equal(h.changes.rows, rows);
});

test("Changes reuses synchronous context snapshots while keeping async context guards", async () => {
  const h = await harness(true);
  h.state.panes = Array.from({ length: 1000 }, (_, i) => ({ pane: `p${i}`, cwd: "/repo" }));
  h.state.focus = { cwd: "/repo", pane: "p999", space: "s1" };
  h.changes.refresh(h.cx);
  await h.drain();
  assert.equal(h.changes.root, "/repo");
  assert.equal(h.changes.files[0].path, "file.ts");
  assert.deepEqual(h.state.hostReads, { spaces: 6, panes: 6, focused: 6, paneRecords: 6000 });

  const previousFiles = h.changes.files,
    heldStatus = deferred(),
    heldRoot = deferred();
  h.state.queryBlocks.set("status", heldStatus.promise);
  h.changes.refresh(h.cx);
  await ticks();
  h.state.status = " M other.ts\0";
  h.state.stats = "3\t4\tother.ts\0";
  h.state.focus = { cwd: "/other", pane: null, space: "s1" };
  h.state.block = heldRoot.promise;
  heldStatus.resolve();
  await ticks();
  assert.equal(h.changes.context, JSON.stringify({ cwd: "/other", on: null }));
  assert.equal(h.changes.root, null);
  assert.notEqual(h.changes.files, previousFiles);
  assert.equal(h.changes.files.length, 0);
  heldRoot.resolve();
  await h.drain();
  assert.equal(h.changes.root, "/other");
  assert.equal(h.changes.files[0].path, "other.ts");
});

test("Changes notifies on diff changes, errors, and recovery", async () => {
  const h = await harness(true);
  h.changes.refresh(h.cx);
  await h.drain();
  h.state.notifications = 0;
  h.state.diff = "@@ -1 +1 @@\n-old\n+changed\n";
  h.changes.refresh(h.cx);
  await h.drain();
  assert.equal(h.state.notifications, 1);
  h.state.error = "Cannot read Git";
  h.changes.refresh(h.cx);
  await h.drain();
  assert.equal(h.state.notifications, 2);
  h.changes.refresh(h.cx);
  await h.drain();
  assert.equal(h.state.notifications, 2);
  h.state.error = null;
  h.changes.refresh(h.cx);
  await h.drain();
  assert.equal(h.state.notifications, 3);
});

test("Changes notifies after a render during loading", async () => {
  const h = await harness(true);
  h.changes.refresh(h.cx);
  await h.drain();
  h.state.notifications = 0;
  const held = deferred();
  h.state.block = held.promise;
  h.changes.refresh(h.cx);
  h.render();
  assert.equal(h.changes.loadingRendered, true);
  held.resolve();
  await h.drain();
  assert.equal(h.changes.loading, false);
  assert.equal(h.state.notifications, 1);
});

test("Changes looks up a place's repository once and polls only what the watcher cannot see", async () => {
  const h = await harness(true);
  h.changes.refresh(h.cx);
  await h.drain();
  h.changes.watched = "/repo";
  h.changes.refresh(h.cx);
  await h.drain();
  assert.equal(h.state.queryStarts.filter((query) => query === "root").length, 1);
  const before = h.state.queryStarts.length;
  h.changes.poll(h.cx);
  await h.drain();
  assert.equal(h.state.queryStarts.length, before);
  h.changes.gitDir = "/main/.git/worktrees/repo";
  h.changes.poll(h.cx);
  await h.drain();
  assert.ok(h.state.queryStarts.length > before);
});

test("an old Changes watcher rejection cannot clear a newer watcher for the same root", async () => {
  const h = await harness(true);
  const old = deferred(),
    other = deferred(),
    current = deferred();
  h.state.watches.push(old.promise, other.promise, current.promise);
  h.watch("/repo", h.cx);
  await Promise.resolve();
  const oldTask = h.state.tasks[0];
  h.watch("/other", h.cx);
  await Promise.resolve();
  h.watch("/repo", h.cx);
  await Promise.resolve();
  old.reject(new Error("Old watcher stopped"));
  await oldTask;
  assert.equal(h.changes.watched, "/repo");
  h.changes.watched = null;
  other.resolve();
  current.resolve();
  await h.drain();
});

test("unchanged untracked previews retain their computed counts and references", async () => {
  const h = await harness(true);
  h.state.status = "?? file.txt\0";
  h.state.stats = "";
  h.changes.refresh(h.cx);
  await h.drain();
  const files = h.changes.files,
    rows = h.changes.rows;
  assert.equal(files[0].add, 2);
  h.state.notifications = 0;
  h.changes.refresh(h.cx);
  await h.drain();
  assert.equal(h.state.notifications, 0);
  assert.equal(h.changes.files, files);
  assert.equal(h.changes.rows, rows);
  assert.equal(h.changes.open, "unstaged:file.txt");
});

test("a render that starts a Changes refresh records its displayed loading state", async () => {
  const h = await harness(true);
  h.state.cwd = "/other";
  const held = deferred();
  h.state.block = held.promise;
  h.render();
  assert.equal(h.changes.loadingRendered, true);
  held.resolve();
  await h.drain();
  assert.equal(h.changes.loading, false);
  assert.ok(h.state.notifications > 0);
});

const ticks = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

test("Changes overlaps status and section statistics after resolving the repository root", async () => {
  const h = await harness(true);
  const status = deferred();
  h.state.queryBlocks.set("status", status.promise);
  h.changes.refresh(h.cx);
  await ticks();
  const started = h.state.queryStarts.slice();
  status.resolve();
  await h.drain();
  assert.deepEqual(started, ["root", "status", "cached", "unstaged"]);
});

test("a partly staged file shows in both sections with each section's counts", async () => {
  const h = await harness(true);
  h.state.status = "MM file.ts\0";
  h.state.cachedStats = "2\t3\tfile.ts\0";
  h.state.stats = "5\t7\tfile.ts\0";
  h.changes.refresh(h.cx);
  await h.drain();
  assert.deepEqual(
    plain(h.changes.files).map(({ section, add, del }) => [section, add, del]),
    [
      ["staged", 2, 3],
      ["unstaged", 5, 7],
    ],
  );
  const header = text(h.render());
  assert.ok(header.includes("1 files") && header.includes("+7 −10"));
  const list = h.state.lists.findLast((list) => list.id === "changes-files");
  assert.deepEqual(
    Array.from({ length: list.count }, (_, i) => list.key(i)),
    ["staged:", "staged:file.ts", "unstaged:", "unstaged:file.ts"],
  );
  assert.ok(text(h.range(list, 0, 1)[0]).includes("Staged Changes"));
});

test("a press on a row's right end stages or unstages what the row holds", async () => {
  const h = await harness(true);
  h.state.status = "M  src/a.ts\0 M src/b.ts\0";
  h.changes.refresh(h.cx);
  await h.drain();
  h.changes.setTree(true, h.cx);
  h.render();
  const list = h.state.lists.findLast((list) => list.id === "changes-files"),
    press = (right: number, key: string) => {
      list.node.handlers.on_mouse_down({
        local_position: { x: 300 - (BUTTONS_RIGHT + right) * h.state.zoom, y: 0 },
        bounds: { width: 300, height: 400 },
      });
      list.node.handlers.on_item_click(key, h.cx);
    };
  press(10, "staged:src/a.ts");
  await h.drain();
  press(10, "unstaged:src/");
  await h.drain();
  press(10, "unstaged:");
  await h.drain();
  press(10, "staged:");
  await h.drain();
  assert.deepEqual(plain(h.state.indexCalls), [
    ["reset", "-q", "--", "src/a.ts"],
    ["add", "-A", "--", "src"],
    ["add", "-A", "--", "."],
    ["reset", "-q", "--", "."],
  ]);
  press(100, "unstaged:src/b.ts");
  assert.equal(h.changes.open, "unstaged:src/b.ts");
  press(-20, "unstaged:src/a.ts");
  assert.equal(h.changes.open, "unstaged:src/a.ts");
  assert.equal(h.state.indexCalls.length, 4);
});

test("the shown file follows a stage into its new section, and Git's errors show", async () => {
  const h = await harness(true);
  h.changes.refresh(h.cx);
  await h.drain();
  assert.equal(h.changes.open, "unstaged:file.ts");
  h.state.status = "M  file.ts\0";
  h.changes.run([["git", ["add", "-A", "--", "file.ts"]]], h.cx);
  await h.drain();
  assert.equal(h.changes.open, "staged:file.ts");
  assert.equal(h.changes.acting, null);
  h.state.indexResult = { code: 128, stdout: "", stderr: "fatal: index.lock exists" };
  h.changes.run([["git", ["reset", "-q", "--", "file.ts"]]], h.cx);
  await h.drain();
  assert.ok(String(h.changes.note).includes("index.lock exists"));
});

test("a stage asked for while a refresh runs shows once that refresh ends", async () => {
  const h = await harness(true);
  h.changes.refresh(h.cx);
  await h.drain();
  const held = deferred();
  h.state.queryBlocks.set("status", held.promise);
  h.changes.refresh(h.cx);
  await ticks();
  h.state.queryBlocks.delete("status");
  h.state.status = "M  file.ts\0";
  h.changes.refresh(h.cx);
  held.resolve();
  await h.drain();
  assert.equal(h.changes.files[0].section, "staged");
});

test("a staged diff runs from HEAD to the index and colors both from Git", async () => {
  const h = await harness(true);
  h.state.status = "M  file.ts\0";
  h.state.cachedStats = "1\t1\tfile.ts\0";
  h.state.cachedDiff = "@@ -1 +1 @@\n-old\n+staged\n";
  h.state.index = "staged\n";
  h.changes.refresh(h.cx);
  await h.drain();
  assert.deepEqual(plain(h.changes.rows.map((row) => row.text)), ["@@ -1 +1 @@", "old", "staged"]);
  assert.deepEqual(plain(h.changes.fileLines), ["staged"]);
  assert.deepEqual(h.state.highlights, [
    ["old", "file.ts", "HEAD:"],
    ["old", "file.ts", ":"],
  ]);
  h.state.highlights = [];
  h.state.unborn = true;
  h.changes.setLines([]);
  h.changes.refresh(h.cx);
  await h.drain();
  assert.deepEqual(h.state.highlights, [["old", "file.ts", ":"]]);
});

test("discard asks for a second press, then trashes untracked files and restores tracked ones", async () => {
  const h = await harness(true);
  h.state.status = "MM src/a.ts\0?? src/new.ts\0UU src/conflict.ts\0 M top.ts\0";
  h.changes.refresh(h.cx);
  await h.drain();
  h.changes.setTree(true, h.cx);
  h.render();
  const list = () => h.state.lists.findLast((list) => list.id === "changes-files"),
    press = (right: number, key: string, count = 1) => {
      list().node.handlers.on_mouse_down({
        local_position: { x: 300 - (BUTTONS_RIGHT + right) * h.state.zoom, y: 0 },
        bounds: { width: 300, height: 400 },
        click_count: count,
      });
      list().node.handlers.on_item_click(key, h.cx);
    },
    rowText = (key: string) => {
      h.render();
      const at = Array.from({ length: list().count }, (_, i) => list().key(i)).indexOf(key);
      return text(h.range(list(), at, at + 1)[0]);
    };
  press(40, "staged:src/a.ts");
  assert.equal(h.changes.armed, null);
  press(40, "unstaged:src/conflict.ts");
  assert.equal(h.changes.armed, null);
  press(40, "unstaged:src/");
  assert.equal(h.changes.armed, "unstaged:src/");
  assert.ok(rowText("unstaged:src/").includes("Discard?"));
  press(40, "unstaged:src/", 2);
  assert.equal(h.changes.armed, null);
  press(40, "unstaged:src/");
  press(100, "unstaged:top.ts");
  assert.equal(h.changes.armed, null);
  assert.equal(h.state.indexCalls, undefined);
  press(40, "unstaged:src/");
  press(60, "unstaged:src/");
  await h.drain();
  assert.deepEqual(plain(h.state.indexCalls), [
    ["trash", "/repo/src/new.ts"],
    ["restore", "--worktree", "--", "src/a.ts"],
  ]);
  press(40, "unstaged:");
  assert.ok(rowText("unstaged:").includes("Discard all?"));
});

test("an armed discard shows its confirm beside the row's counts", async () => {
  const h = await harness();
  h.changes.files = [file("a.ts")];
  h.render();
  const row = () =>
    text(
      h.range(
        h.state.lists.findLast((list) => list.id === "changes-files"),
        1,
        2,
      )[0],
    );
  assert.ok(row().includes("+1 −2") && !row().includes("Discard?"));
  h.changes.armed = "unstaged:a.ts";
  h.render();
  assert.ok(row().includes("+1 −2") && row().includes("Discard?"));
});

test("a place without a trash command discards nothing", async () => {
  const h = await harness(true);
  h.state.status = "?? new.ts\0 M file.ts\0";
  h.changes.refresh(h.cx);
  await h.drain();
  h.state.trashResult = { code: 127, stdout: "", stderr: "" };
  h.changes.discard(h.changes.files, h.cx);
  await h.drain();
  assert.deepEqual(plain(h.state.indexCalls), [["trash", "/repo/new.ts"]]);
  assert.ok(String(h.changes.note).includes("no trash command, so nothing was discarded"));
});

test("an armed discard disarms when the files change or the place does", async () => {
  const h = await harness(true);
  h.changes.refresh(h.cx);
  await h.drain();
  h.changes.armed = "unstaged:file.ts";
  h.state.status = " M file.ts\0 M other.ts\0";
  h.changes.refresh(h.cx);
  await h.drain();
  assert.equal(h.changes.armed, null);
  h.changes.armed = "unstaged:file.ts";
  h.changes.switchTo(JSON.stringify({ cwd: "/other", on: null }));
  assert.equal(h.changes.armed, null);
});

test("Commit commits the staged files, or stages and commits every change when none are", async () => {
  const h = await harness(true);
  h.state.status = "M  staged.ts\0 M edited.ts\0";
  h.changes.refresh(h.cx);
  await h.drain();
  const commitButton = () => byId(h.render(), "commit");
  assert.ok(disabled(commitButton()));
  h.changes.commitMessage = "feat: one\n";
  assert.ok(text(commitButton()).includes("Commit") && !text(commitButton()).includes("all"));
  commitButton().handlers.on_click({}, h.cx);
  await h.drain();
  assert.deepEqual(plain(h.state.indexCalls), [["commit", "--cleanup=strip", "-m", "feat: one\n"]]);
  assert.equal(h.changes.commitMessage, "");
  assert.equal(h.changes.commitInput.value(), "");

  h.state.indexCalls = [];
  h.state.status = " M edited.ts\0?? new.ts\0";
  h.changes.refresh(h.cx);
  await h.drain();
  h.changes.commitMessage = "feat: two";
  assert.ok(text(commitButton()).includes("Commit all"));
  h.changes.commitInput.set_value("feat: two");
  h.changes.commit(h.cx);
  await h.drain();
  assert.deepEqual(plain(h.state.indexCalls), [
    ["add", "-A"],
    ["commit", "--cleanup=strip", "-m", "feat: two"],
  ]);
});

test("a failed commit keeps its message and shows Git's error", async () => {
  const h = await harness(true);
  h.state.status = "M  staged.ts\0";
  h.changes.refresh(h.cx);
  await h.drain();
  h.changes.commitMessage = "wip";
  h.state.indexResult = { code: 1, stdout: "", stderr: "pre-commit: lint failed" };
  h.changes.commit(h.cx);
  assert.equal(h.changes.acting, "commit");
  assert.ok(text(byId(h.render(), "commit")).includes("Committing…"));
  await h.drain();
  assert.equal(h.changes.commitMessage, "wip");
  assert.ok(String(h.changes.note).includes("pre-commit: lint failed"));
});

test("Amend edits the last commit's message and gives the draft back when turned off", async () => {
  const h = await harness(true);
  h.changes.refresh(h.cx);
  await h.drain();
  h.state.lastMessage = "feat: last\n\nBody.\n";
  h.changes.commitMessage = "draft";
  h.changes.setAmending(true, h.cx);
  await h.drain();
  assert.equal(h.changes.commitMessage, "feat: last\n\nBody.");
  assert.ok(text(byId(h.render(), "commit")).includes("Amend"));
  h.changes.setAmending(false, h.cx);
  assert.equal(h.changes.commitMessage, "draft");
  assert.equal(h.changes.commitInput.value(), "draft");

  h.state.status = "";
  h.changes.refresh(h.cx);
  await h.drain();
  h.changes.setAmending(true, h.cx);
  await h.drain();
  h.changes.commit(h.cx);
  await h.drain();
  assert.deepEqual(plain(h.state.indexCalls), [
    ["commit", "--cleanup=strip", "--amend", "-m", "feat: last\n\nBody."],
  ]);
  assert.equal(h.changes.amending, false);
});

test("Commit waits for a message and changes, and Amend for a first commit", async () => {
  const h = await harness(true);
  h.state.status = "";
  h.state.unborn = true;
  h.changes.refresh(h.cx);
  await h.drain();
  h.changes.commitMessage = "feat: one";
  assert.equal(h.changes.canCommit(), false);
  assert.ok(disabled(byId(h.render(), "commit-amend")));
  h.changes.amending = true;
  assert.equal(h.changes.canCommit(), false);
});

test("each place keeps its own commit draft", async () => {
  const h = await harness(true);
  h.changes.refresh(h.cx);
  await h.drain();
  h.changes.commitMessage = "for repo";
  h.changes.switchTo(JSON.stringify({ cwd: "/other", on: null }));
  assert.equal(h.changes.commitMessage, "");
  assert.equal(h.changes.commitInput.value(), "");
  h.changes.switchTo(JSON.stringify({ cwd: "/repo", on: null }));
  assert.equal(h.changes.commitMessage, "for repo");
  assert.equal(h.changes.commitInput.value(), "for repo");
});

// Values built inside the module's VM realm compare by structure once copied here.
const plain = (value) => JSON.parse(JSON.stringify(value));
const colored = (word: string) => ({ code: 0, stdout: `\x1b[35m${word}\x1b[0m\n`, stderr: "" });

test("Changes shows plain diff rows first and colors them once from bat", async () => {
  const h = await harness(true);
  h.state.bat = { old: colored("old"), new: colored("new") };
  h.state.untracked = "new\n";
  const block = deferred();
  h.state.batBlock = block.promise;
  h.changes.refresh(h.cx);
  await new Promise((done) => setTimeout(done));
  assert.equal(h.changes.rows.length, 3);
  assert.ok(h.changes.rows.every((row) => row.spans === undefined));
  assert.deepEqual(h.state.highlights, [
    ["old", "file.ts", ":"],
    ["new", "file.ts"],
  ]);
  h.state.notifications = 0;
  block.resolve();
  await h.drain();
  assert.equal(h.state.notifications, 1);
  assert.deepEqual(plain(h.changes.rows[1].spans), [{ text: "old", color: 5 }]);
  assert.deepEqual(plain(h.changes.rows[2].spans), [{ text: "new", color: 5 }]);
  const rows = h.changes.rows;
  h.changes.refresh(h.cx);
  await h.drain();
  assert.equal(h.changes.rows, rows);
  assert.equal(h.state.highlights.length, 2);
});

test("Changes keeps plain rows and notes once when bat is missing", async () => {
  const h = await harness(true);
  h.state.bat = { old: { code: 127, stdout: "", stderr: "bat: not found" } };
  h.changes.refresh(h.cx);
  await h.drain();
  assert.equal(h.changes.note, "Install bat for syntax colors");
  assert.ok(h.changes.rows.every((row) => row.spans === undefined));
});

test("Changes drops colors that arrive after the shown file changed", async () => {
  const h = await harness(true);
  h.state.bat = { new: colored("new") };
  const block = deferred();
  h.state.batBlock = block.promise;
  h.changes.refresh(h.cx);
  await new Promise((done) => setTimeout(done));
  h.changes.open = null;
  block.resolve();
  await h.drain();
  assert.ok(h.changes.rows.every((row) => row.spans === undefined));
});

test("Changes colors only the new side of untracked files and skips binary ones", async () => {
  const h = await harness(true);
  h.state.status = "?? file.txt\0";
  h.changes.refresh(h.cx);
  await h.drain();
  assert.deepEqual(h.state.highlights, [["new", "file.txt"]]);
  const binary = await harness(true);
  binary.state.untracked = "a\0b";
  binary.state.status = "?? file.bin\0";
  binary.changes.refresh(binary.cx);
  await binary.drain();
  assert.deepEqual(binary.state.highlights, []);
});

test("colored diff rows draw one theme-colored element per span", async () => {
  const h = await harness();
  const row = h.changes.diffRow(
    { kind: "+", number: 1, text: "let a", spans: [{ text: "let", color: 2 }, { text: " a" }] },
    0,
    { ansi2: "#00ff00", dim: "#555555" },
  );
  const cell = row.childNodes.at(-1);
  assert.deepEqual(
    cell.childNodes.map((span) => [
      span.childNodes[0],
      span.styles.find(([k]) => k === "text_color")?.[1],
    ]),
    [
      ["let", "#00ff00"],
      [" a", undefined],
    ],
  );
});

test("Changes lays diff rows out at their zoomed height", async () => {
  const h = await harness(true);
  h.changes.refresh(h.cx);
  await h.drain();
  h.render();
  const list = h.state.lists.find((list) => list.id === "changes-diff");
  assert.equal(list.extent, 20 * h.state.zoom);
});

test("clicking a gap shows its unchanged lines and keeps them through unchanged refreshes", async () => {
  const h = await harness(true);
  h.state.untracked = "a\nb\nc\nd\n";
  h.state.diff = "@@ -3 +3 @@\n-old\n+c\n";
  h.changes.refresh(h.cx);
  await h.drain();
  assert.equal(h.changes.rows[0].gap, 2);
  h.render();
  const list = h.state.lists.find((list) => list.id === "changes-diff");
  assert.ok(text(h.range(list, 0, 1)[0]).includes("↕ 2 unchanged lines · @@ -3 +3 @@"));
  h.state.notifications = 0;
  list.node.handlers.on_item_click("0", h.cx);
  assert.equal(h.state.notifications, 1);
  assert.deepEqual(plain(h.changes.rows.map((row) => [row.kind, row.number, row.text])), [
    [" ", 1, "a"],
    [" ", 2, "b"],
    ["-", 3, "old"],
    ["+", 3, "c"],
    ["@", 5, ""],
  ]);
  const rows = h.changes.rows;
  h.changes.refresh(h.cx);
  await h.drain();
  assert.equal(h.changes.rows, rows);
});

test("a hunk without new lines names the line after the one git gives", async () => {
  const h = await harness(true);
  h.state.untracked = "a\nb\n";
  h.state.diff = "@@ -2,2 +1,0 @@\n-x\n-y\n";
  h.changes.refresh(h.cx);
  await h.drain();
  assert.deepEqual(plain(h.changes.rows.map((row) => [row.kind, row.number, row.gap ?? null])), [
    ["@", 2, 1],
    ["-", 2, null],
    ["-", 3, null],
    ["@", 3, 1],
  ]);
});

async function reviewing() {
  const h = await harness(true);
  h.state.diff = "@@ -1 +1 @@\n-old\n+new\n";
  h.state.untracked = "new\n";
  h.changes.refresh(h.cx);
  await h.drain();
  h.render();
  const click = (index: number) =>
    h.state.lists
      .findLast((list) => list.id === "changes-diff")
      .node.handlers.on_item_click(String(index), h.cx);
  const comment = (index: number, value: string) => {
    click(index);
    h.changes.commentInput.set_value(value);
    h.changes.saveComment(h.cx);
    h.render();
  };
  return { h, click, comment };
}

test("comments collect under their lines until the review is sent", async () => {
  const { h, click, comment } = await reviewing();
  click(2);
  assert.deepEqual(plain(h.changes.target), {
    section: "unstaged",
    path: "file.ts",
    side: "new",
    number: 1,
    quote: "new",
    index: null,
  });
  assert.deepEqual(plain(h.changes.rows.map((row) => row.kind)), ["@", "-", "+", "compose"]);
  h.render();
  const list = h.state.lists.findLast((list) => list.id === "changes-diff");
  assert.deepEqual(
    plain(list.extent),
    [20, 20, 20, 48].map((size) => size * h.state.zoom),
  );
  h.changes.pressX = 10;
  click(3);
  assert.equal(h.changes.target.index, null);
  h.changes.commentInput.set_value("  Rename it. ");
  h.changes.saveComment(h.cx);
  assert.equal(h.changes.target, null);
  comment(1, "Why remove?");
  assert.deepEqual(plain(h.changes.rows.map((row) => [row.kind, row.text, row.comment ?? null])), [
    ["@", "@@ -1 +1 @@", null],
    ["-", "old", null],
    ["#", "Why remove?", 1],
    ["+", "new", null],
    ["#", "Rename it.", 0],
  ]);
  const tree = text(h.render());
  assert.ok(tree.includes("2 comments"));
  assert.ok(tree.includes("No agent here"));
  assert.equal(h.state.sent.length, 0);
});

test("clicking a comment edits it, and emptying it removes it", async () => {
  const { h, click, comment } = await reviewing();
  comment(2, "First");
  click(3);
  assert.equal(h.changes.target.index, 0);
  assert.equal(h.changes.commentInput.value(), "First");
  h.changes.commentInput.set_value("Second");
  h.changes.saveComment(h.cx);
  assert.equal(h.changes.comments[0].text, "Second");
  click(3);
  h.changes.pressX = 200;
  click(3);
  assert.equal(h.changes.comments.length, 1);
  h.changes.pressX = 10;
  click(3);
  assert.equal(h.changes.comments.length, 0);
  assert.equal(h.changes.target, null);
  assert.ok(h.changes.rows.every((row) => row.kind !== "#"));
});

test("sending gives the agent one quoted message with the note and clears the review", async () => {
  const { h, comment } = await reviewing();
  h.state.agents = [
    { address: "t1", space: "s1", seq: 1, program: { name: "Codex" } },
    { address: "t2", space: "s1", seq: 4, program: { name: "Claude Code" } },
    { address: "t3", space: "s2", seq: 9, program: { name: "Pi" } },
  ];
  comment(2, "Rename it.");
  h.changes.noteInput.set_value("Close.");
  h.changes.reviewNote = "Close.";
  const bar = text(h.render());
  assert.ok(bar.includes("claude code") && bar.includes("Send 1"));
  h.state.hcResult = { code: 1, stdout: "", stderr: "terminal gone" };
  h.changes.sendReview(h.cx);
  await h.drain();
  assert.equal(h.changes.note, "Send failed: Error: terminal gone");
  assert.equal(h.changes.comments.length, 1);
  h.state.hcResult = null;
  h.changes.sendReview(h.cx);
  await h.drain();
  assert.deepEqual(plain(h.state.sent.at(-1)), [
    "send",
    "t2",
    "Review comments:\n\nfile.ts:1\n> new\nRename it.\n\nClose.",
  ]);
  assert.equal(h.changes.comments.length, 0);
  assert.equal(h.changes.noteInput.value(), "Address all comments above.");
  assert.equal(h.changes.reviewNote, "Address all comments above.");
  assert.ok(h.changes.rows.every((row) => row.kind !== "#"));
});

test("a comment whose line changed is kept as outdated", async () => {
  const { h, comment } = await reviewing();
  comment(2, "Rename it.");
  h.state.diff = "@@ -1 +1 @@\n-old\n+newer\n";
  h.state.untracked = "newer\n";
  h.changes.refresh(h.cx);
  await h.drain();
  assert.equal(h.changes.rows.at(-1).outdated, true);
  assert.ok(
    text(h.changes.diffRow(h.changes.rows.at(-1), 0, {})).includes(
      "Outdated · line 1 · Rename it.",
    ),
  );
});

test("commentable lines carry a hidden " + " that shows on hover", async () => {
  const h = await harness();
  const overlay = (row) => h.changes.diffRow(row, 7, { accent: "#0000ff" }).childNodes[0];
  const add = overlay({ kind: "+", number: 1, text: "a" });
  assert.ok(add.styles.some(([key, value]) => key === "id" && value === "diff-add-7"));
  assert.ok(add.styles.some(([key, value]) => key === "opacity" && value === 0));
  assert.ok(add.styles.some(([key]) => key === "hover"));
  assert.equal(text(add), "+");
  assert.notEqual(text(overlay({ kind: "", text: "\\ No newline at end of file" })), "+");
});

test("the agent menu names agents by tab, shows their icons, and sends to the one picked", async () => {
  const { h, comment } = await reviewing();
  h.state.agents = [
    {
      address: "t1",
      space: "s1",
      tab: "tb1",
      seq: 1,
      program: { name: "Codex", icon: "icons/codex.svg", tint: false },
      title: "✳ Fix flaky tests",
      status: "idle",
    },
    {
      address: "t2",
      space: "s2",
      tab: "tb2",
      space_name: "other",
      seq: 9,
      program: { name: "Pi", icon: "icons/pi.svg", tint: true },
      title: "pi",
      status: "working",
    },
  ];
  h.state.spaces = [
    { id: "s1", tabs: [{ id: "tb1", name: "1", named: false }] },
    { id: "s2", tabs: [{ id: "tb2", name: "docs", named: true }] },
  ];
  comment(2, "Rename it.");
  byId(h.render(), "review-agent").handlers.on_click({}, h.cx);
  const menu = byId(h.render(), "review-agents");
  const row = (address) => byId(menu, `review-agent-${address}`);
  assert.equal(text(row("t1")).trim(), "fix flaky tests idle");
  assert.equal(text(row("t2")).trim(), "docs other · working");
  assert.ok(
    row("t2").childNodes[0].styles.some(
      ([key, value]) => key === "text_color" && value === "#aaaaaa",
    ),
  );
  byId(menu, "review-agent-t2").handlers.on_click({}, h.cx);
  assert.equal(h.changes.choosingAgent, false);
  assert.ok(text(byId(h.render(), "review-agent")).includes("docs"));
  h.changes.sendReview(h.cx);
  await h.drain();
  assert.equal(h.state.sent.at(-1)[1], "t2");
  comment(2, "Again.");
  h.state.agents = h.state.agents.slice(0, 1);
  h.changes.sendReview(h.cx);
  await h.drain();
  assert.equal(h.state.sent.at(-1)[1], "t1");
});
