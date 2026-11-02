import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const plain = (value) => JSON.parse(JSON.stringify(value));

async function launchMenu(name: string, argv = ["codex"]) {
  const state = {
    props: { space: "build/s1", folder: "/repo", machine: "build", repo: true, overlay: "o1" },
    commands: [] as unknown[][],
    overlays: [] as any[],
    agents: [
      { key: "codex", name: "Codex", run: argv, installed: true, icon: "codex.svg", tint: false },
      {
        key: "claude-code",
        name: "Claude",
        run: ["claude"],
        installed: true,
        icon: "claude.svg",
        tint: false,
      },
    ],
  };
  function element() {
    const node: any = { childNodes: [], handlers: {} };
    const proxy = new Proxy(node, {
      get(target, key) {
        if (key in target) return target[key];
        if (key === "then") return undefined;
        return (...args) => {
          if (key === "id") node.id = args[0];
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
  const context = vm.createContext({});
  const natives = {
    "gpui-kit": { View: class {}, div: element, svg: element, image: element },
    "gpui-base": {
      h_flex: element,
      v_flex: element,
      Scrollbar: { vertical: element },
      v_virtual_list: (id, count, _sizes, _key, draw) => {
        const list = element().id(id);
        for (const row of draw({ start: 0, end: count })) list.child(row);
        return list;
      },
      VirtualListScrollHandle: { new: () => ({ scroll_to_item() {}, release() {} }) },
    },
    herdr: {
      theme: () => ({}),
      spaces: () => [{ id: "build/s1", active: true, machine: "build" }],
      panes: () => [],
      props: () => state.props,
      window: () => ({ platform: "macos" }),
      shared: () => ({ build: state.agents }),
      setShared: () => assert.fail("Launching must not change the cached agent configuration"),
      knownAgents: async () => state.agents,
      run: (...args) => state.commands.push(args),
      openOverlay: (spec) => state.overlays.push(spec),
      closeOverlay: () => {},
    },
  };
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
  const module = await load(new URL(`../mods/${name}/main.ts`, import.meta.url).href);
  await module.link((id, parent) =>
    load(id.startsWith(".") ? new URL(id, parent.identifier).href : id),
  );
  await module.evaluate();
  const Menu = (module.namespace as { default: new () => any }).default;
  const menu = new Menu();
  menu.init({}, { focus_handle: () => ({ focus() {} }), spawn() {} });
  return { state, render: () => menu.render() };
}

function byId(node, id) {
  if (node?.id === id) return node;
  return (node?.childNodes ?? []).map((child) => byId(child, id)).find(Boolean);
}

// The thread picker's rows sit in a virtual list, which reports a press by the row's key.
const pickThread = (tree, key: string) => byId(tree, "thread-choices").handlers.on_item_click(key);

test("cached new-menu Codex choices use isolated execution for both clicks and shortcuts", async () => {
  const h = await launchMenu("frantss-new-menu", ["codex", "--model", "chosen-model"]);
  const tree = h.render();
  byId(tree, "codex").handlers.on_click();
  tree.handlers.on_key_down({ key: "1", modifiers: { platform: true } });
  assert.deepEqual(plain(h.state.commands), [
    ["tab.new", { space: "build/s1", argv: ["codex", "--no-daemon", "--model", "chosen-model"] }],
    ["tab.new", { space: "build/s1", argv: ["codex", "--no-daemon", "--model", "chosen-model"] }],
  ]);
  assert.deepEqual(h.state.agents[0].run, ["codex", "--model", "chosen-model"]);
});

test("thread launches isolate Codex in existing spaces, new spaces, and worktrees", async () => {
  const h = await launchMenu("frantss-thread");
  pickThread(h.render(), "local-codex");
  assert.deepEqual(plain(h.state.commands), [
    ["space.select", { id: "build/s1" }],
    ["tab.new", { space: "build/s1", folder: "/repo", argv: ["codex", "--no-daemon"] }],
  ]);
  pickThread(h.render(), "worktree-codex");
  assert.deepEqual(plain(h.state.overlays.at(-1).props), {
    space: "build/s1",
    folder: "/repo",
    action: "new",
    argv: ["codex", "--no-daemon"],
  });
  h.state.props.space = null;
  pickThread(h.render(), "local-codex");
  assert.deepEqual(plain(h.state.commands.at(-1)), [
    "space.new",
    { folder: "/repo", machine: "build", argv: ["codex", "--no-daemon"] },
  ]);
  pickThread(h.render(), "worktree-codex");
  assert.deepEqual(plain(h.state.overlays.at(-1).props), {
    machine: "build",
    folder: "/repo",
    action: "new",
    argv: ["codex", "--no-daemon"],
  });
});

test("Codex paths and existing isolation flags preserve all launch arguments without duplication", async () => {
  for (const executable of ["/opt/homebrew/bin/codex", "C:\\tools\\codex.exe"]) {
    for (const present of [false, true]) {
      const argv = [executable, ...(present ? ["--no-daemon"] : []), "--profile", "work"];
      const before = [...argv];
      const h = await launchMenu("frantss-thread", argv);
      pickThread(h.render(), "local-codex");
      assert.deepEqual(plain(h.state.commands.at(-1)), [
        "tab.new",
        {
          space: "build/s1",
          folder: "/repo",
          argv: [executable, "--no-daemon", "--profile", "work"],
        },
      ]);
      assert.deepEqual(argv, before);
    }
  }
});

test("other agents and plain terminals retain their launch commands", async () => {
  for (const name of ["frantss-thread", "frantss-new-menu"]) {
    const h = await launchMenu(name);
    const thread = name === "frantss-thread";
    // The thread picker opens its tab in the folder it shows; the new menu leaves it to Herdr.
    const target = thread ? { space: "build/s1", folder: "/repo" } : { space: "build/s1" };
    const pick = (threadKey: string, menuId: string) =>
      thread ? pickThread(h.render(), threadKey) : byId(h.render(), menuId).handlers.on_click();
    pick("local-claude-code", "claude-code");
    assert.deepEqual(plain(h.state.commands.at(-1)), ["tab.new", { ...target, argv: ["claude"] }]);
    pick("local-terminal", "terminal");
    assert.deepEqual(plain(h.state.commands.at(-1)), ["tab.new", target]);
  }
});
