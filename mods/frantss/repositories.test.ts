import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const place = (cwd: string, on: string | null = null) => JSON.stringify([on, cwd]);
const deferred = () => {
  let resolve: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve() };
};

async function harness() {
  const source = stripTypeScriptTypes(await readFile(new URL("main.ts", import.meta.url), "utf8"));
  const state = {
    calls: [] as { args: string[]; cwd: string; on: string | null }[],
    repositories: new Map([
      [place("/repo"), { repo: "/repo/.git", top: "/repo" }],
      [place("/worktree"), { repo: "/repo/.git", top: "/worktree" }],
      [place("/repo", "build"), { repo: "/remote/.git", top: "/remote" }],
    ]),
    holds: new Map<string, Promise<void>>(),
    failures: new Map<string, "common" | "top">(),
  };
  const context = vm.createContext({});
  const unused = () => assert.fail("Unexpected native call");
  const natives = {
    "gpui-kit": { View: class {}, div: unused, svg: unused, image: unused },
    "gpui-base": { h_flex: unused, v_flex: unused, Button: { new: unused } },
    herdr: {
      notify: () => {},
      agents: unused,
      spaces: unused,
      panes: unused,
      props: unused,
      run: unused,
      theme: unused,
      settings: unused,
      setAgentOrder: unused,
      openOverlay: unused,
      shared: unused,
      setShared: unused,
      pickFolder: unused,
      knownAgents: unused,
      hc: unused,
      exec: async (
        command: string,
        args: string[],
        options: { cwd: string; on: string | null },
      ) => {
        assert.equal(command, "git");
        const { cwd, on } = options;
        state.calls.push({ args: Array.from(args), cwd, on });
        const key = place(cwd, on),
          common = args.includes("--git-common-dir");
        if (common) await state.holds.get(key);
        if (state.failures.get(key) === (common ? "common" : "top"))
          throw new Error("Disconnected");
        const data = state.repositories.get(key);
        return data
          ? { code: 0, stdout: `${common ? data.repo : data.top}\n`, stderr: "" }
          : { code: 128, stdout: "", stderr: "Not a repository" };
      },
    },
  };
  async function generation() {
    const module = new vm.SourceTextModule(source, { context });
    // main.ts's own modules (closed.ts) import nothing at run time.
    await module.link(async (name) => {
      if (name.startsWith("./"))
        return new vm.SourceTextModule(
          stripTypeScriptTypes(await readFile(new URL(name, import.meta.url), "utf8")),
          { context },
        );
      const values = natives[name];
      return new vm.SyntheticModule(
        Object.keys(values),
        function () {
          for (const [key, value] of Object.entries(values)) this.setExport(key, value);
        },
        { context },
      );
    });
    await module.evaluate();
    const Frantss = (module.namespace as { default: new () => any }).default;
    return () => {
      const view = new Frantss();
      view.repos = {};
      view.checkouts = {};
      return view;
    };
  }
  const instance = await generation();
  function taskContext() {
    const tasks: Promise<unknown>[] = [];
    let notifications = 0;
    const inner = { notify: () => notifications++ };
    const outer = {
      notify: () => assert.fail("Used the caller context after spawning"),
      spawn(callback) {
        const task = Promise.resolve().then(() => callback(inner));
        tasks.push(task);
        return task;
      },
    };
    return { outer, tasks, notifications: () => notifications };
  }
  return { state, instance, generation, taskContext };
}

test("repository discovery shares one in-flight Git pair and notifies each instance through its task context", async () => {
  const h = await harness();
  const first = h.instance(),
    second = h.instance();
  const a = h.taskContext(),
    b = h.taskContext(),
    held = deferred();
  h.state.holds.set(place("/repo"), held.promise);
  first.lookUp(place("/repo"), a.outer);
  second.lookUp(place("/repo"), b.outer);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  // Both calls of the pair run at once.
  assert.equal(h.state.calls.length, 2);
  held.resolve();
  await Promise.all([...a.tasks, ...b.tasks]);
  assert.equal(h.state.calls.length, 2);
  for (const view of [first, second]) {
    assert.equal(view.repos[place("/repo")], "/repo/.git");
    assert.equal(view.checkouts[place("/repo")], "main");
  }
  assert.equal(a.notifications(), 1);
  assert.equal(b.notifications(), 1);
});

test("repository discovery preserves worktree classification and machine identity", async () => {
  const h = await harness();
  const view = h.instance(),
    cx = h.taskContext();
  for (const key of [place("/repo"), place("/worktree"), place("/repo", "build")])
    view.lookUp(key, cx.outer);
  await Promise.all(cx.tasks);
  assert.equal(h.state.calls.length, 6);
  assert.equal(view.checkouts[place("/repo")], "main");
  assert.equal(view.checkouts[place("/worktree")], "linked");
  assert.equal(view.repos[place("/repo", "build")], "/remote/.git");
  assert.equal(view.checkouts[place("/repo", "build")], "main");
});

test("completed results are shared within a module generation and reloaded in the next", async () => {
  const h = await harness();
  const first = h.instance(),
    a = h.taskContext();
  first.lookUp(place("/repo"), a.outer);
  await Promise.all(a.tasks);
  const second = h.instance(),
    b = h.taskContext();
  second.lookUp(place("/repo"), b.outer);
  await Promise.all(b.tasks);
  assert.equal(h.state.calls.length, 2);
  assert.equal(second.repos[place("/repo")], "/repo/.git");
  const nextInstance = await h.generation(),
    next = nextInstance(),
    c = h.taskContext();
  next.lookUp(place("/repo"), c.outer);
  await Promise.all(c.tasks);
  assert.equal(h.state.calls.length, 4);
  assert.equal(next.repos[place("/repo")], "/repo/.git");
});

test("lookup errors keep successful repository discovery and preserve the non-repository fallback", async () => {
  const h = await harness();
  h.state.failures.set(place("/repo"), "top");
  h.state.failures.set(place("/worktree"), "common");
  const view = h.instance(),
    cx = h.taskContext();
  for (const key of [place("/repo"), place("/worktree"), place("/outside")])
    view.lookUp(key, cx.outer);
  await Promise.all(cx.tasks);
  assert.equal(view.repos[place("/repo")], "/repo/.git");
  assert.equal(view.checkouts[place("/repo")] ?? null, null);
  assert.equal(view.repos[place("/worktree")], null);
  assert.equal(view.repos[place("/outside")], null);
  assert.equal(view.checkouts[place("/outside")], null);
  assert.equal(cx.notifications(), 3);
});
