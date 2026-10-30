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
      ["focused", () => ({ cwd: state.cwd, pane: null })],
      ["layout", () => state.layout],
      ["window", () => ({ platform: "macos" })],
      ["settings", () => ({ zoom: state.zoom })],
      ["theme", () => palette],
    ]),
  };
  if (refresh) {
    natives.herdr.exec = async (_command, args, options) => {
      const query = args.includes("status")
        ? "status"
        : args.includes("--verify")
          ? "head"
          : args.includes("--numstat")
            ? args.includes("--cached")
              ? "cached"
              : "unstaged"
            : "other";
      state.queryStarts.push(query);
      if (state.queryBlocks.has(query)) await state.queryBlocks.get(query);
      if (args.includes("--show-toplevel")) {
        if (state.block) await state.block;
        if (state.error) throw new Error(state.error);
        return { code: 0, stdout: options.cwd, stderr: "" };
      }
      if (args.includes("status")) return { code: 0, stdout: state.status, stderr: "" };
      if (args.includes("--verify"))
        return { code: state.headCode ?? 0, stdout: "head", stderr: "" };
      if (args.includes("--numstat"))
        return {
          code: 0,
          stdout: args.includes("--cached") ? (state.cachedStats ?? state.stats) : state.stats,
          stderr: "",
        };
      if (args.includes("diff")) return { code: 0, stdout: state.diff, stderr: "" };
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
    input: { set_value() {} },
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
    children: [
      { id: "panel", hidden: true },
      { id: "panel-body", active: "changes" },
    ],
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

test("Changes notifies to re-enable commit controls after a render during loading", async () => {
  const h = await harness(true);
  h.changes.refresh(h.cx);
  await h.drain();
  h.state.notifications = 0;
  const held = deferred();
  h.state.block = held.promise;
  h.changes.message = "Commit these changes";
  h.changes.refresh(h.cx);
  h.render();
  assert.equal(h.changes.loadingRendered, true);
  held.resolve();
  await h.drain();
  assert.equal(h.changes.loading, false);
  assert.equal(h.state.notifications, 1);
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
  assert.equal(h.changes.open, "file.txt");
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

test("Changes overlaps status and HEAD discovery after resolving the repository root", async () => {
  const h = await harness(true);
  const status = deferred(),
    head = deferred();
  h.state.queryBlocks.set("status", status.promise);
  h.state.queryBlocks.set("head", head.promise);
  h.changes.refresh(h.cx);
  await ticks();
  const started = h.state.queryStarts.slice();
  head.resolve();
  await ticks();
  assert.equal(h.state.queryStarts.includes("unstaged"), false);
  status.resolve();
  await h.drain();
  assert.ok(started.includes("status") && started.includes("head"));
});

test("Changes overlaps unborn repository statistics and sums staged and unstaged counts", async () => {
  const h = await harness(true);
  h.state.headCode = 1;
  h.state.cachedStats = "2\t3\tfile.ts\0";
  h.state.stats = "5\t7\tfile.ts\0";
  const cached = deferred(),
    unstaged = deferred();
  h.state.queryBlocks.set("cached", cached.promise);
  h.state.queryBlocks.set("unstaged", unstaged.promise);
  h.changes.refresh(h.cx);
  await ticks();
  const started = h.state.queryStarts.slice();
  unstaged.resolve();
  await ticks();
  cached.resolve();
  await h.drain();
  assert.ok(started.includes("cached") && started.includes("unstaged"));
  assert.equal(h.changes.files[0].add, 7);
  assert.equal(h.changes.files[0].del, 10);
});

test("Changes lays diff rows out at their zoomed height", async () => {
  const h = await harness(true);
  h.changes.refresh(h.cx);
  await h.drain();
  h.render();
  const list = h.state.lists.find((list) => list.id === "changes-diff");
  assert.equal(list.extent, 20 * h.state.zoom);
});
