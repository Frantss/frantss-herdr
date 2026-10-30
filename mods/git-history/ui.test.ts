import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import { homedir } from "node:os";
import { join } from "node:path";

const here = new URL("./", import.meta.url);
const hostTypes = await readFile(
  join(process.env.HERDR_APP_HOME || join(homedir(), ".config/herdr-app"), "gpui-kit.d.ts"),
  "utf8",
);
const methods = new Set(
  [...hostTypes.matchAll(/^\s+([a-zA-Z_]\w*)[<(]/gm)].map((match) => match[1]),
);
const hash = (n) => n.toString(16).padStart(40, "0");
const commit = (n, parents = []) => ({
  hash: hash(n),
  parents,
  author: `Author ${n}`,
  email: "a@example.com",
  date: 1700000000,
  subject: `Commit ${n}`,
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
};

async function harness() {
  let phase = "event";
  const state: any = {
    props: { cwd: "/repo/a" },
    spaces: [],
    panes: [],
    focused: null,
    layout: null,
    settings: { zoom: 1 },
    branch: "main",
    branches: ["main"],
    traversal: [],
    stopped: 0,
    records: new Map([["/repo/a", [commit(2, [hash(1)]), commit(1)]]]),
    holds: [],
    calls: [],
    tasks: [],
    timers: [],
    lists: [],
    notifications: 0,
  };
  function element(kind = "div") {
    const node: any = {
      kind,
      childNodes: [],
      handlers: {},
      styles: [],
      stateStyles: {},
      elementId: undefined,
    };
    let proxy: any;
    proxy = new Proxy(node, {
      get(target, name) {
        if (name in target) return target[name];
        if (name === "then") return undefined;
        assert.ok(methods.has(String(name)), `Unknown native element method ${String(name)}`);
        return (...args) => {
          if (String(name).startsWith("on_")) {
            assert.notEqual(
              phase,
              "layout",
              `Handler ${String(name)} registered inside virtual list renderer`,
            );
            node.handlers[name] = args.at(-1);
          } else if (name === "child" || name === "header" || name === "panel")
            node.childNodes.push(args[0]);
          else if (name === "children") node.childNodes.push(...args[0]);
          else if (name === "when") {
            if (args[0]) args[1](proxy);
          } else if (name === "hover" || name === "focus") {
            const start = node.styles.length;
            args[0](proxy);
            node.stateStyles[name] = node.styles.splice(start);
          } else if (name === "id") node.elementId = args[0];
          else node.styles.push([name, ...args]);
          return proxy;
        };
      },
    });
    return proxy;
  }
  const ctx = {
    notify() {
      assert.notEqual(phase, "render", "cx.notify() is illegal during render");
      assert.notEqual(phase, "layout");
      state.notifications++;
    },
    focus_handle() {
      assert.notEqual(phase, "render");
      assert.notEqual(phase, "layout");
      return {
        focuses: 0,
        focus() {
          this.focuses++;
        },
      };
    },
    spawn(body) {
      const task = Promise.resolve().then(() => body(ctx));
      state.tasks.push(task);
      return task;
    },
    timer: {
      every(ms, callback) {
        state.timers.push({ ms, callback });
      },
    },
    stop_propagation() {
      state.stopped++;
    },
  };
  async function exec(command, args, options) {
    assert.equal(command, "git");
    state.calls.push({ args, options });
    const hold = state.holds.find((item) => !item.used && item.match(args, options));
    if (hold) {
      hold.used = true;
      await hold.promise;
    }
    const records = state.records.get(options.cwd) ?? [];
    const ok = (stdout) => ({ code: 0, stdout, stderr: "" });
    if (args.includes("show-ref"))
      return ok(
        records.length
          ? state.branches.map((branch) => `${records[0].hash} refs/heads/${branch}`).join("\n")
          : "",
      );
    if (args.includes("--show-toplevel")) {
      if (options.cwd === "/not-git")
        return { code: 128, stdout: "", stderr: "fatal: not a git repository" };
      return ok(options.cwd + "\n");
    }
    if (args.includes("--verify"))
      return records.length ? ok(records[0].hash + "\n") : { code: 1, stdout: "", stderr: "" };
    if (args.includes("symbolic-ref"))
      return state.branch ? ok(state.branch + "\n") : { code: 1, stdout: "", stderr: "" };
    if (args.includes("for-each-ref"))
      return ok(
        records.length
          ? state.branches
              .map((branch) => `${records[0].hash}\0commit\0\0\0refs/heads/${branch}\0${branch}\n`)
              .join("")
          : "",
      );
    if (args.includes("log")) {
      const limit = Number(args.find((arg) => arg.startsWith("--max-count=")).split("=")[1]);
      const reachable = new Set();
      const visit = (value) => {
        if (reachable.has(value)) return;
        reachable.add(value);
        records.find((record) => record.hash === value)?.parents.forEach(visit);
      };
      args.filter((arg) => /^[a-f0-9]{40}$/.test(arg)).forEach(visit);
      return ok(
        records
          .filter((record) => reachable.has(record.hash))
          .slice(0, limit)
          .flatMap((record) => [
            record.hash,
            record.parents.join(" "),
            record.author,
            record.email,
            String(record.date),
            record.subject,
          ])
          .join("\0") + "\0",
      );
    }
    if (args.includes("show")) {
      const record = records.find((record) => args.includes(record.hash));
      assert.ok(record, "Requested commit exists in fixture");
      return ok(
        [
          record.hash,
          record.parents.join(" "),
          record.author,
          record.email,
          String(record.date),
          `Message for ${record.subject}\n`,
        ].join("\0"),
      );
    }
    if (args.includes("--name-status")) return ok("M\0src/main.js\0A\0README.md\0");
    if (args.includes("--numstat")) return ok("2\t1\tsrc/main.js\0" + "4\t0\tREADME.md\0");
    if (args.includes("-p"))
      return ok(
        "diff --git a/src/main.js b/src/main.js\n--- a/src/main.js\n+++ b/src/main.js\n@@ -1 +1 @@\n-old\n+new\n",
      );
    throw new Error(`Unexpected git invocation: ${args.join(" ")}`);
  }
  const scrollHandle = () => ({
    calls: [],
    scroll_to_item(...args) {
      this.calls.push(["item", ...args]);
    },
    scroll_to_bottom() {
      this.calls.push(["bottom"]);
    },
  });
  const modules: Record<string, any> = {
    "gpui-kit": {
      View: class {},
      div: () => element(),
      svg: () => element("svg"),
      PathBuilder: {
        stroke() {
          const path = {
            move_to() {
              return path;
            },
            line_to() {
              return path;
            },
            build() {
              return {};
            },
          };
          return path;
        },
      },
    },
    "gpui-base": {
      v_flex: () => element("v_flex"),
      h_flex: () => element("h_flex"),
      Accordion: { new: (id) => element("accordion").id(id) },
      AccordionItem: { new: () => element("accordion_item") },
      AccordionHeader: { new: (trigger) => element("accordion_header").child(trigger) },
      AccordionTrigger: { new: (id) => element("accordion_trigger").id(id) },
      AccordionPanel: { new: () => element("accordion_panel") },
      Button: {
        new: (id) => {
          const node = element("button");
          node.elementId = id;
          return node;
        },
      },
      Scrollbar: {
        vertical: (id) => {
          const node = element("scrollbar");
          node.target = id;
          return node;
        },
      },
      VirtualListScrollHandle: { new: scrollHandle },
      v_virtual_list(id, count, size, key, renderer) {
        const node = element("virtual_list");
        Object.assign(node, { listId: id, count, size, key, renderer });
        state.lists.push(node);
        return node;
      },
    },
    herdr: {
      spaces: () => state.spaces,
      panes: () => state.panes,
      focused: () => state.focused,
      props: () => state.props,
      layout: () => state.layout,
      exec,
      settings: () => state.settings,
      run() {},
      theme: () =>
        Object.fromEntries(
          [
            "foreground",
            "muted",
            "accent",
            "selected",
            "hover",
            "working",
            "surface",
            "border",
          ].map((name) => [name, "#123456"]),
        ),
    },
  };
  const context = vm.createContext({
    console,
    window: {
      paint_path: () => element("path"),
      focus_next: () => state.traversal.push("next"),
      focus_prev: () => state.traversal.push("previous"),
    },
  });
  const cache = new Map();
  async function moduleFor(specifier) {
    if (cache.has(specifier)) return cache.get(specifier);
    const exports = modules[specifier];
    const module = exports
      ? new vm.SyntheticModule(
          Object.keys(exports),
          function () {
            for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
          },
          { context },
        )
      : new vm.SourceTextModule(
          stripTypeScriptTypes(
            await readFile(new URL(specifier.replace(/^\.\//, ""), here), "utf8"),
          ),
          { context, identifier: specifier },
        );
    cache.set(specifier, module);
    await module.link(moduleFor);
    return module;
  }
  const main = await moduleFor("./main.ts");
  await main.evaluate();
  const view = new (main.namespace as any).default();
  view.init({}, ctx);
  return {
    view,
    state,
    ctx,
    hold(match) {
      const entry = { ...deferred(), match };
      state.holds.push(entry);
      return entry;
    },
    async flush() {
      while (state.tasks.length) await Promise.all(state.tasks.splice(0));
    },
    async tick() {
      for (let i = 0; i < 8; i++) await Promise.resolve();
    },
    render() {
      state.lists = [];
      phase = "render";
      try {
        return view.render(ctx);
      } finally {
        phase = "event";
      }
    },
    rows(list, range = { start: 0, end: list.count }) {
      phase = "layout";
      try {
        const rows = list.renderer(range, ctx);
        assert.equal(rows.length, range.end - range.start);
        return rows;
      } finally {
        phase = "event";
      }
    },
  };
}
function allNodes(node) {
  if (!node || typeof node !== "object") return [];
  return [node, ...node.childNodes.flatMap(allNodes)];
}
const text = (node) =>
  typeof node === "string" ? node : (node?.childNodes ?? []).map(text).join(" ");
const byId = (tree, id) => allNodes(tree).find((node) => node.elementId === id);
const list = (h, id) => h.state.lists.find((node) => node.listId === id);
async function loaded(h) {
  h.view.refresh(h.ctx);
  await h.flush();
}
function toggle(h, id, open) {
  const trigger = byId(h.render(), id);
  assert.equal(trigger?.kind, "accordion_trigger");
  trigger.handlers.on_change(open, h.ctx);
}
const openDetails = (h) => toggle(h, "history-details-toggle", true);

test("native accordion details start collapsed and retain selection when toggled", async () => {
  const h = await harness();
  await loaded(h);
  let tree = h.render();
  assert.equal(h.view.historyOpen, true);
  assert.equal(h.view.detailsOpen, false);
  assert.equal(allNodes(tree).filter((node) => node.kind === "accordion").length, 1);
  assert.equal(allNodes(tree).filter((node) => node.kind === "accordion_item").length, 2);
  assert.ok(byId(tree, "history-list-focus"));
  assert.equal(byId(tree, "history-files-focus"), undefined);
  assert.doesNotMatch(text(tree), /Select a commit/);
  const historyTrigger = byId(tree, "history-toggle");
  assert.equal(historyTrigger.kind, "accordion_trigger");
  assert.equal(
    byId(historyTrigger, "history-refresh"),
    undefined,
    "Refresh is outside the History trigger",
  );
  assert.ok(byId(tree, "history-refresh"));

  h.view.pick(hash(2), h.ctx);
  await h.flush();
  assert.equal(h.view.detailsOpen, false);
  assert.doesNotMatch(text(h.render()), /Message for Commit 2/);
  openDetails(h);
  tree = h.render();
  assert.equal(h.view.detailsOpen, true);
  assert.match(text(tree), /Message for Commit 2/);
  assert.ok(byId(tree, "history-files-focus"));
  const details = h.view.details;
  const notifications = h.state.notifications;
  toggle(h, "history-details-toggle", false);
  assert.equal(h.state.notifications, notifications + 1);
  assert.equal(h.view.selected, hash(2));
  assert.equal(h.view.details, details);
  assert.equal(byId(h.render(), "history-files-focus"), undefined);

  h.view.pick(hash(1), h.ctx);
  await h.flush();
  assert.equal(h.view.detailsOpen, false);
  openDetails(h);
  assert.match(text(h.render()), /Message for Commit 1/);
  h.view.pick(hash(2), h.ctx);
  await h.flush();
  assert.equal(h.view.detailsOpen, true);
});

test("History collapses independently and repository changes restore accordion defaults", async () => {
  const h = await harness();
  await loaded(h);
  h.view.pick(hash(2), h.ctx);
  await h.flush();
  openDetails(h);
  const details = h.view.details;
  const notifications = h.state.notifications;
  toggle(h, "history-toggle", false);
  assert.equal(h.state.notifications, notifications + 1);
  let tree = h.render();
  assert.equal(h.view.historyOpen, false);
  assert.equal(h.view.detailsOpen, true);
  assert.equal(byId(tree, "history-list-focus"), undefined);
  assert.equal(byId(tree, "history-current"), undefined);
  assert.equal(list(h, "history-commits"), undefined);
  assert.match(text(tree), /Message for Commit 2/);
  assert.equal(h.view.details, details);
  toggle(h, "history-toggle", true);
  assert.ok(byId(h.render(), "history-list-focus"));
  toggle(h, "history-toggle", false);

  h.state.props = { cwd: "/repo/b" };
  h.state.records.set("/repo/b", [commit(9)]);
  h.view.refresh(h.ctx);
  await h.flush();
  tree = h.render();
  assert.equal(h.view.historyOpen, true);
  assert.equal(h.view.detailsOpen, false);
  assert.equal(h.view.selected, null);
  assert.ok(byId(tree, "history-list-focus"));
  assert.equal(byId(tree, "history-files-focus"), undefined);
});

test("focusing history or changed files preserves the content insets", async () => {
  const h = await harness();
  await loaded(h);
  const borderWidth = (styles) =>
    styles.reduce(
      (width, [name, value]) =>
        name === "border_1" ? 1 : name === "border_2" ? 2 : name === "border" ? value : width,
      0,
    );
  const stableInsets = (node) => {
    assert.ok(node, "List focus container exists");
    const idle = borderWidth(node.styles);
    const focused = borderWidth([...node.styles, ...(node.stateStyles.focus ?? [])]);
    assert.equal(focused, idle, `${node.elementId} must not add an inset on focus`);
  };
  stableInsets(byId(h.render(), "history-list-focus"));
  h.view.pick(hash(2), h.ctx);
  stableInsets(byId(h.render(), "history-list-focus"));
  await h.flush();
  openDetails(h);
  const tree = h.render();
  stableInsets(byId(tree, "history-list-focus"));
  stableInsets(byId(tree, "history-files-focus"));
});

test("initial render can load without notifying during render", async () => {
  const h = await harness();
  assert.doesNotThrow(() => h.render());
  await h.flush();
  assert.equal(h.view.commits.length, 2);
});

test("worktree switch ignores old history and targets the new remote", async () => {
  const h = await harness();
  const old = h.hold((args, opts) => args.includes("show-ref") && opts.cwd === "/repo/a");
  h.view.refresh(h.ctx);
  await h.tick();
  h.state.props = { cwd: "/repo/b", on: "build-server" };
  h.state.records.set("/repo/b", [commit(9)]);
  h.view.refresh(h.ctx);
  await h.tick();
  old.resolve();
  await h.flush();
  assert.equal(h.view.place.cwd, "/repo/b");
  assert.equal(h.view.place.on, "build-server");
  assert.deepEqual(
    Array.from(h.view.commits as { hash: string }[], (item) => item.hash),
    [hash(9)],
  );
  assert.ok(
    h.state.calls
      .filter((call) => call.options.cwd === "/repo/b")
      .every((call) => call.options.on === "build-server"),
  );
});

test("scope switch clears the old snapshot and ignores its pending response", async () => {
  const h = await harness();
  await loaded(h);
  const old = h.hold((args) => args.includes("show-ref"));
  h.view.refresh(h.ctx);
  await h.tick();
  h.view.setScope("all", h.ctx);
  assert.equal(h.view.selected, null);
  assert.equal(h.view.snapshot, null);
  assert.equal(h.view.commits.length, 0);
  old.resolve();
  await h.flush();
  assert.equal(h.view.snapshot.scope, "all");
  assert.equal(h.view.loading, false);
});

test("paging retains frozen tips and scroll while a ref changes", async () => {
  const h = await harness();
  h.state.records.set(
    "/repo/a",
    Array.from({ length: 105 }, (_, i) => commit(105 - i, i < 104 ? [hash(104 - i)] : [])),
  );
  await loaded(h);
  assert.equal(h.view.commits.length, 25);
  assert.match(text(h.render()), /Load 25 more/);
  const snapshot = h.view.snapshot;
  const scrolls = h.view.scroll.calls.length;
  const signatures = h.state.calls.filter((call) => call.args.includes("show-ref")).length;
  h.state.records.get("/repo/a").unshift(commit(106, [hash(105)]));
  h.view.refresh(h.ctx, true);
  await h.flush();
  assert.equal(h.view.snapshot, snapshot);
  assert.equal(h.view.limit, 50);
  assert.equal(h.view.commits.length, 50);
  assert.equal(h.view.commits[0].hash, hash(105));
  assert.equal(h.view.commits.at(-1).hash, hash(56));
  assert.equal(h.view.scroll.calls.length, scrolls);
  assert.equal(h.state.calls.filter((call) => call.args.includes("show-ref")).length, signatures);
  const logCall = h.state.calls.filter((call) => call.args.includes("log")).at(-1);
  assert.ok(logCall.args.includes(snapshot.head));
  assert.ok(!logCall.args.includes("--all"));
});

test("new commit selection ignores old details and stale diffs", async () => {
  const h = await harness();
  await loaded(h);
  const oldDetails = h.hold((args) => args.includes("show") && args.includes(hash(2)));
  h.view.pick(hash(2), h.ctx);
  await h.tick();
  h.view.pick(hash(1), h.ctx);
  oldDetails.resolve();
  await h.flush();
  assert.equal(h.view.details.hash, hash(1));
  const oldDiff = h.hold((args) => args.includes("-p"));
  h.view.pickFile("src/main.js", h.ctx);
  await h.tick();
  h.view.pick(hash(2), h.ctx);
  oldDiff.resolve();
  await h.flush();
  assert.equal(h.view.details.hash, hash(2));
  assert.equal(h.view.file, null);
  assert.equal(h.view.diff, null);
});

test("empty repository, missing cwd, and git errors render recovery text", async () => {
  const h = await harness();
  h.state.records.set("/repo/a", []);
  await loaded(h);
  assert.match(text(h.render()), /repository has no commits/);
  assert.equal(h.state.lists.length, 0);
  h.state.props = {};
  h.view.refresh(h.ctx);
  assert.match(text(h.render()), /Open a terminal in a Git repository/);
  h.state.props = { cwd: "/not-git" };
  h.view.refresh(h.ctx);
  await h.flush();
  assert.match(text(h.render()), /not a git repository/);
  assert.match(text(h.render()), /Use Refresh to try again/);
});

test("commit rows, detail files, and diffs build valid lazy native elements", async () => {
  const h = await harness();
  await loaded(h);
  let tree = h.render();
  let rows = h.rows(list(h, "history-commits"), { start: 0, end: 1 });
  assert.match(text(rows[0]), /Commit 2/);
  list(h, "history-commits").handlers.on_item_click(hash(2), h.ctx);
  await h.flush();
  openDetails(h);
  tree = h.render();
  assert.match(text(tree), /Message for Commit 2/);
  const files = list(h, "history-files");
  rows = h.rows(files, { start: 0, end: 2 });
  assert.match(text(rows[0]), /src\/main.js/);
  files.handlers.on_item_click("src/main.js", h.ctx);
  await h.flush();
  tree = h.render();
  rows = h.rows(list(h, "history-diff"));
  assert.match(rows.map(text).join("\n"), /-old\n\+new/);
  byId(tree, "history-back").handlers.on_click({}, h.ctx);
  assert.equal(h.view.file, null);
});

test("file arrow keys select, Enter opens, and a new commit resets file selection", async () => {
  const h = await harness();
  await loaded(h);
  h.view.pick(hash(2), h.ctx);
  await h.flush();
  openDetails(h);
  let tree = h.render();
  byId(tree, "history-files-focus").handlers.on_key_down({ key: "down" }, h.ctx);
  assert.equal(h.view.fileIndex, 0);
  assert.equal(h.view.file, null);
  tree = h.render();
  byId(tree, "history-files-focus").handlers.on_key_down({ key: "down" }, h.ctx);
  assert.equal(h.view.fileIndex, 1);
  byId(tree, "history-files-focus").handlers.on_key_down({ key: "enter" }, h.ctx);
  await h.flush();
  assert.equal(h.view.file, "README.md");
  h.view.pick(hash(1), h.ctx);
  await h.flush();
  tree = h.render();
  byId(tree, "history-files-focus").handlers.on_key_down({ key: "down" }, h.ctx);
  assert.equal(h.view.fileIndex, 0);
});

test("poll marks changed history and keeps the current snapshot until Refresh", async () => {
  const h = await harness();
  await loaded(h);
  const snapshot = h.view.snapshot;
  h.state.records.get("/repo/a").unshift(commit(3, [hash(2)]));
  h.view.poll(h.ctx);
  await h.flush();
  assert.equal(h.view.changed, true);
  assert.equal(h.view.snapshot, snapshot);
  assert.equal(h.view.commits[0].hash, hash(2));
  assert.match(text(h.render()), /History changed/);
  byId(h.render(), "history-refresh").handlers.on_click({}, h.ctx);
  await h.flush();
  assert.equal(h.view.commits[0].hash, hash(3));
  assert.equal(h.view.changed, false);
});

test("pending details from another worktree cannot populate the new repository", async () => {
  const h = await harness();
  await loaded(h);
  const old = h.hold((args) => args.includes("show"));
  h.view.pick(hash(2), h.ctx);
  await h.tick();
  h.state.props = { cwd: "/repo/b" };
  h.state.records.set("/repo/b", [commit(9)]);
  h.render();
  old.resolve();
  await h.flush();
  assert.equal(h.view.selected, null);
  assert.equal(h.view.details, null);
  assert.equal(h.view.detailsLoading, false);
  assert.equal(h.view.commits[0].hash, hash(9));
});

test("focused remote terminal routes git without a pane or active space", async () => {
  const h = await harness();
  h.state.props = {};
  h.state.focused = { pane: null, terminal: "build-server/t17", cwd: "/repo/a" };
  h.view.refresh(h.ctx);
  await h.flush();
  assert.equal(h.view.place.on, "build-server");
  assert.ok(h.state.calls.length > 0);
  assert.ok(h.state.calls.every((call) => call.options.on === "build-server"));
});

test("same-hash branch checkout marks the history snapshot changed", async () => {
  const h = await harness();
  h.state.branches = ["main", "topic"];
  await loaded(h);
  const snapshot = h.view.snapshot;
  const signature = h.view.signature;
  h.state.branch = "topic";
  h.view.poll(h.ctx);
  await h.flush();
  assert.equal(h.view.changed, true);
  assert.equal(h.view.snapshot, snapshot);
  assert.equal(h.view.branch, "main");
  assert.equal(h.view.signature, signature);
  byId(h.render(), "history-refresh").handlers.on_click({}, h.ctx);
  await h.flush();
  assert.equal(h.view.branch, "topic");
  assert.equal(h.view.commits[0].hash, hash(2));
  assert.equal(h.view.changed, false);
});

test("Tab and Shift+Tab dispatch native focus traversal and controls are tab stops", async () => {
  const h = await harness();
  await loaded(h);
  const tree = h.render();
  const root = byId(tree, "git-history");
  root.handlers.on_key_down({ key: "tab", modifiers: { shift: false } }, h.ctx);
  root.handlers.on_key_down({ key: "tab", modifiers: { shift: true } }, h.ctx);
  assert.deepEqual(h.state.traversal, ["next", "previous"]);
  assert.equal(h.state.stopped, 2);
  const buttons = allNodes(tree).filter((node) => node.kind === "button");
  assert.ok(buttons.length >= 3);
  assert.ok(
    buttons.every((button) =>
      button.styles.some(([name, value]) => name === "tab_stop" && value === true),
    ),
  );
});

test("opening a diff moves focus to the mounted commit list and Escape returns to details", async () => {
  const h = await harness();
  await loaded(h);
  h.view.pick(hash(2), h.ctx);
  await h.flush();
  const previousFocus = h.view.listFocus.focuses;
  h.view.pickFile("src/main.js", h.ctx);
  assert.equal(h.view.listFocus.focuses, previousFocus + 1);
  await h.flush();
  const root = byId(h.render(), "git-history");
  root.handlers.on_key_down({ key: "escape" }, h.ctx);
  assert.equal(h.view.file, null);
  assert.equal(h.view.diff, null);
  assert.equal(h.view.details.hash, hash(2));
  assert.equal(h.view.listFocus.focuses, previousFocus + 2);
});

test("virtual row extents and measured panel bounds account for app zoom", async () => {
  const h = await harness();
  h.state.settings.zoom = 1.5;
  await loaded(h);
  let tree = h.render();
  assert.equal(list(h, "history-commits").size, 63);
  byId(tree, "git-history").handlers.on_size_change({ width: 600, height: 900 }, h.ctx);
  assert.equal(h.view.size.width, 400);
  assert.equal(h.view.size.height, 600);
  h.view.pick(hash(2), h.ctx);
  await h.flush();
  openDetails(h);
  tree = h.render();
  assert.equal(list(h, "history-files").size, 39);
  h.view.pickFile("src/main.js", h.ctx);
  await h.flush();
  tree = h.render();
  assert.equal(list(h, "history-diff").size, 28.5);
});

test("History immediately restores navigation rows and reconciles the cached page size with fresh tips", async () => {
  const h = await harness();
  h.state.records.set(
    "/repo/a",
    Array.from({ length: 80 }, (_, i) => commit(80 - i, i < 79 ? [hash(79 - i)] : [])),
  );
  await loaded(h);
  h.view.refresh(h.ctx, true);
  await h.flush();
  assert.equal(h.view.limit, 50);
  h.view.pick(hash(80), h.ctx);
  await h.flush();
  assert.ok(h.view.details);
  const cached = h.view.commits,
    snapshot = h.view.snapshot;
  h.state.props = { cwd: "/repo/b" };
  h.state.records.set("/repo/b", [commit(100)]);
  await loaded(h);
  h.state.records.get("/repo/a").unshift(commit(81, [hash(80)]));
  h.state.props = { cwd: "/repo/a" };
  const held = h.hold((args, opts) => args.includes("show-ref") && opts.cwd === "/repo/a");
  h.view.refresh(h.ctx);
  assert.equal(h.view.commits, cached);
  assert.equal(h.view.limit, 50);
  assert.equal(h.view.selected, null);
  assert.equal(h.view.details, null);
  held.resolve();
  await h.flush();
  assert.equal(h.view.limit, 50);
  assert.equal(h.view.commits.length, 50);
  assert.equal(h.view.commits[0].hash, hash(81));
  assert.notEqual(h.view.snapshot, snapshot);
  const reconciled = h.view.snapshot;
  h.view.refresh(h.ctx);
  await h.flush();
  assert.equal(h.view.limit, 25);
  assert.equal(h.view.commits.length, 25);
  assert.notEqual(h.view.snapshot, reconciled);
});

test("History snapshots stay separate by scope and machine", async () => {
  const h = await harness();
  await loaded(h);
  const current = h.view.commits;
  h.view.setScope("all", h.ctx);
  assert.equal(h.view.commits.length, 0);
  await h.flush();
  const all = h.view.commits;
  h.view.setScope("current", h.ctx);
  assert.equal(h.view.commits, current);
  await h.flush();
  h.view.setScope("all", h.ctx);
  assert.equal(h.view.commits, all);
  await h.flush();
  h.state.props = { cwd: "/repo/a", on: "server" };
  h.view.refresh(h.ctx);
  assert.equal(h.view.commits.length, 0);
  await h.flush();
  h.state.props = { cwd: "/repo/a", on: null };
  h.view.refresh(h.ctx);
  assert.ok(h.view.commits.length > 0);
  await h.flush();
});

test("History context caches reject obsolete A→B→A responses", async () => {
  const h = await harness();
  await loaded(h);
  const old = h.hold((args, opts) => args.includes("log") && opts.cwd === "/repo/a");
  h.view.refresh(h.ctx);
  await h.tick();
  h.state.props = { cwd: "/repo/b" };
  h.state.records.set("/repo/b", [commit(9)]);
  h.view.refresh(h.ctx);
  await h.tick();
  h.state.records.set("/repo/a", [commit(7)]);
  h.state.props = { cwd: "/repo/a" };
  h.view.refresh(h.ctx);
  await h.tick();
  old.resolve();
  await h.flush();
  assert.deepEqual(
    Array.from(h.view.commits, (item: any) => item.hash),
    [hash(7)],
  );
  assert.equal(h.view.loading, false);
});

test("History evicts context snapshots after twenty entries", async () => {
  const h = await harness();
  await loaded(h);
  for (let i = 0; i < 21; i++) {
    const cwd = `/repo-${i}`;
    h.state.props = { cwd };
    h.state.records.set(cwd, [commit(i + 100)]);
    await loaded(h);
  }
  assert.equal(h.view.kept.size, 20);
  h.state.props = { cwd: "/repo/a" };
  h.view.refresh(h.ctx);
  assert.equal(h.view.commits.length, 0);
  await h.flush();
});

test("History refresh and append replace polling ownership without blocking future polls", async () => {
  for (const append of [false, true]) {
    const h = await harness();
    await loaded(h);
    const old = h.hold((args) => args.includes("show-ref"));
    h.view.poll(h.ctx);
    await h.tick();
    const oldTask = h.state.tasks.at(-1);
    assert.equal(h.view.polling, true);
    h.view.refresh(h.ctx, append);
    await h.state.tasks.at(-1);
    assert.equal(h.view.polling, false);

    const current = h.hold((args) => args.includes("show-ref"));
    h.view.poll(h.ctx);
    await h.tick();
    const currentTask = h.state.tasks.at(-1);
    assert.equal(h.view.polling, true);
    old.resolve();
    await oldTask;
    assert.equal(h.view.polling, true, "The old poll must not release the newer poll's ownership");
    current.resolve();
    await currentTask;
    assert.equal(h.view.polling, false);

    const next = h.hold((args) => args.includes("show-ref"));
    h.view.poll(h.ctx);
    await h.tick();
    assert.equal(h.view.polling, true, "Future polling must still run");
    next.resolve();
    await h.flush();
    assert.equal(h.view.polling, false);
  }
});

test("History revisits the oldest snapshot when the outgoing place fills the cache", async () => {
  const h = await harness();
  await loaded(h);
  const cached = h.view.commits;
  for (let i = 0; i < 20; i++) {
    const cwd = `/repo-${i}`;
    h.state.props = { cwd };
    h.state.records.set(cwd, [commit(i + 100)]);
    await loaded(h);
  }
  assert.equal(h.view.kept.size, 20);
  h.state.props = { cwd: "/repo/a" };
  h.view.refresh(h.ctx);
  assert.equal(h.view.commits, cached);
  assert.equal(h.view.kept.size, 20);
  await h.flush();
});
