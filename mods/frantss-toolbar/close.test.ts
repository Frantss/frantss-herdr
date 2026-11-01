import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

type Pane = { pane: string; tab: string; terminal: string | null; focused: boolean; mod?: string };

async function closeFromShortcut({
  panes = [
    { pane: "p1", tab: "t1", terminal: "term1", focused: true },
    { pane: "p2", tab: "t1", terminal: "term2", focused: false },
  ] as Pane[],
  focus = { pane: "p2", tab: "t1" },
  active = true,
  tabs = [{ id: "t1", name: "Work", named: true, active: true }],
} = {}) {
  const commands: unknown[][] = [];
  const overlays: any[] = [];
  const tasks: (() => Promise<void>)[] = [];
  const queue = ["close-tab"];
  const unused = () => assert.fail("Unexpected native call");
  const context = vm.createContext({ localStorage: { getItem: () => null } });
  const natives = {
    "gpui-kit": { View: class {}, div: unused, svg: unused },
    "gpui-base": { h_flex: unused, Button: { new: unused } },
    herdr: {
      spaces: () => [{ id: "s1", active, tabs }],
      panes: () => panes,
      focused: () => focus,
      run: (...args) => commands.push(args),
      openOverlay: (spec) => overlays.push(spec),
      nextCommand: async () => queue.shift() ?? new Promise<string>(() => {}),
      theme: unused,
      window: unused,
      shared: unused,
      layout: unused,
      exec: unused,
      watchFolder: unused,
      settings: unused,
      props: unused,
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
    return new vm.SyntheticModule(
      Object.keys(values),
      function () {
        for (const [key, value] of Object.entries(values)) this.setExport(key, value);
      },
      { context },
    );
  });
  await module.evaluate();
  const Toolbar = (module.namespace as { default: new () => any }).default;
  new Toolbar().init(
    {},
    {
      spawn: (task) => tasks.push(task),
      timer: { every: () => {} },
    },
  );
  void tasks[0]();
  await new Promise(setImmediate);
  return { commands: JSON.parse(JSON.stringify(commands)), overlays };
}

test("Cmd+W closes only the focused terminal pane in a split tab without a tab confirmation", async () => {
  const { commands, overlays } = await closeFromShortcut();
  assert.deepEqual(commands, [["pane.close", { pane: "p2" }]]);
  assert.equal(overlays.length, 0);
});

test("Cmd+W closes a focused mod pane in a split tab", async () => {
  const { commands, overlays } = await closeFromShortcut({
    panes: [
      { pane: "p1", tab: "t1", terminal: "term1", focused: false },
      { pane: "p2", tab: "t1", terminal: null, focused: true, mod: "frantss-files" },
    ],
  });
  assert.deepEqual(commands, [["pane.close", { pane: "p2" }]]);
  assert.equal(overlays.length, 0);
});

test("Cmd+W keeps the lone-pane confirmation even when another tab has panes", async () => {
  const { commands, overlays } = await closeFromShortcut({
    panes: [
      { pane: "p1", tab: "t1", terminal: "term1", focused: true },
      { pane: "p2", tab: "t2", terminal: "term2", focused: false },
    ],
    focus: { pane: "p1", tab: "t1" },
  });
  assert.deepEqual(commands, []);
  assert.equal(overlays.length, 1);
  assert.equal(overlays[0].props.title, "Close Work?");
  assert.match(overlays[0].props.detail, /space closes too/);
  assert.equal(
    JSON.stringify(overlays[0].props.command),
    JSON.stringify({
      name: "tab.close",
      args: { id: "t1", confirmed: true },
    }),
  );
});

test("Cmd+W asks before closing the active tab when pane focus is absent or stale", async () => {
  for (const focus of [
    null,
    { pane: null, tab: "t1" },
    { pane: "missing", tab: "t1" },
    { pane: "p2", tab: "t2" },
  ]) {
    const { commands, overlays } = await closeFromShortcut({ focus });
    assert.deepEqual(commands, []);
    assert.equal(overlays.length, 1);
    assert.equal(overlays[0].props.command.name, "tab.close");
    assert.equal(overlays[0].props.command.args.id, "t1");
  }
});

test("Cmd+W never closes a pane belonging to a different tab", async () => {
  const { commands, overlays } = await closeFromShortcut({
    panes: [
      { pane: "p1", tab: "t1", terminal: "term1", focused: false },
      { pane: "p2", tab: "t2", terminal: "term2", focused: true },
    ],
  });
  assert.deepEqual(commands, []);
  assert.equal(overlays[0].props.command.args.id, "t1");
});

test("Cmd+W does nothing without an active tab", async () => {
  for (const options of [{ active: false }, { tabs: [] }]) {
    const { commands, overlays } = await closeFromShortcut(options);
    assert.deepEqual(commands, []);
    assert.equal(overlays.length, 0);
  }
});
