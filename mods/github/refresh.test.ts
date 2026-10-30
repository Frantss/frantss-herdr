import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const placeKey = (cwd: string, on: string | null = null) => JSON.stringify([cwd, on]);
const deferred = () => {
  let resolve: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve() };
};

async function harness() {
  const state = {
    place: { cwd: "/repo/worktree", on: null as string | null },
    spaces: [
      { folder: "/repo/worktree", machine: null, tabs: [] },
      { folder: "/repo", machine: null, tabs: [] },
      { folder: "/other", machine: null, tabs: [] },
      { folder: "/repo", machine: "build-server", tabs: [] },
    ],
    repositories: new Map([
      [placeKey("/repo/worktree"), "/repo/.git"],
      [placeKey("/repo"), "/repo/.git"],
      [placeKey("/other"), "/other/.git"],
      [placeKey("/repo", "build-server"), "/repo/.git"],
    ]),
    failures: new Map<string, string>(),
    holds: new Map<string, Promise<void>>(),
    calls: [] as { command: string; args: string[]; cwd: string; on: string | null }[],
    tasks: [] as Promise<unknown>[],
    explicit: true,
    layout: null as any,
    timers: [] as unknown[],
    elements: 0,
    notifications: 0,
    writes: [] as { key: string; value: string }[],
    writeAttempts: 0,
    storageFailure: false,
    shared: new Map<string, unknown>(),
  };
  const cx = {
    notify() {
      state.notifications++;
    },
    timer: { every: (...args) => state.timers.push(args) },
    spawn(callback: (cx: unknown) => unknown) {
      const task = Promise.resolve().then(() => callback(cx));
      state.tasks.push(task);
      return task;
    },
  };
  const context = vm.createContext({
    localStorage: {
      getItem: () => null,
      setItem(key: string, value: string) {
        state.writeAttempts++;
        if (state.storageFailure) throw new Error("Storage unavailable");
        state.writes.push({ key, value });
      },
    },
  });
  const unused = () => assert.fail("Unexpected UI host call");
  function element() {
    state.elements++;
    const proxy = new Proxy(
      {},
      {
        get(_target, name) {
          if (name === "then") return undefined;
          return (...args) => {
            if (name === "when" && args[0]) args[1](proxy);
            return proxy;
          };
        },
      },
    );
    return proxy;
  }
  const natives = {
    "gpui-kit": { View: class {}, div: element, svg: element, image: element },
    "gpui-base": { v_flex: element, h_flex: element, Button: {} },
    herdr: {
      spaces: () => state.spaces,
      panes: () => [],
      focused: () => ({ cwd: state.place.cwd, pane: null }),
      props: () => (state.explicit ? state.place : {}),
      knownAgents: async () => [],
      exec: async (
        command: string,
        args: string[],
        options: { cwd: string; on: string | null },
      ) => {
        const { cwd, on } = options;
        state.calls.push({ command, args: Array.from(args), cwd, on });
        const key = placeKey(cwd, on);
        if (command === "git") {
          const repo = state.repositories.get(key);
          return repo
            ? { code: 0, stdout: repo, stderr: "" }
            : { code: 128, stdout: "", stderr: "Not a repository" };
        }
        assert.equal(command, "gh");
        if (args[0] === "repo") {
          await state.holds.get(key);
          const failure = state.failures.get(key);
          return failure
            ? { code: 1, stdout: "", stderr: failure }
            : {
                code: 0,
                stdout: JSON.stringify({
                  owner: { login: on ?? "local" },
                  name: cwd.slice(1).replaceAll("/", "-"),
                }),
                stderr: "",
              };
        }
        assert.deepEqual(Array.from(args.slice(0, 2)), ["api", "graphql"]);
        const field = (name: string) =>
          args.find((arg) => arg.startsWith(`${name}=`)).slice(name.length + 1);
        return {
          code: 0,
          stdout: JSON.stringify({
            data: {
              viewer: { login: "me" },
              repository: {
                nameWithOwner: `${field("owner")}/${field("name")}`,
                pullRequests: { nodes: [] },
              },
            },
          }),
          stderr: "",
        };
      },
      hc: unused,
      run: unused,
      theme: () => ({}),
      settings: () => ({ dark: true }),
      layout: () => state.layout,
      agents: () => [],
      terminals: () => [],
      shared: (key: string) => state.shared.get(key) ?? null,
      setShared: (key: string, value: unknown) => state.shared.set(key, value),
      home: unused,
      notify: unused,
    },
  };
  const modules = new Map<string, vm.Module>();
  async function load(id: string): Promise<vm.Module> {
    if (modules.has(id)) return modules.get(id);
    const values = natives[id];
    const module = values
      ? new vm.SyntheticModule(
          Object.keys(values),
          function () {
            for (const [key, value] of Object.entries(values)) this.setExport(key, value);
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
  const GitHub = (module.namespace as { default: new () => any }).default;
  const view = new GitHub();
  Object.assign(view, {
    repos: new Map(),
    names: new Map(),
    cache: new Map(),
    errors: new Map(),
    inflight: new Set(),
    place: state.place,
    context: JSON.stringify(state.place),
    groups: [],
    selected: new Set(),
    starting: new Set(),
    expanded: new Set(),
    collapsed: new Set(),
    agentOptions: [],
  });
  async function drain() {
    for (let i = 0; i < state.tasks.length; i++) await state.tasks[i];
  }
  return {
    state,
    view,
    cx,
    element,
    drain,
    async refresh() {
      view.refreshAll(cx);
      await drain();
    },
    requests: () => state.calls.filter((call) => call.command === "gh" && call.args[0] === "repo"),
  };
}

test("GitHub defers hidden initialization until its first reveal", async () => {
  const h = await harness();
  delete h.view.context;
  delete h.view.place;
  h.state.explicit = false;
  h.state.layout = {
    children: [{ id: "panel", hidden: true, active: "github" }],
  };
  h.view.init(undefined, h.cx);
  await h.drain();
  assert.equal(h.state.calls.length, 0);
  assert.equal(h.view.pendingInitialRefresh, true);
  h.view.body = () => assert.fail("A hidden GitHub panel built its inbox");
  h.view.render(h.cx);
  assert.equal(h.state.elements, 1);
  h.view.body = h.element;
  h.view.footer = h.element;
  h.view.button = h.element;
  h.view.iconButton = h.element;
  h.state.layout.children[0].hidden = false;
  h.view.render(h.cx);
  await h.drain();
  assert.equal(h.requests().length, 3);
  assert.equal(h.view.pendingInitialRefresh, false);
  const cache = h.view.cache,
    calls = h.state.calls.length;
  h.view.selected.add("kept");
  h.state.layout.children[0].hidden = true;
  h.view.render(h.cx);
  h.state.layout.children[0].hidden = false;
  h.view.render(h.cx);
  await h.drain();
  assert.equal(h.state.calls.length, calls);
  assert.equal(h.view.cache, cache);
  assert.equal(h.view.selected.has("kept"), true);
});

test("an explicit-cwd GitHub copy initializes even when the layout panel is hidden", async () => {
  const h = await harness();
  h.state.layout = {
    children: [{ id: "panel", hidden: true, active: "files" }],
  };
  h.view.init(undefined, h.cx);
  await h.drain();
  assert.equal(h.view.visible(), true);
  assert.equal(h.view.pendingInitialRefresh, false);
  assert.equal(h.requests().length, 3);
});

test("GitHub refreshes the current repository first and loads each machine/repository once", async () => {
  const h = await harness();
  await h.refresh();
  assert.deepEqual(
    h.requests().map(({ cwd, on }) => [cwd, on]),
    [
      ["/repo/worktree", null],
      ["/other", null],
      ["/repo", "build-server"],
    ],
  );
  assert.equal(h.state.calls.filter((call) => call.command === "gh").length, 6);
  assert.equal(h.view.cache.size, 3);
  assert.equal(h.view.repos.get(JSON.stringify({ cwd: "/repo", on: null })), h.view.repo);
  assert.notEqual(
    h.view.repos.get(JSON.stringify({ cwd: "/repo", on: "build-server" })),
    h.view.repo,
  );
});

test("GitHub batches a three-repository cycle into one cache write and only foreground updates", async () => {
  const h = await harness();
  await h.refresh();
  assert.equal(h.state.writes.length, 1);
  assert.equal(h.state.writes[0].key, "cache");
  assert.equal(JSON.parse(h.state.writes[0].value).cache.length, 3);
  assert.equal(h.state.notifications, 2);
  assert.equal(h.view.refreshingAll, false);
});

test("explicit GitHub loads persist their result immediately", async () => {
  const h = await harness();
  h.view.load(h.state.place, h.cx);
  await h.drain();
  assert.equal(h.requests().length, 1);
  assert.equal(h.state.writes.length, 1);
  assert.equal(JSON.parse(h.state.writes[0].value).cache.length, 1);
  assert.equal(h.state.notifications, 2);
});

test("overlapping GitHub refresh cycles share the active queue", async () => {
  const h = await harness(),
    held = deferred();
  h.state.holds.set(placeKey("/repo/worktree"), held.promise);
  h.view.refreshAll(h.cx);
  for (let i = 0; i < 20 && !h.requests().length; i++) await Promise.resolve();
  assert.equal(h.requests().length, 1);
  h.view.refreshAll(h.cx);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(h.requests().length, 1);
  assert.equal(h.state.tasks.length, 1);
  held.resolve();
  await h.drain();
  assert.equal(h.requests().length, 3);
  assert.equal(h.state.writes.length, 1);
  assert.equal(h.view.refreshingAll, false);
});

test("resolving the current alias exposes cached data and active loading without another GitHub request", async () => {
  const h = await harness(),
    held = deferred();
  const repo = JSON.stringify({ repo: "/repo/.git", on: null });
  const cached = { repo: "owner/repo", viewer: "me", prs: [] };
  h.view.cache.set(repo, cached);
  h.state.holds.set(placeKey("/repo/worktree"), held.promise);
  const first = h.view.loadPlace(h.state.place, h.cx);
  for (let i = 0; i < 20 && !h.requests().length; i++) await Promise.resolve();
  assert.equal(h.requests().length, 1);
  const alias = { cwd: "/alias", on: null };
  h.state.repositories.set(placeKey("/alias"), "/repo/.git");
  h.state.place = alias;
  h.view.place = alias;
  h.view.context = JSON.stringify(alias);
  assert.equal(h.view.data, null);
  assert.equal(h.view.loading(), false);
  h.state.notifications = 0;
  await h.view.loadPlace(alias, h.cx);
  assert.equal(h.state.notifications, 1);
  assert.equal(h.view.data, cached);
  assert.equal(h.view.loading(), true);
  assert.equal(h.requests().length, 1);
  held.resolve();
  await first;
  assert.equal(h.state.notifications, 2);
  assert.equal(h.view.loading(), false);
});

test("GitHub cache write failures keep in-memory results and release the cycle guard", async () => {
  const h = await harness();
  h.state.storageFailure = true;
  await h.refresh();
  assert.equal(h.view.cache.size, 3);
  assert.equal(h.view.error, null);
  assert.equal(h.state.writeAttempts, 1);
  assert.equal(h.view.refreshingAll, false);
  h.state.storageFailure = false;
  await h.refresh();
  assert.equal(h.state.writeAttempts, 2);
  assert.equal(h.state.writes.length, 1);
});

test("collapsed GitHub sections keep their counts without constructing hidden rows", async () => {
  const h = await harness();
  await h.refresh();
  const pr = (number, extra = {}) => ({
    number,
    author: "me",
    requested: [],
    draft: false,
    decision: null,
    checks: { state: "PENDING", failed: [] },
    threads: [],
    ...extra,
  });
  h.view.cache.set(h.view.repo, {
    repo: "owner/repo",
    viewer: "me",
    prs: [
      pr(1, { checks: { state: "FAILURE", failed: [{ name: "test" }] } }),
      pr(2, { threads: [{ author: "ana" }] }),
      pr(3, { author: "ana", requested: ["me"] }),
      pr(4, { decision: "APPROVED", checks: { state: "SUCCESS", failed: [] } }),
    ],
  });
  h.view.linkedAgents = () => [{ number: 5, kinds: [] }];
  const headers: [string, number][] = [],
    rows: string[] = [];
  h.view.groupHeader = (title, count) => {
    headers.push([title, count]);
    return {};
  };
  h.view.itemRow = (item) => {
    rows.push(item.id);
    return {};
  };
  h.view.agentRow = () => {
    rows.push("agent");
    return {};
  };
  const titles = ["Failing CI", "Comments", "Review requested", "Ready to merge", "Agents on it"];
  h.view.collapsed = new Set(titles);
  h.view.body({});
  assert.deepEqual(rows, []);
  assert.equal(headers.length, 5);
  assert.ok(headers.every(([, count]) => count === 1));
  h.view.collapsed.delete("Comments");
  h.view.body({});
  assert.deepEqual(rows, ["2:address"]);
});

test("a failed repository does not repeat within its cycle or prevent later repositories loading", async () => {
  const h = await harness();
  h.state.failures.set(placeKey("/repo/worktree"), "GitHub is unavailable");
  await h.refresh();
  assert.equal(h.requests().length, 3);
  assert.equal(h.view.error, "GitHub is unavailable");
  assert.equal(h.view.cache.size, 2);
  assert.equal(h.state.writes.length, 1);
  h.state.failures.clear();
  await h.refresh();
  assert.equal(h.requests().length, 4);
  assert.equal(h.view.error, null);
  assert.equal(h.view.cache.size, 3);
  assert.equal(h.state.writes.length, 2);
});

test("a folder outside a repository does not stop the remaining refresh queue", async () => {
  const h = await harness();
  h.state.repositories.delete(placeKey("/repo/worktree"));
  await h.refresh();
  assert.equal(h.view.error, "Not a Git repository.");
  assert.deepEqual(
    h.requests().map(({ cwd, on }) => [cwd, on]),
    [
      ["/repo", null],
      ["/other", null],
      ["/repo", "build-server"],
    ],
  );
});

test("direct GitHub loads still suppress an overlapping repository request", async () => {
  const h = await harness();
  const held = deferred();
  h.state.holds.set(placeKey("/repo/worktree"), held.promise);
  const first = h.view.loadPlace(h.state.place, h.cx);
  for (let i = 0; i < 20 && !h.requests().length; i++) await Promise.resolve();
  assert.equal(h.requests().length, 1);
  await h.view.loadPlace({ cwd: "/repo", on: null }, h.cx);
  assert.equal(h.requests().length, 1);
  assert.equal(h.view.inflight.size, 1);
  held.resolve();
  await first;
  assert.equal(h.view.inflight.size, 0);
  assert.equal(h.view.cache.size, 1);
  assert.equal(h.state.calls.filter((call) => call.command === "gh").length, 2);
});

test("GitHub reuses inbox models until repository data or agent assignments change", async () => {
  const h = await harness();
  await h.refresh();
  let reads = 0;
  const pr = {
    number: 1,
    author: "me",
    requested: ["ana"],
    draft: true,
    decision: null,
    threads: [],
    get checks() {
      reads++;
      return { state: "FAILURE", failed: [{ name: "lint" }] };
    },
  };
  const data = { repo: "owner/repo", viewer: "me", prs: [pr] };
  h.view.cache.set(h.view.repo, data);
  h.view.collapsed = new Set(["Failing CI"]);
  h.view.groupHeader = h.element;
  h.view.itemRow = h.element;
  h.view.agentRow = h.element;
  let linked: { number: number; kinds: string[] }[] = [];
  h.view.linkedAgents = () => linked;
  h.view.body({});
  const groups = h.view.groups,
    firstReads = reads;
  h.view.body({});
  assert.equal(reads, firstReads);
  assert.equal(h.view.groups, groups);
  linked = [{ number: 1, kinds: ["fix-ci"] }];
  h.view.body({});
  assert.equal(h.view.groups[0].items.length, 0);
  assert.ok(reads > firstReads);
  const assignedGroups = h.view.groups,
    assignedReads = reads;
  linked = [...linked, ...linked];
  h.view.body({});
  assert.equal(reads, assignedReads);
  assert.equal(h.view.groups, assignedGroups);
  h.view.cache.set(h.view.repo, { ...data, viewer: "ana" });
  h.view.body({});
  assert.equal(h.view.groups[2].items.length, 1);
  assert.ok(reads > assignedReads);
});

test("later GitHub loads reuse each repository's name", async () => {
  const h = await harness();
  const queries = () =>
    h.state.calls.filter((call) => call.args[0] === "api").map((call) => call.args.slice(-4));
  await h.refresh();
  const first = queries();
  await h.refresh();
  assert.equal(h.requests().length, 3);
  assert.deepEqual(queries(), [...first, ...first]);
});

test("a hidden GitHub panel refreshes every five minutes instead of every minute", async () => {
  const h = await harness();
  h.state.explicit = false;
  h.state.layout = {
    children: [{ id: "panel", hidden: true, active: "files" }],
  };
  h.view.init(undefined, h.cx);
  const [[interval, tick]] = h.state.timers as [number, (cx: unknown) => void][];
  assert.equal(interval, 60000);
  const loads = () => h.state.calls.filter((call) => call.command === "gh").length;
  tick(h.cx);
  await h.drain();
  const requests = loads();
  assert.ok(requests > 0);
  h.view.polledAt = Date.now() - 4 * 60000;
  tick(h.cx);
  await h.drain();
  assert.equal(loads(), requests);
  h.view.polledAt = Date.now() - 5 * 60000;
  tick(h.cx);
  await h.drain();
  assert.ok(loads() > requests);
});

test("GitHub publishes the inbox count where it looks, without ready or assigned items", async () => {
  const h = await harness();
  await h.refresh();
  h.state.explicit = false;
  h.state.layout = {
    children: [{ id: "panel", hidden: true, active: "files" }],
  };
  const pr = (number: number, fields: object) => ({
    number,
    author: "ana",
    requested: [],
    draft: false,
    decision: null,
    threads: [],
    checks: { state: "SUCCESS", failed: [] },
    ...fields,
  });
  h.view.cache.set(h.view.repo, {
    repo: "owner/repo",
    viewer: "me",
    prs: [
      pr(1, { checks: { state: "FAILURE", failed: [{ name: "lint" }] }, requested: ["me"] }),
      pr(2, { threads: [{ author: "bo" }] }),
      pr(3, { decision: "APPROVED" }),
    ],
  });
  h.view.render(h.cx);
  assert.equal(h.state.shared.get("github-inbox-count"), 3);
  h.view.linkedAgents = () => [{ number: 1, kinds: ["fix-ci"] }];
  h.view.render(h.cx);
  assert.equal(h.state.shared.get("github-inbox-count"), 2);
});
