import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const records = [
  { address: "t1", cwd: "/repo" },
  { address: "t2", cwd: "/repo", parent: "t1" },
  { address: "t3", cwd: "/repo" },
];

async function load(overrides = {}) {
  const context = vm.createContext({});
  const empty = () => {};
  const natives: Record<string, Record<string, unknown>> = {
    "gpui-kit": { View: class {}, div: empty, svg: empty },
    "gpui-base": { v_flex: empty, h_flex: empty },
    herdr: {
      run: empty,
      props: empty,
      agents: () => [{ address: "t1" }, { address: "t2" }],
      hc: empty,
      notify: empty,
      closeOverlay: empty,
      openOverlay: empty,
      theme: empty,
      keys: () => [],
      terminals: () => records,
      spaces: () => [],
      panes: () => [],
      exec: empty,
      shared: empty,
      setShared: empty,
      ...overrides,
    },
  };
  const module = new vm.SourceTextModule(
    stripTypeScriptTypes(await readFile(new URL("main.ts", import.meta.url), "utf8")),
    { context },
  );
  await module.link(async (name) => {
    if (name.startsWith("./"))
      return new vm.SourceTextModule(
        stripTypeScriptTypes(await readFile(new URL(name, import.meta.url), "utf8")),
        { context },
      );
    const values = natives[name];
    assert.ok(values, `Unexpected native import ${name}`);
    return new vm.SyntheticModule(
      Object.keys(values),
      function () {
        for (const [key, value] of Object.entries(values)) this.setExport(key, value);
      },
      { context },
    );
  });
  await module.evaluate();
  return module.namespace as typeof import("./main.ts");
}

const paneMenu = async (terminal: string) =>
  JSON.parse(
    JSON.stringify((await load()).items({ tab: "pane", target: { pane: "p1", terminal } }, null)),
  ) as [string, string, Record<string, string>][];

test("an agent's pane menu starts with its actions and can send it back", async () => {
  assert.deepEqual(await paneMenu("t1"), [
    ["Peek", "terminal.peek", { terminal: "t1" }],
    ["Reply…", "reply", { terminal: "t1" }],
    ["Interrupt", "interrupt", { terminal: "t1" }],
    ["Copy address", "copy", { text: "t1" }],
    ["Copy folder", "copy", { text: "/repo" }],
    ["Kill…", "kill", { terminal: "t1" }],
    ["Split right", "pane.split", { direction: "right", pane: "p1" }],
    ["Split down", "pane.split", { direction: "down", pane: "p1" }],
    ["Zoom", "pane.zoom", { pane: "p1" }],
    ["Send right-clicks to pane", "terminal.right_click", { terminal: "t1", to: "program" }],
    ["Send back", "terminal.park", { terminal: "t1" }],
    ["Close pane", "pane.close", { pane: "p1" }],
  ]);
});

test("a kept sub-agent goes back to its parent, and a plain terminal gets no agent actions", async () => {
  assert.deepEqual(
    (await paneMenu("t2")).find(([, command]) => command === "terminal.park"),
    ["Send back to t1", "terminal.park", { terminal: "t2" }],
  );
  const plain = (await paneMenu("t3")).map(([, command]) => command);
  assert.deepEqual(plain, [
    "pane.split",
    "pane.split",
    "pane.zoom",
    "terminal.right_click",
    "pane.close",
  ]);
});

test("an idle agent's menu can mark it unread", async () => {
  const module = await load({ agents: () => [{ address: "t1", status: "idle" }] });
  const menu = JSON.parse(
    JSON.stringify(module.items({ tab: "pane", target: { pane: "p1", terminal: "t1" } }, null)),
  );
  assert.deepEqual(menu[1], ["Mark as unread", "unread", { terminal: "t1" }]);
});

test("a space's menu opens a new tab in it, worktrees included", async () => {
  const menu = JSON.parse(
    JSON.stringify((await load()).items({ tab: "space", target: { id: "s1" } }, "linked")),
  ) as [string, string, Record<string, string>][];
  assert.deepEqual(
    menu.map(([, command]) => command),
    ["space.rename", "tab.new", "worktree", "worktree", "worktree", "space.close"],
  );
  assert.deepEqual(menu[1], ["New tab", "tab.new", { space: "s1" }]);
});

const terminalMenu = async (target: Record<string, string>) =>
  JSON.parse(JSON.stringify((await load()).items({ tab: "terminal", target }, null))) as [
    string,
    string,
    Record<string, string>,
  ][];

test("a live terminal without a pane gets the agent actions and can be kept as a tab", async () => {
  const menu = await terminalMenu({ terminal: "t2" });
  assert.deepEqual(
    menu.map(([, command]) => command),
    ["terminal.peek", "reply", "interrupt", "copy", "copy", "kill", "terminal.keep"],
  );
});

test("a finished terminal can only be copied or removed", async () => {
  assert.deepEqual(await terminalMenu({ terminal: "t9", cwd: "/old" }), [
    ["Copy address", "copy", { text: "t9" }],
    ["Copy folder", "copy", { text: "/old" }],
    ["Remove", "remove", { terminal: "t9" }],
  ]);
});

test("a recently closed agent offers history, a supported session picker, and confirmed forgetting", async () => {
  const module = await load();
  const target = { terminal: "t9", cwd: "/old", name: "fix tabs", app: "codex" };
  const menu = JSON.parse(JSON.stringify(module.items({ tab: "closed", target }, null)));
  assert.deepEqual(menu, [
    ["View history", "history", { terminal: "t9", cwd: "/old", name: "fix tabs" }],
    ["Resume…", "resume", { cwd: "/old", app: "codex" }],
    ["Forget history…", "forget-history", { terminal: "t9", name: "fix tabs" }],
  ]);
  for (const app of [null, "pi"]) {
    const items = module.items({ tab: "closed", target: { ...target, app } }, null);
    assert.deepEqual(
      Array.from(items, ([label]) => label),
      ["View history", "Forget history…"],
    );
  }
});

test("closed menu actions open history and resume in the local folder, and only ask to forget", async () => {
  const commands = [],
    overlays = [],
    closed = [];
  const module = await load({
    props: () => ({
      tab: "closed",
      overlay: "menu-1",
      target: { terminal: "t9", cwd: "/old", name: "fix tabs", app: "claude-code" },
    }),
    run: (...args) => commands.push(JSON.parse(JSON.stringify(args))),
    openOverlay: (spec) => overlays.push(JSON.parse(JSON.stringify(spec))),
    closeOverlay: (id) => closed.push(id),
    hc: () => assert.fail("Forgetting must wait for confirmation"),
    spaces: () => [{ id: "s1", folder: "/old", tabs: [] }],
  });
  const view = new module.default();
  const cx = {} as Parameters<typeof view.choose>[1];
  view.choose(0, cx);
  view.choose(1, cx);
  assert.deepEqual(commands, [
    ["space.select", { id: "s1" }],
    [
      "tab.new",
      {
        space: "s1",
        folder: "/old",
        argv: ["hc", "read", "t9", "--lines", "100000"],
        name: "fix tabs history",
      },
    ],
    ["space.select", { id: "s1" }],
    ["tab.new", { space: "s1", folder: "/old", argv: ["claude", "--resume"] }],
  ]);
  view.choose(2, cx);
  assert.deepEqual(closed, ["menu-1", "menu-1", "menu-1"]);
  assert.equal(commands.length, 4);
  assert.equal(overlays[0].mod, "confirm");
  assert.equal(overlays[0].props.command.name, "frantss.forget-history:t9");
});
