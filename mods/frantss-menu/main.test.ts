import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import type { items as menuItems } from "./main.ts";

const records = [
  { address: "t1", cwd: "/repo" },
  { address: "t2", cwd: "/repo", parent: "t1" },
  { address: "t3", cwd: "/repo" },
];

// Where the menu's scroll handle was told to bring an entry on screen.
const scrolled: number[] = [];

async function load(overrides = {}, icons: string[] = []) {
  const context = vm.createContext({});
  const empty = () => {};
  // GPUI builds a virtual list's rows during layout, where the runtime refuses handlers.
  let lazy = false;
  const element = () => {
    const state: any = { childNodes: [], handlers: {}, elementId: undefined };
    const node = new Proxy(state, {
      get: (target, key) => {
        if (key in target) return target[key];
        return (...args) => {
          if (lazy && String(key).startsWith("on_"))
            throw new Error(`${String(key)} inside a virtual list row`);
          if (key === "when" && args[0]) args[1](node);
          if (key === "child") state.childNodes.push(args[0]);
          if (key === "id") state.elementId = args[0];
          if (String(key).startsWith("on_")) state.handlers[key] = args.at(-1);
          return node;
        };
      },
    });
    return node;
  };
  const natives: Record<string, Record<string, unknown>> = {
    "gpui-kit": {
      View: class {},
      div: element,
      svg: (path) => {
        icons.push(path);
        return element();
      },
    },
    "gpui-base": {
      v_flex: element,
      h_flex: element,
      Scrollbar: { vertical: element },
      v_virtual_list: (id, count, sizes, key, draw) => {
        assert.equal(sizes.length, count, "One height per entry");
        const keys = Array.from({ length: count }, (_, index) => key(index));
        assert.equal(new Set(keys).size, count, "Entry keys are unique");
        const list = element().id(id);
        lazy = true;
        try {
          for (const row of draw({ start: 0, end: count })) list.child(row);
        } finally {
          lazy = false;
        }
        return list;
      },
      VirtualListScrollHandle: {
        new: () => ({ scroll_to_item: (index) => scrolled.push(index), release() {} }),
      },
      Button: { new: (id) => element().id(id) },
      Input: { new: element },
      InputState: {
        new: ({ value }) => ({
          text: value,
          handlers: {} as Record<string, () => void>,
          value() {
            return this.text;
          },
          set_selected_range() {},
          focus() {},
          on(event, callback) {
            this.handlers[event] = callback;
          },
        }),
      },
    },
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
      settings: () => ({}),
      machines: () => [{ name: null, layout: "ready" }],
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
  return module.namespace as {
    default: new () => any;
    items: typeof menuItems;
  };
}

const paneMenu = async (terminal: string) =>
  JSON.parse(
    JSON.stringify((await load()).items({ tab: "pane", target: { pane: "p1", terminal } }, null)),
  ) as [string, string, Record<string, string>][];

test("a clicked pane offers separate pane and tab rename actions without selecting it", async () => {
  for (const prefix of ["", "remote/"]) {
    const pane = { pane: `${prefix}p2`, tab: `${prefix}tab2`, title: "Clicked" };
    const target = { pane: pane.pane, terminal: `${prefix}t2` };
    const overlays = [];
    const module = await load({
      props: () => ({ tab: "pane", target }),
      panes: () => [
        { pane: `${prefix}p1`, tab: `${prefix}tab1`, title: "Focused", focused: true },
        pane,
      ],
      spaces: () => [
        {
          id: `${prefix}s1`,
          tabs: [
            { id: `${prefix}tab1`, named: true, name: "Focused tab", active: true },
            { id: pane.tab, named: true, name: "Tab name" },
          ],
        },
      ],
      openOverlay: (value) => overlays.push(JSON.parse(JSON.stringify(value))),
      run: () => assert.fail("Opening rename must not select a pane or tab"),
    });
    const entries = module.items({ tab: "pane", target }, null);
    const view = new module.default();
    const paneIndex = entries.findIndex(([label]) => label === "Rename pane");
    const tabIndex = entries.findIndex(([label]) => label === "Rename tab");
    assert.ok(paneIndex >= 0, "Pane menu must offer Rename pane");
    assert.ok(tabIndex >= 0, "Pane menu must offer Rename tab");
    view.choose(paneIndex, {} as Parameters<typeof view.choose>[1]);
    assert.equal(overlays[0].mod, "frantss-menu");
    assert.equal(overlays[0].kind, "dialog");
    assert.equal(overlays[0].props.target.pane, pane.pane);
    view.choose(tabIndex, {} as Parameters<typeof view.choose>[1]);
    assert.equal(overlays[1].mod, "prompt");
    assert.equal(overlays[1].props.value, "Tab name");
    assert.deepEqual(overlays[1].props.command, { name: "tab.rename", args: { id: pane.tab } });
  }
});

test("the pane name dialog saves only the clicked pane and reads its persisted name on reopen", async () => {
  const pane = { pane: "remote/p2", tab: "remote/tab2", title: "Program title", terminal: null };
  let saved = { p1: "Other pane", [pane.pane]: "Existing NAME" };
  const closed = [];
  const module = await load({
    props: () => ({ tab: "rename-pane", overlay: "rename-1", target: { pane: pane.pane } }),
    panes: () => [pane],
    shared: () => saved,
    setShared: (_key, value) => {
      saved = JSON.parse(JSON.stringify(value));
    },
    closeOverlay: (id) => closed.push(id),
    run: () => assert.fail("A pane alias must not issue a native rename"),
  });
  const view = new module.default();
  const cx = { focus_handle: () => ({ focus() {} }) } as Parameters<typeof view.init>[1];
  view.init({}, cx);
  assert.equal(view.input.value(), "Existing NAME");
  (view.input as unknown as { text: string }).text = "New NAME";
  (view.input as unknown as { handlers: Record<string, () => void> }).handlers.submit();
  assert.deepEqual(saved, { p1: "Other pane", [pane.pane]: "New NAME" });
  assert.deepEqual(closed, ["rename-1"]);
  const reopened = new module.default();
  reopened.init({}, cx);
  assert.equal(reopened.input.value(), "New NAME");
  (reopened.input as unknown as { text: string }).text = "";
  (reopened.input as unknown as { handlers: Record<string, () => void> }).handlers.submit();
  assert.deepEqual(saved, { p1: "Other pane" });
});

test("Cancel and Esc discard pane name edits; the Save button persists them", async () => {
  const pane = { pane: "p1", title: "Live title", tab: "tab1" };
  let saved = { p1: "Original" };
  const closed = [];
  const module = await load({
    props: () => ({ tab: "rename-pane", overlay: "rename-1", target: { pane: pane.pane } }),
    panes: () => [pane],
    shared: () => saved,
    setShared: (_key, value) => {
      saved = JSON.parse(JSON.stringify(value));
    },
    theme: () => ({}),
    closeOverlay: (id) => closed.push(id),
  });
  const find = (node, id) =>
    node?.elementId === id
      ? node
      : (node?.childNodes ?? []).map((child) => find(child, id)).find(Boolean);
  const cx = { focus_handle: () => ({ focus() {} }), stop_propagation() {} };
  for (const action of ["Cancel", "Esc", "Save"]) {
    const view = new module.default();
    view.init({}, cx as Parameters<typeof view.init>[1]);
    (view.input as unknown as { text: string }).text = "Edited";
    const tree = view.render({} as Parameters<typeof view.render>[0]) as any;
    if (action === "Esc") tree.handlers.on_key_down({ key: "escape" }, cx);
    else find(tree, action === "Save" ? "rename-save" : "rename-cancel").handlers.on_click({}, cx);
    assert.equal(saved.p1, action === "Save" ? "Edited" : "Original");
  }
  assert.deepEqual(closed, ["rename-1", "rename-1", "rename-1"]);
});

test("the pane context menu gives Split down its downward-arrow icon", async () => {
  const icons: string[] = [];
  const module = await load(
    {
      props: () => ({ tab: "pane", target: { pane: "p1" } }),
      theme: () => ({}),
    },
    icons,
  );
  const view = new module.default();
  view.render({} as Parameters<typeof view.render>[0]);
  assert.deepEqual(icons.slice(0, 2), [
    "mods/workspace-chrome/panel-right.svg",
    "mods/frantss/split-down.svg",
  ]);
});

test("an agent's pane menu starts with its actions and can send it back", async () => {
  assert.deepEqual(await paneMenu("t1"), [
    ["Peek", "terminal.peek", { terminal: "t1" }],
    ["Pin", "terminal.pin", { terminal: "t1", pinned: true }],
    ["Reply…", "reply", { terminal: "t1" }],
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

test("Pin and Unpin use the native command for the clicked remote agent", async () => {
  for (const tab of ["pane", "terminal"]) {
    for (const pinned of [false, true]) {
      const commands = [];
      const target = { pane: "remote/p1", terminal: "remote/t1" };
      const module = await load({
        props: () => ({ tab, target }),
        agents: () => [{ address: target.terminal, status: "idle", pinned }],
        terminals: () => [{ address: target.terminal, cwd: "/repo" }],
        run: (...args) => commands.push(JSON.parse(JSON.stringify(args))),
        setShared: () => assert.fail("Pinning must not write local state"),
        hc: () => assert.fail("Pinning uses the native app command"),
      });
      const menu = module.items({ tab, target }, null);
      const index = menu.findIndex(([, command]) => command === "terminal.pin");
      assert.equal(menu[index][0], pinned ? "Unpin" : "Pin");
      const view = new module.default();
      view.choose(index, {} as Parameters<typeof view.choose>[1]);
      assert.deepEqual(commands, [
        ["terminal.pin", { terminal: target.terminal, pinned: !pinned }],
      ]);
    }
  }
});

test("unread uses a fresh core turn and leaves status and local state to Herdr", async () => {
  const calls = [];
  const tasks: Promise<unknown>[] = [];
  const agent = { address: "remote/t1", status: "idle", seq: 999, pinned: false };
  const target = { terminal: agent.address, pane: "remote/p1" };
  const module = await load({
    props: () => ({ tab: "pane", target }),
    agents: () => [agent],
    terminals: () => [{ address: agent.address, turn: 2 }],
    shared: () => assert.fail("Unread must not read local state"),
    setShared: () => assert.fail("Unread must not write local state"),
    run: () => assert.fail("No terminal.unread app command exists"),
    hc: async (args) => {
      calls.push(Array.from(args));
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          address: agent.address,
          state: "live",
          status: { state: "idle" },
          turn: 7,
        }),
      };
    },
  });
  const index = module
    .items({ tab: "pane", target }, null)
    .findIndex(([, command]) => command === "unread");
  const view = new module.default();
  const cx = {
    spawn: (task: () => Promise<unknown>) => {
      tasks.push(task());
    },
  };
  view.choose(index, cx as unknown as Parameters<typeof view.choose>[1]);
  await Promise.all(tasks);
  assert.deepEqual(calls, [
    ["get", agent.address],
    ["label", agent.address, "herdr.seen=6"],
  ]);
  assert.equal(agent.status, "idle");
});

test("only idle agents offer mark unread; native statuses stay unchanged", async () => {
  for (const status of ["idle", "done", "working", "blocked", "error"]) {
    const agent = { address: "t1", status };
    const module = await load({ agents: () => [agent] });
    const menu = module.items({ tab: "pane", target: { terminal: "t1", pane: "p1" } }, null);
    assert.equal(
      menu.some(([, command]) => command === "unread"),
      status === "idle",
    );
    assert.equal(agent.status, status);
  }
});

test("only a working agent offers Interrupt, as the rail's hover actions do", async () => {
  for (const status of ["working", "blocked", "idle", "done", null]) {
    const module = await load({ agents: () => [{ address: "t1", status }] });
    for (const tab of ["pane", "terminal"]) {
      const menu = module.items({ tab, target: { pane: "p1", terminal: "t1" } }, null);
      assert.equal(
        menu.some(([, command]) => command === "interrupt"),
        status === "working",
        `${tab} menu, ${status}`,
      );
    }
  }
});

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const keyContext = { stop_propagation() {}, notify() {} };
const press = (view: { render(cx: unknown): unknown }, ...keys: string[]) => {
  for (const key of keys)
    (view.render({}) as any).handlers.on_key_down({ key, modifiers: {} }, keyContext);
};
const findId = (node, id) =>
  node?.elementId === id
    ? node
    : (node?.childNodes ?? []).map((child) => findId(child, id)).find(Boolean);
// A press on an entry, as the virtual list reports it: by the entry's key.
const click = (view: { render(cx: unknown): unknown }, key: string) =>
  findId(view.render({}), "menu-items").handlers.on_item_click(key, keyContext);

test("a pane that stands for its space acts on that space by id, never on the focused one", async () => {
  const commands = [],
    overlays = [];
  const target = {
    pane: "p2",
    terminal: "t3",
    space: "s2",
    spaceName: "feature/login",
    checkout: "linked" as const,
  };
  const module = await load({
    props: () => ({ tab: "pane", target }),
    panes: () => [
      { pane: "p1", tab: "tab1", focused: true },
      { pane: "p2", tab: "tab2", title: "Work" },
    ],
    spaces: () => [
      { id: "s1", active: true, name: "Focused", named: true, tabs: [{ id: "tab1" }] },
      { id: "s2", name: "repo", named: false, branch: "other", tabs: [{ id: "tab2" }] },
    ],
    run: (...args) => commands.push(plain(args)),
    openOverlay: (spec) => overlays.push(plain(spec)),
    theme: () => ({}),
  });
  const view = new module.default();
  view.init(
    {},
    { focus_handle: () => ({ focus() {} }), spawn: () => assert.fail("Known checkout") },
  );
  const menu = plain(module.items({ tab: "pane", target }, view.git));
  const close = menu.findIndex(([label]) => label === "Close pane");
  assert.deepEqual(menu.slice(close + 1), [
    ["Space: feature/login", "heading", {}],
    ["Rename space", "rename", { what: "space", id: "s2", name: "feature/login" }],
    ["New tab", "tab.new", { space: "s2" }],
    ["New worktree", "worktree", { space: "s2", action: "new" }],
    ["Open worktree", "worktree", { space: "s2", action: "open" }],
    ["Remove worktree", "worktree", { space: "s2", action: "remove" }],
    ["Close space", "space.close", { id: "s2" }],
  ]);
  click(view, "heading:Space: feature/login");
  assert.deepEqual(commands, [], "The heading does nothing");
  click(view, "rename:Rename space");
  assert.equal(overlays[0].props.value, "feature/login");
  assert.deepEqual(overlays[0].props.command, { name: "space.rename", args: { id: "s2" } });
  scrolled.length = 0;
  press(view, "end");
  assert.deepEqual(scrolled, [menu.length - 1], "End brings the last space action on screen");
  click(view, "space.close:Close space");
  assert.deepEqual(commands, [["space.close", { id: "s2" }]]);
  const without = module.items({ tab: "pane", target: { pane: "p2", terminal: "t3" } }, "linked");
  assert.equal(without.at(-1)[1], "pane.close", "Other pane menus get no space actions");
});

test("without a checkout the parent space's own folder is asked, and its shown name is used", async () => {
  const asked = [];
  const tasks = [];
  const target = { pane: "p2", space: "s2" };
  const module = await load({
    props: () => ({ tab: "pane", target }),
    panes: () => [{ pane: "p2", tab: "tab2", cwd: "/wt" }],
    spaces: () => [
      { id: "s1", active: true, folder: "/focused", tabs: [] },
      {
        id: "s2",
        name: "repo",
        named: false,
        branch: "feat",
        folder: "/wt",
        tabs: [{ id: "tab2" }],
      },
    ],
    exec: async (_command, args, options) => {
      asked.push(options.cwd);
      return {
        code: 0,
        stdout: args[0] === "rev-parse" && args[1] === "--show-toplevel" ? "/wt\n" : "/repo/.git\n",
      };
    },
  });
  const view = new module.default();
  view.init({}, { focus_handle: () => ({ focus() {} }), spawn: (task) => tasks.push(task) });
  await tasks[0]({ notify() {} });
  assert.equal(view.git, "linked");
  assert.deepEqual(asked, ["/wt", "/wt"]);
  const menu = plain(module.items({ tab: "pane", target }, view.git));
  assert.ok(menu.some(([label]) => label === "Space: feat"));
  assert.ok(menu.some(([label, , args]) => label === "Remove worktree" && args.space === "s2"));
});

test("Resume needs a saved folder; history stays available and the explanation does nothing", async () => {
  const commands = [],
    overlays = [],
    closed = [];
  const target = { terminal: "t9", name: "fix tabs", app: "codex" };
  const module = await load({
    props: () => ({ tab: "closed", overlay: "menu-1", target }),
    run: (...args) => commands.push(plain(args)),
    openOverlay: (spec) => overlays.push(plain(spec)),
    closeOverlay: (id) => closed.push(id),
    theme: () => ({}),
  });
  for (const cwd of [undefined, ""]) {
    const menu = plain(module.items({ tab: "closed", target: { ...target, cwd } }, null));
    assert.deepEqual(
      menu.map(([label, command]) => [label, command]),
      [
        ["View history", "history"],
        ["Resume unavailable: no saved folder", "note"],
        ["Forget history…", "forget-history"],
      ],
    );
  }
  const view = new module.default();
  view.init({}, { focus_handle: () => ({ focus() {} }), spawn() {} });
  view.choose(1, {} as Parameters<typeof view.choose>[1]);
  assert.deepEqual([commands, closed], [[], []]);
  // The keys pass over the explanation.
  press(view, "down", "enter");
  assert.equal(overlays[0].props.command.name, "frantss.forget-history:t9");
  press(view, "up", "enter");
  assert.equal(commands.at(-1)[0], "space.new");
  assert.deepEqual(commands.at(-1)[1].argv, ["hc", "read", "t9", "--lines", "100000"]);
});

test("the keyboard keeps the selected item when git adds worktree items above Close", async () => {
  const commands = [];
  const tasks = [];
  const module = await load({
    props: () => ({ tab: "space", target: { id: "s1" } }),
    spaces: () => [{ id: "s1", folder: "/repo", tabs: [] }],
    exec: async (_command, args) => ({
      code: 0,
      stdout: args[1] === "--show-toplevel" ? "/repo\n" : "/repo/.git\n",
    }),
    run: (...args) => commands.push(plain(args)),
    theme: () => ({}),
  });
  const view = new module.default();
  view.init({}, { focus_handle: () => ({ focus() {} }), spawn: (task) => tasks.push(task) });
  scrolled.length = 0;
  press(view, "end");
  await tasks[0]({ notify() {} });
  assert.equal(view.git, "main");
  press(view, "enter");
  assert.deepEqual(commands, [["space.close", { id: "s1" }]]);
  press(view, "home", "down", "space");
  assert.deepEqual(commands.at(-1), ["tab.new", { space: "s1" }]);
  press(view, "up", "up", "enter");
  assert.deepEqual(commands.at(-1), ["space.close", { id: "s1" }], "Up wraps to the last item");
  // Each move brings its item on screen, at its place in the list git grew: Close moved from 2 to 4.
  assert.deepEqual(scrolled, [2, 0, 1, 0, 4]);
});

test("a tab's menu, and a lone pane's, settle or restore the tab; a split pane's does not", async () => {
  for (const settled of [false, true]) {
    const tab = { id: "tab1", name: "Work", named: true, settled };
    const module = await load({
      spaces: () => [{ id: "s1", tabs: [tab] }],
      panes: () => [{ pane: "p1", tab: "tab1" }],
    });
    const expected = settled
      ? ["Restore tab", "tab.unsettle", { id: "tab1" }]
      : ["Settle tab", "tab.settle", { id: "tab1" }];
    for (const menu of [
      module.items({ tab: "tab", target: { id: "tab1", space: "s1", name: "Work" } }, null),
      module.items({ tab: "pane", target: { pane: "p1" } }, null),
    ])
      assert.deepEqual(
        plain(menu.find(([, command]) => command.startsWith("tab.") && command.includes("settle"))),
        expected,
      );
  }
  const split = await load({
    spaces: () => [{ id: "s1", tabs: [{ id: "tab1", settled: false }] }],
    panes: () => [
      { pane: "p1", tab: "tab1" },
      { pane: "p2", tab: "tab1" },
    ],
  });
  assert.ok(
    !split
      .items({ tab: "pane", target: { pane: "p1" } }, null)
      .some(([, command]) => command === "tab.settle"),
  );
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
    ["terminal.peek", "terminal.pin", "reply", "copy", "copy", "kill", "terminal.keep"],
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
  const piMenu = module.items({ tab: "closed", target: { ...target, app: "pi" } }, null);
  assert.deepEqual(
    Array.from(piMenu, ([label]) => label),
    ["View history", "Resume…", "Forget history…"],
  );
  for (const app of [null, "unknown"]) {
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

test("resuming Codex from its context menu keeps terminal execution isolated", async () => {
  const commands = [];
  const module = await load({
    props: () => ({
      tab: "closed",
      overlay: "menu-1",
      target: { terminal: "t9", cwd: "/old", app: "codex" },
    }),
    run: (...args) => commands.push(JSON.parse(JSON.stringify(args))),
    spaces: () => [{ id: "s1", folder: "/old", tabs: [] }],
  });
  const view = new module.default();
  view.choose(1, {} as Parameters<typeof view.choose>[1]);
  assert.deepEqual(commands, [
    ["space.select", { id: "s1" }],
    ["tab.new", { space: "s1", folder: "/old", argv: ["codex", "--no-daemon", "resume"] }],
  ]);
});
