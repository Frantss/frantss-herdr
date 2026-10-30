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
  };
  const cx = {
    notify() {},
    spawn(callback: (cx: unknown) => unknown) {
      const task = Promise.resolve().then(() => callback(cx));
      state.tasks.push(task);
      return task;
    },
  };
  const context = vm.createContext({ localStorage: { setItem() {} } });
  const unused = () => assert.fail("Unexpected UI host call");
  const natives = {
    "gpui-kit": { View: class {}, div: unused, svg: unused, image: unused },
    "gpui-base": { v_flex: unused, h_flex: unused, Button: {} },
    herdr: {
      spaces: () => state.spaces,
      panes: () => [],
      focused: () => null,
      props: () => state.place,
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
                stdout: JSON.stringify({ owner: { login: "owner" }, name: "repo" }),
                stderr: "",
              };
        }
        assert.deepEqual(Array.from(args.slice(0, 2)), ["api", "graphql"]);
        return {
          code: 0,
          stdout: JSON.stringify({
            data: {
              viewer: { login: "me" },
              repository: { nameWithOwner: `${on ?? "local"}/${cwd}`, pullRequests: { nodes: [] } },
            },
          }),
          stderr: "",
        };
      },
      hc: unused,
      run: unused,
      theme: unused,
      layout: unused,
      agents: unused,
      terminals: unused,
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
    cache: new Map(),
    errors: new Map(),
    inflight: new Set(),
    place: state.place,
    context: JSON.stringify(state.place),
  });
  return {
    state,
    view,
    cx,
    async refresh() {
      view.refreshAll(cx);
      for (let i = 0; i < state.tasks.length; i++) await state.tasks[i];
    },
    requests: () => state.calls.filter((call) => call.command === "gh" && call.args[0] === "repo"),
  };
}

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

test("a failed repository does not repeat within its cycle or prevent later repositories loading", async () => {
  const h = await harness();
  h.state.failures.set(placeKey("/repo/worktree"), "GitHub is unavailable");
  await h.refresh();
  assert.equal(h.requests().length, 3);
  assert.equal(h.view.error, "GitHub is unavailable");
  assert.equal(h.view.cache.size, 2);
  h.state.failures.clear();
  await h.refresh();
  assert.equal(h.requests().length, 6);
  assert.equal(h.view.error, null);
  assert.equal(h.view.cache.size, 3);
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
