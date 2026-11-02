import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

type ThreadProps = { folder: string; machine?: string | null; space?: string; overlay: string };
type Agent = { key: string; name: string; icon: string; tint: boolean; run: string[] | null };
const terminal: Agent = {
  key: "terminal",
  name: "Terminal",
  icon: "icons/shell.svg",
  tint: true,
  run: null,
};

const unused = () => assert.fail("Unexpected native call");
// Where the picker's scroll handle was told to bring an entry on screen.
const scrolled: number[] = [];
// GPUI builds a virtual list's rows during layout, where the runtime refuses handlers.
let lazy = false;

type ThreadView = {
  local(agent: Agent): unknown;
  init(props: unknown, cx: unknown): void;
  render(): any;
};

async function loadThread(
  herdr: Record<string, unknown>,
  build: () => unknown = unused,
): Promise<new () => ThreadView> {
  const context = vm.createContext({});
  const natives = {
    "gpui-kit": { View: class {}, div: build, svg: build, image: build },
    "gpui-base": {
      h_flex: build,
      v_flex: build,
      Scrollbar: { vertical: build },
      v_virtual_list: (id, count, sizes, key, draw) => {
        assert.equal(sizes.length, count, "One height per entry");
        const keys = Array.from({ length: count }, (_, index) => key(index));
        assert.equal(new Set(keys).size, count, "Entry keys are unique");
        const list = (build() as any).id(id);
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
    },
    herdr: {
      theme: unused,
      knownAgents: unused,
      openOverlay: unused,
      shared: unused,
      setShared: unused,
      ...herdr,
    },
  };
  const module = new vm.SourceTextModule(
    stripTypeScriptTypes(await readFile(new URL("main.ts", import.meta.url), "utf8")),
    { context },
  );
  await module.link(async (name) => {
    if (name.startsWith("./")) {
      return new vm.SourceTextModule(
        stripTypeScriptTypes(await readFile(new URL(name, import.meta.url), "utf8")),
        { context },
      );
    }
    const values = natives[name];
    assert.ok(values, `Unexpected native module: ${name}`);
    return new vm.SyntheticModule(
      Object.keys(values),
      function () {
        for (const [key, value] of Object.entries(values)) this.setExport(key, value);
      },
      { context },
    );
  });
  await module.evaluate();
  return (module.namespace as { default: new () => ThreadView }).default;
}

async function local(props: ThreadProps, agent: Agent = terminal) {
  const events: unknown[][] = [];
  const Thread = await loadThread({
    props: () => props,
    closeOverlay: (...args: unknown[]) => events.push(["closeOverlay", ...args]),
    run: (...args: unknown[]) => events.push(["run", ...args]),
  });
  new Thread().local(agent);
  return JSON.parse(JSON.stringify(events));
}

// A node that records its id, children and handlers, and answers every builder call with itself.
function element() {
  const node: any = { childNodes: [], handlers: {} };
  const proxy = new Proxy(node, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "then") return undefined;
      return (...args) => {
        if (lazy && String(key).startsWith("on_"))
          throw new Error(`${String(key)} inside a virtual list row`);
        if (key === "id") node.id = args[0];
        else if (key === "accessibility_label") node.label = args[0];
        else if (key === "when") {
          if (args[0]) args[1](proxy);
        } else if (key === "child") node.childNodes.push(args[0]);
        else if (key === "children") node.childNodes.push(...args[0]);
        else if (String(key).startsWith("on_")) node.handlers[key] = args.at(-1);
        return proxy;
      };
    },
  });
  return proxy;
}

const baseProps = { folder: "/checkout with spaces", overlay: "thread-popup" };

test("Local creates a space on the supplied remote machine when no space exists", async () => {
  assert.deepEqual(await local({ ...baseProps, machine: "build" }), [
    ["closeOverlay", "thread-popup"],
    ["run", "space.new", { folder: baseProps.folder, machine: "build" }],
  ]);
});

test("Local passes explicit empty-string machine for null, omitted and empty local machines", async () => {
  for (const props of [baseProps, { ...baseProps, machine: null }, { ...baseProps, machine: "" }]) {
    assert.deepEqual(await local(props), [
      ["closeOverlay", "thread-popup"],
      ["run", "space.new", { folder: baseProps.folder, machine: "" }],
    ]);
  }
});

test("Local with an existing space opens a tab in the shown folder instead of another space", async () => {
  assert.deepEqual(await local({ ...baseProps, machine: "build", space: "space-1" }), [
    ["closeOverlay", "thread-popup"],
    ["run", "space.select", { id: "space-1" }],
    ["run", "tab.new", { space: "space-1", folder: baseProps.folder }],
  ]);
});

test("Codex launch argv keeps --no-daemon for new spaces and existing-space tabs", async () => {
  for (const run of [
    ["codex", "--model", "example"],
    ["codex", "--no-daemon", "--model", "example"],
  ]) {
    const agent = { ...terminal, key: "codex", name: "Codex", run };
    const argv = ["codex", "--no-daemon", "--model", "example"];
    assert.deepEqual(await local({ ...baseProps, machine: "build" }, agent), [
      ["closeOverlay", "thread-popup"],
      ["run", "space.new", { folder: baseProps.folder, machine: "build", argv }],
    ]);
    assert.deepEqual(await local({ ...baseProps, machine: "build", space: "space-1" }, agent), [
      ["closeOverlay", "thread-popup"],
      ["run", "space.select", { id: "space-1" }],
      ["run", "tab.new", { space: "space-1", folder: baseProps.folder, argv }],
    ]);
  }
});

test("the keyboard moves, wraps and chooses, and the selection stays on its agent when agents load", async () => {
  const agent = (key: string, run: string[]) => ({
    key,
    name: key,
    icon: `${key}.svg`,
    tint: false,
    installed: true,
    run,
  });
  const claude = agent("claude-code", ["claude"]);
  const events: unknown[][] = [];
  const props = { space: "s1", folder: "/repo", machine: "", repo: true, overlay: "thread-popup" };
  const Thread = await loadThread(
    {
      props: () => props,
      theme: () => ({}),
      shared: () => ({ "": [claude] }),
      setShared: () => {},
      knownAgents: async () => [agent("codex", ["codex"]), claude],
      closeOverlay: (...args: unknown[]) => events.push(["closeOverlay", ...args]),
      run: (...args: unknown[]) => events.push(["run", ...args]),
      openOverlay: (spec: { props: unknown }) => events.push(["openOverlay", spec.props]),
    },
    element,
  );
  const view = new Thread();
  const tasks: ((cx: unknown) => Promise<void>)[] = [];
  view.init({}, { focus_handle: () => ({ focus() {} }), spawn: (task) => tasks.push(task) });
  const cx = { stop_propagation() {}, notify() {} };
  const press = (...keys: string[]) => {
    for (const key of keys) view.render().handlers.on_key_down({ key, modifiers: {} }, cx);
  };
  const chosen = () => JSON.parse(JSON.stringify(events.splice(0)));
  scrolled.length = 0;

  press("down");
  // Codex arrives above the selected Claude row.
  await tasks[0]({ notify() {} });
  press("enter");
  assert.deepEqual(chosen(), [
    ["closeOverlay", "thread-popup"],
    ["run", "space.select", { id: "s1" }],
    ["run", "tab.new", { space: "s1", folder: "/repo", argv: ["claude"] }],
  ]);
  press("home", "up", "space");
  assert.deepEqual(chosen(), [
    ["closeOverlay", "thread-popup"],
    ["openOverlay", { space: "s1", folder: "/repo", action: "new", argv: ["claude"] }],
  ]);
  press("end", "down", "enter");
  assert.deepEqual(chosen(), [
    ["closeOverlay", "thread-popup"],
    ["run", "space.select", { id: "s1" }],
    ["run", "tab.new", { space: "s1", folder: "/repo" }],
  ]);
  // Each move brings its row on screen: Claude's row at 2 before Codex loaded, then the rows after
  // the LOCAL heading, separator and WORKTREE heading.
  assert.deepEqual(scrolled, [2, 1, 8, 8, 1]);
  press("x");
  assert.deepEqual(chosen(), []);
  press("escape");
  assert.deepEqual(chosen(), [["closeOverlay", "thread-popup"]]);
  // A press reaches the list by the row's key; a heading does nothing.
  const list = (node) =>
    node?.id === "thread-choices" ? node : (node?.childNodes ?? []).map(list).find(Boolean);
  list(view.render()).handlers.on_item_click("heading-LOCAL");
  assert.deepEqual(chosen(), []);
  list(view.render()).handlers.on_item_click("local-codex");
  assert.deepEqual(chosen(), [
    ["closeOverlay", "thread-popup"],
    ["run", "space.select", { id: "s1" }],
    ["run", "tab.new", { space: "s1", folder: "/repo", argv: ["codex", "--no-daemon"] }],
  ]);
});

test("non-Codex agent argv is preserved without Codex-only flags", async () => {
  const argv = ["claude", "--resume"];
  assert.deepEqual(await local({ ...baseProps, machine: "build" }, { ...terminal, run: argv }), [
    ["closeOverlay", "thread-popup"],
    ["run", "space.new", { folder: baseProps.folder, machine: "build", argv }],
  ]);
});
