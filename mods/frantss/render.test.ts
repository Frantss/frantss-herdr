import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const key = (folder: string, machine: string | null = null) => JSON.stringify([machine, folder]);
const plain = (value) => JSON.parse(JSON.stringify(value));
const tab = (id, other = {}) => ({
  id,
  name: id,
  named: false,
  active: false,
  settled: false,
  status: null as string | null,
  ...other,
});
const space = (id, folder, tabs, other = {}) => ({
  id,
  name: id,
  folder,
  tabs,
  machine: null,
  branch: "main",
  active: false,
  ...other,
});
const pane = (tab, cwd, title, program = null, other = {}) => ({
  pane: `pane-${tab}-${title}`,
  terminal: null as string | null,
  tab,
  cwd,
  title,
  program,
  ...other,
});
const shell = { name: "Zsh", key: "zsh", agent: false };
const agent = { name: "Claude Code", key: "claude", agent: true };

async function harness(role = "rail") {
  const worktree = "/home/.herdr/worktrees/project/feature";
  const state = {
    role,
    pane: "pane-t-agent-✳ Fix API",
    spaces: [
      space("worktree", worktree, [tab("t-worktree", { named: true, name: "Feature" })]),
      space(
        "primary",
        "/project/original",
        [
          tab("t-agent", { active: true }),
          tab("t-named", { named: true, name: "Keep CASE" }),
          tab("t-empty"),
          tab("t-mod"),
          tab("t-program"),
          tab("t-cwd"),
        ],
        { active: true },
      ),
      space(
        "build/remote",
        "/project",
        [tab("build/t-remote", { named: true, name: "Remote CASE", active: true })],
        { machine: "build" },
      ),
      space("outside", "/outside", [tab("t-outside")]),
    ],
    panes: [
      pane("t-agent", "", "Zsh", shell),
      pane("t-cwd", "/project/live", "/path", shell),
      pane("t-agent", "/project/agent", "✳ Fix API", agent, { branch: "main", focused: true }),
      pane("t-agent", "/project/later", "✳ Later agent", agent),
      pane("t-named", "/project/named", "Ignored title", agent),
      pane("t-mod", null, "Canvas"),
      pane("t-mod", "/project/mod-later", "/path", shell),
      pane("t-program", "/project/program", "Neovim", {
        name: "Neovim",
        key: "nvim",
        agent: false,
      }),
      pane("t-worktree", worktree, "✳ Feature", agent),
      pane("build/t-remote", "/project/live", "✳ Remote", agent),
    ],
    shared: new Map<string, unknown>([
      ["frantss.workspaces", [{ folder: "/project" }, { folder: "/closed" }]],
    ]),
    agents: [] as any[],
    overlays: [] as any[],
    commands: [] as any[],
    bulkRemovalResults: [] as any[],
    onCommand: (_name: string, _args: any) => {},
    calls: { spaces: 0, panes: 0, paneVisits: 0 },
    tasks: [] as ((cx: unknown) => Promise<void>)[],
    terminals: [] as {
      address: string;
      state: string;
      cwd?: string;
      labels?: Record<string, string>;
    }[],
    cancelled: [] as unknown[],
    propsCalls: 0,
    agentOrder: [] as string[],
    commandQueue: [] as string[],
    hcCalls: [] as string[][],
    errors: [] as unknown[],
    removalResult: Promise.resolve({ code: 0, stdout: "", stderr: "" }),
    timers: [] as { ms: number; callback: (cx: unknown) => void }[],
    usageReads: [] as string[],
    contextReads: [] as unknown[],
    contextLine: "",
    branchStatus: "# branch.ab +0 -0\n",
    branchReads: [] as unknown[],
    worktreeReads: [] as unknown[],
    worktreeOutput: "",
    worktreeFailure: false,
    removalGitReads: [] as [string[], { cwd?: string; on?: string | null }][],
    dirtyWorktree: false,
    dirtyWorktrees: new Set<string>(),
    submoduleWorktrees: new Set<string>(),
    worktreeRemoveResult: { code: 0, stdout: "", stderr: "" },
    focusedHandle: null as unknown,
    rendering: false,
    focusAllocations: 0,
    focusTimers: [] as ((cx: unknown) => void)[],
    propagationStops: 0,
    onWorktreeRemoval: (_path: string) => {},
    onWorktreeStatus: async (_path: string) => {},
    storage: new Map<string, string>(),
    theme: {} as Record<string, string>,
  };
  function element(kind = "div", source?) {
    const node: any = {
      kind,
      source,
      elementId: undefined,
      childNodes: [],
      styles: [],
      handlers: {},
      parent: undefined,
    };
    const append = (child) => {
      if (child && typeof child === "object" && "kind" in child) {
        assert.equal(
          child.parent,
          undefined,
          "Elements are single-use values, not reusable children",
        );
        child.parent = node;
      }
      node.childNodes.push(child);
    };
    const proxy = new Proxy(node, {
      get(target, name) {
        if (name in target) return target[name];
        if (name === "then") return undefined;
        return (...args) => {
          if (name === "when") {
            if (args[0]) args[1](proxy);
          } else if (name === "child") append(args[0]);
          else if (name === "children") args[0].forEach(append);
          else if (name === "id") node.elementId = args[0];
          else if (String(name).startsWith("on_")) node.handlers[name] = args.at(-1);
          else node.styles.push([name, ...args]);
          return proxy;
        };
      },
    });
    return proxy;
  }
  const unused = () => assert.fail("Unexpected external command");
  const context = vm.createContext({
    localStorage: {
      getItem: (name: string) => state.storage.get(name) ?? null,
      setItem: (name: string, value: string) => state.storage.set(name, value),
    },
  });
  const natives = {
    "gpui-kit": {
      View: class {},
      div: () => element(),
      svg: (source) => element("svg", source),
      image: (source) => element("image", source),
    },
    "gpui-base": {
      h_flex: () => element(),
      v_flex: () => element(),
      Button: { new: (id) => element().id(id) },
    },
    herdr: {
      notify: (error) => state.errors.push(error),
      nextCommand: async () => state.commandQueue.shift() ?? new Promise<string>(() => {}),
      spaces: () => {
        state.calls.spaces++;
        return state.spaces;
      },
      panes: () => {
        state.calls.panes++;
        return new Proxy(state.panes, {
          get(target, name, receiver) {
            if (name === Symbol.iterator)
              return function* () {
                for (const pane of target) {
                  state.calls.paneVisits++;
                  yield pane;
                }
              };
            return Reflect.get(target, name, receiver);
          },
        });
      },
      agents: () => state.agents,
      machines: () => [
        { name: null, layout: "ready" },
        { name: "build", layout: "ready" },
      ],
      props: () => {
        state.propsCalls++;
        return { role: state.role, pane: state.pane };
      },
      theme: () => state.theme,
      settings: () => ({}),
      shared: (name) => state.shared.get(name) ?? null,
      setShared: (name, value) => state.shared.set(name, value),
      setAgentOrder: (addresses) => {
        state.agentOrder = addresses;
      },
      run: (...args) => {
        if (args[0].startsWith("frantss-worktree-removal.result:")) {
          state.bulkRemovalResults.push(
            JSON.parse(
              decodeURIComponent(args[0].slice("frantss-worktree-removal.result:".length)),
            ),
          );
          return;
        }
        state.commands.push(args);
        state.onCommand(args[0], args[1]);
      },
      openOverlay: (options) => state.overlays.push(options),
      terminals: () => state.terminals,
      exec: async (command, args, options) => {
        if (command === "git" && args[0] === "--git-dir") {
          state.removalGitReads.push([Array.from(args), options]);
          if (args[3] === "list")
            return {
              code: state.worktreeFailure ? 128 : 0,
              stdout: state.worktreeOutput,
              stderr: "Inventory unavailable",
            };
          assert.equal(args[3], "remove");
          if (state.worktreeRemoveResult.code === 0) state.onWorktreeRemoval(args[4]);
          return state.worktreeRemoveResult;
        }
        if (command === "git" && args[0] === "rev-parse") {
          state.removalGitReads.push([Array.from(args), options]);
          return { code: 0, stdout: `${options.cwd}\n`, stderr: "" };
        }
        if (command === "git" && args[0] === "status") {
          state.removalGitReads.push([Array.from(args), options]);
          await state.onWorktreeStatus(options.cwd);
          return {
            code: 0,
            stdout:
              state.dirtyWorktree || state.dirtyWorktrees.has(options.cwd) ? "?? local.txt\0" : "",
            stderr: "",
          };
        }
        if (command === "git" && args[0] === "ls-files") {
          state.removalGitReads.push([Array.from(args), options]);
          return {
            code: 0,
            stdout: state.submoduleWorktrees.has(options.cwd) ? "160000 abc 0\tchild\0" : "",
            stderr: "",
          };
        }
        if (command === "git" && args[0] === "worktree") {
          state.worktreeReads.push([Array.from(args), options?.cwd, options?.on ?? null]);
          return {
            code: state.worktreeFailure ? 128 : 0,
            stdout: state.worktreeOutput,
            stderr: "",
          };
        }
        if (command === "git") {
          state.branchReads.push([options?.cwd, options?.on ?? null]);
          return { code: 0, stdout: state.branchStatus, stderr: "" };
        }
        assert.equal(command, "sh");
        if (args[1].startsWith("grep")) {
          state.contextReads.push([args.at(-1), options?.on ?? null]);
          return { code: 0, stdout: `${state.contextLine}\n`, stderr: "" };
        }
        state.usageReads.push(args.at(-1));
        return {
          code: 0,
          stdout: JSON.stringify({
            windows: [
              { label: "5h", usedPercent: 42, resetsAt: Date.now() / 1000 + 3600 },
              { label: "7d", usedPercent: 75, resetsAt: Date.now() / 1000 + 86400 },
            ],
          }),
          stderr: "",
        };
      },
      pickFolder: unused,
      knownAgents: async () => [],
      hc: async (args) => {
        state.hcCalls.push(Array.from(args));
        return args[0] === "rm"
          ? state.removalResult
          : { code: 0, stdout: JSON.stringify({ terminals: state.terminals }), stderr: "" };
      },
    },
  };
  const module = new vm.SourceTextModule(
    stripTypeScriptTypes(await readFile(new URL("main.ts", import.meta.url), "utf8")),
    { context },
  );
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
  const view = new Frantss();
  view.repos = {
    [key(worktree)]: "/project/.git",
    [key("/project/live")]: "/project/.git",
    [key("/project/live", "build")]: "/project/.git",
    [key("/outside")]: null,
    [key("/project")]: "/project/.git",
    [key("/closed")]: null,
  };
  view.checkouts = { [key(worktree)]: "linked", [key("/project/live")]: "main" };
  // Every place's ahead/behind was just read and found even; tests of the git tail clear this.
  view.branches = Object.fromEntries(
    Object.keys(view.repos).map((place) => [place, { checkedAt: Date.now(), status: null }]),
  );
  const cx = {
    focus_handle: () => {
      assert.equal(state.rendering, false, "focus handles must not be created during render");
      state.focusAllocations++;
      const handle = {
        focus: () => {
          state.focusedHandle = handle;
        },
        is_focused: () => state.focusedHandle === handle,
        release: () => {
          assert.equal(state.rendering, false, "focus handles must not be released during render");
          if (state.focusedHandle === handle) state.focusedHandle = null;
          return true;
        },
      };
      return handle;
    },
    spawn: (task) => {
      state.tasks.push(task);
      return { cancel: () => state.cancelled.push(task) };
    },
    stop_propagation() {
      state.propagationStops++;
    },
    notify() {},
    timer: {
      every: (ms, callback) => state.timers.push({ ms, callback }),
      after: (ms, callback) => {
        assert.equal(ms, 0);
        state.focusTimers.push(callback);
      },
    },
  };
  return {
    state,
    view,
    cx,
    render: () => {
      state.rendering = true;
      let tree;
      try {
        tree = view.render(cx);
      } finally {
        state.rendering = false;
      }
      if (view.syncingRailFocus) state.focusTimers.pop()(cx);
      return tree;
    },
  };
}

function byId(node, id) {
  if (node?.elementId === id) return node;
  for (const child of node?.childNodes ?? []) {
    const found = byId(child, id);
    if (found) return found;
  }
  return null;
}
function text(node): string {
  return typeof node === "string" ? node : (node?.childNodes ?? []).map(text).join("");
}
function descendants(node): any[] {
  return [node, ...(node?.childNodes ?? []).flatMap(descendants)];
}
// A row's hover controls render only while the rail tracks that row as hovered.
function hoverRender(h, rowId: string) {
  h.view.hovered = rowId;
  return h.render();
}

for (const role of ["rail", "top"]) {
  test(`${role} reads one spaces/panes snapshot and traverses panes once per render`, async () => {
    const h = await harness(role);
    h.render();
    assert.deepEqual(h.state.calls, { spaces: 1, panes: 1, paneVisits: h.state.panes.length });
  });
}

test("rail keeps workspace order, global-first cwd, tab names, worktree marks, and action targets", async () => {
  const h = await harness();
  const tree = h.render();
  const group = key("/project/.git"),
    remoteGroup = key("/project/.git", "build");
  const ids = descendants(tree)
    .map((node) => node?.elementId)
    .filter((id) => id?.startsWith("group-"));
  assert.deepEqual(ids, [
    `group-${group}`,
    `group-${key("/closed")}`,
    `group-${remoteGroup}`,
    `group-${key("/outside")}`,
  ]);
  assert.equal(text(byId(tree, "tab-t-named")), "Keep CASE");
  assert.equal(text(byId(tree, "tab-t-empty")), "terminal");
  assert.equal(text(byId(tree, "tab-t-program")), "neovim");
  assert.equal(text(byId(tree, "tab-t-cwd")), "path");
  assert.equal(text(byId(tree, "space-build/remote")), "Remote CASE");
  assert.ok(
    descendants(byId(tree, "space-worktree")).some(
      (node) => node?.source === "mods/workspace-chrome/branch.svg",
    ),
  );
  const icons = (id: string) =>
    descendants(byId(tree, id))
      .map((node) => node?.source)
      .filter((source) => source && !source.includes("chevron"));
  assert.deepEqual(icons("space-primary"), ["mods/frantss/checkout.svg"]);
  assert.deepEqual(icons(`group-${group}`), []);
  assert.equal(text(byId(tree, `group-${group}`)), "Pproject");
  assert.equal(text(byId(tree, `group-${key("/closed")}`)), "Cclosed");
  assert.deepEqual(icons("tab-t-program"), ["mods/workspace-chrome/terminal.svg"]);
  assert.equal(byId(tree, `new-${group}`), null);
  byId(hoverRender(h, `group-${group}`), `new-${group}`).handlers.on_click({}, h.cx);
  assert.equal(h.state.overlays.at(-1).props.space, "primary");
  assert.equal(h.state.overlays.at(-1).props.folder, "/project/live");
  byId(tree, "space-worktree").handlers.on_mouse_down({}, h.cx);
  assert.equal(h.state.overlays.at(-1).props.tab, "pane");
  assert.equal(h.state.overlays.at(-1).props.target.pane, "pane-t-worktree-✳ Feature");
  assert.equal(h.state.overlays.at(-1).props.target.space, "worktree");
  byId(tree, "tab-t-named").handlers.on_mouse_down({}, h.cx);
  assert.deepEqual(plain(h.state.overlays.at(-1).props), {
    tab: "pane",
    target: { pane: "pane-t-named-Ignored title", terminal: null },
  });
  byId(hoverRender(h, `group-${remoteGroup}`), `new-${remoteGroup}`).handlers.on_click({}, h.cx);
  assert.equal(h.state.overlays.at(-1).props.space, "build/remote");
  assert.equal(h.state.overlays.at(-1).props.machine, "build");
  assert.deepEqual(plain(h.state.shared.get("frantss.spaceWorkspaces")), {
    worktree: group,
    primary: group,
    "build/remote": remoteGroup,
    outside: key("/outside"),
  });
});

test("rail publishes space workspaces again only when one changes", async () => {
  const h = await harness();
  h.render();
  const published = h.state.shared.get("frantss.spaceWorkspaces");
  h.render();
  assert.equal(h.state.shared.get("frantss.spaceWorkspaces"), published);
  h.view.repos[key("/outside")] = "/outside/.git";
  h.render();
  assert.equal(h.state.shared.get("frantss.spaceWorkspaces")["outside"], key("/outside/.git"));
});

test("Pi session names reach tab rows, pane headers, and agent rows", async () => {
  const h = await harness();
  const target = h.state.panes.find((pane) => pane.tab === "t-cwd");
  Object.assign(target, {
    title: "π - Fix Pi titles - gasty",
    cwd: "/project/gasty",
    terminal: "t-pi",
    program: { key: "pi", name: "Pi", agent: true },
  });
  h.state.agents = [
    {
      address: "t-pi",
      tab: "t-cwd",
      pane: target.pane,
      space: "primary",
      space_name: "primary",
      app: "pi",
      program: target.program,
      title: target.title,
      status: "working",
    },
  ];
  const tree = h.render();
  assert.equal(text(byId(tree, "tab-t-cwd")), "fix pi titles");
  assert.equal(text(byId(tree, "agent-t-pi")), "fix pi titles·Pprimarynow");
  h.state.role = "pane";
  h.state.pane = target.pane;
  assert.match(text(h.render()), /fix pi titles/);
});

test("pane aliases reach rail rows, agent rows, headers and breadcrumbs through splitting and clearing", async () => {
  const h = await harness();
  const target = h.state.panes.find((pane) => pane.tab === "t-cwd");
  target.pane = "p-custom";
  const names = { [target.pane]: "My PANE" };
  h.state.shared.set("frantss.paneNames", names);
  h.state.agents = [
    {
      address: "term1",
      pane: target.pane,
      tab: target.tab,
      space: "primary",
      program: agent,
      title: "Original",
      status: "idle",
    },
  ];
  let tree = h.render();
  assert.equal(text(byId(tree, "tab-t-cwd")), "My PANE");
  assert.match(text(byId(tree, "agent-term1")), /^My PANE/);
  target.title = "New live title";
  assert.equal(text(byId(h.render(), "tab-t-cwd")), "My PANE");
  h.state.role = "pane";
  h.state.pane = target.pane;
  assert.match(text(h.render()), /My PANE/);
  h.state.role = "top";
  h.state.spaces[1].tabs.forEach((tab) => {
    tab.active = tab.id === target.tab;
  });
  assert.equal(text(byId(h.render(), "crumb-tab")), "my-pane");
  h.state.role = "rail";
  const added = pane(target.tab, "/project/live", "Second pane", shell);
  h.state.panes.push(added);
  tree = h.render();
  assert.equal(text(byId(tree, "tab-t-cwd")), "main");
  assert.equal(text(byId(tree, `pane-${target.pane}`)), "├My PANE");
  h.state.panes = h.state.panes.filter((pane) => pane !== added);
  assert.equal(text(byId(h.render(), "tab-t-cwd")), "My PANE");
  h.state.shared.set("frantss.paneNames", {});
  assert.equal(text(byId(h.render(), "tab-t-cwd")), "new live title");
  h.state.panes = h.state.panes.filter((pane) => pane !== target);
  h.state.shared.set("frantss.paneNames", names);
  h.render();
  assert.deepEqual(plain(h.state.shared.get("frantss.paneNames")), {});
});

test("rail lists a tab's panes under it when it has more than one", async () => {
  const h = await harness();
  const tree = h.render();
  const rows = descendants(tree)
    .map((node) => node?.elementId)
    .filter((id) => /^(tab|pane)-pane-t-(agent|mod)/.test(id) || /^tab-t-(agent|mod)$/.test(id));
  assert.deepEqual(rows, [
    "tab-t-agent",
    "pane-pane-t-agent-Zsh",
    "pane-pane-t-agent-✳ Fix API",
    "pane-pane-t-agent-✳ Later agent",
    "tab-t-mod",
    "pane-pane-t-mod-Canvas",
    "pane-pane-t-mod-/path",
  ]);
  assert.deepEqual(
    rows.map((id) => text(byId(tree, id))),
    ["main", "├zsh", "├fix api", "└later agent", "main", "├canvas", "└path"],
  );
  byId(tree, "pane-pane-t-agent-✳ Fix API").handlers.on_click({}, h.cx);
  assert.deepEqual(plain(h.state.commands.at(-1)), [
    "pane.focus",
    { pane: "pane-t-agent-✳ Fix API" },
  ]);
  byId(tree, "pane-pane-t-agent-Zsh").handlers.on_mouse_down({}, h.cx);
  assert.equal(h.state.overlays.at(-1).props.tab, "pane");
  assert.equal(h.state.overlays.at(-1).props.target.pane, "pane-t-agent-Zsh");
});

test("rail rows representing lone panes open that pane's menu without selecting it", async () => {
  const h = await harness();
  for (const target of h.state.panes) target.terminal = `terminal-${target.pane}`;
  const tree = h.render();
  for (const [row, tabId] of [
    ["tab-t-named", "t-named"],
    ["tab-t-program", "t-program"],
    ["tab-t-cwd", "t-cwd"],
    ["space-worktree", "t-worktree"],
    ["space-build/remote", "build/t-remote"],
  ]) {
    const target = h.state.panes.find((pane) => pane.tab === tabId);
    byId(tree, row).handlers.on_mouse_down({}, h.cx);
    const opened = h.state.overlays.at(-1).props;
    assert.equal(opened.tab, "pane");
    assert.equal(opened.target.pane, target.pane);
    assert.equal(opened.target.terminal, target.terminal);
    if (row.startsWith("space-")) {
      assert.equal(
        opened.target.space,
        h.state.spaces.find((s) => s.tabs.some((t) => t.id === tabId)).id,
      );
    } else assert.equal(opened.target.space, undefined);
  }
  assert.deepEqual(h.state.commands, []);
});

test("rail rows without panes retain the represented tab's menu", async () => {
  const h = await harness();
  const tree = h.render();
  for (const [row, id, space] of [
    ["tab-t-empty", "t-empty", "primary"],
    ["space-outside", "t-outside", "outside"],
  ]) {
    byId(tree, row).handlers.on_mouse_down({}, h.cx);
    assert.deepEqual(plain(h.state.overlays.at(-1).props), {
      tab: "tab",
      target: { id, space, name: "terminal" },
    });
  }
});

test("rail menus follow a lone pane as it splits and collapses back into its space", async () => {
  const h = await harness();
  const original = h.state.panes.find((pane) => pane.tab === "t-worktree");
  const added = pane("t-worktree", "/project/live", "Zsh", shell, { terminal: "t-shell" });
  h.state.panes.push(added);
  h.state.shared.set("frantss.collapsed", ["space:worktree:open"]);
  const split = h.render();
  byId(split, "space-worktree").handlers.on_mouse_down({}, h.cx);
  assert.deepEqual(plain(h.state.overlays.at(-1).props), {
    tab: "space",
    target: { id: "worktree", name: "main", checkout: "linked" },
  });
  byId(split, "tab-t-worktree").handlers.on_mouse_down({}, h.cx);
  assert.deepEqual(plain(h.state.overlays.at(-1).props), {
    tab: "tab",
    target: { id: "t-worktree", space: "worktree", name: "Feature" },
  });
  h.state.panes = h.state.panes.filter((pane) => pane !== original);
  const collapsed = h.render();
  assert.equal(byId(collapsed, "tab-t-worktree"), null);
  byId(collapsed, "space-worktree").handlers.on_mouse_down({}, h.cx);
  assert.equal(h.state.overlays.at(-1).props.tab, "pane");
  assert.equal(h.state.overlays.at(-1).props.target.pane, added.pane);
  assert.equal(h.state.overlays.at(-1).props.target.space, "worktree");
});

test("a hovered space row's + starts a thread as a new tab in that space", async () => {
  const h = await harness();
  assert.equal(byId(h.render(), "new-tab-worktree"), null);
  const tree = hoverRender(h, "space-worktree");
  assert.ok(
    descendants(byId(tree, "space-worktree")).some(
      (node) => node?.source === "mods/workspace-chrome/branch.svg",
    ),
  );
  byId(tree, "new-tab-worktree").handlers.on_click({}, h.cx);
  assert.equal(h.state.overlays.at(-1).mod, "frantss-thread");
  assert.equal(h.state.overlays.at(-1).props.space, "worktree");
  assert.equal(h.state.overlays.at(-1).props.folder, "/home/.herdr/worktrees/project/feature");
});

test("a space whose only tab has several panes lists them instead of standing for the tab", async () => {
  const h = await harness();
  h.state.panes.push(pane("t-worktree", "/project/live", "Zsh", shell));
  h.state.shared.set("frantss.collapsed", ["space:worktree:open"]);
  const tree = h.render();
  assert.equal(text(byId(tree, "space-worktree")), "main");
  assert.ok(byId(tree, "pane-pane-t-worktree-✳ Feature"));
  assert.ok(byId(tree, "pane-pane-t-worktree-Zsh"));
});

test("top breadcrumbs retain labels, checkout menus, local actions, and remote identity", async () => {
  const h = await harness("top");
  const tree = h.render();
  assert.equal(text(byId(tree, "crumb-workspace")), "~/project");
  assert.equal(text(byId(tree, "crumb-space")), "main");
  assert.equal(text(byId(tree, "crumb-tab")), "main");
  byId(tree, "crumb-workspace").handlers.on_click({}, h.cx);
  assert.deepEqual(plain(h.state.overlays.at(-1).props), { folder: "/project" });
  byId(tree, "crumb-space").handlers.on_click({}, h.cx);
  assert.deepEqual(plain(h.state.overlays.at(-1).props.target), {
    id: "primary",
    name: "main",
    checkout: "main",
  });
  byId(tree, "crumb-tab").handlers.on_click({}, h.cx);
  assert.equal(h.state.overlays.at(-1).props.target.name, "main");
  h.state.spaces.forEach((space) => {
    space.active = space.machine === "build";
  });
  const remote = h.render();
  assert.equal(text(byId(remote, "crumb-tab")), "remote-case");
  assert.equal(byId(remote, "crumb-workspace").handlers.on_click, undefined);
});

test("top looks up only the current space's place and the saved workspaces", async () => {
  const h = await harness("top");
  const looked = [];
  h.view.repos = {};
  h.view.lookUp = (place) => {
    looked.push(place);
    h.view.repos[place] = null;
  };
  h.render();
  assert.deepEqual(looked, [key("/project/live"), key("/project"), key("/closed")]);
  assert.equal(h.state.shared.has("frantss.spaceWorkspaces"), false);
});

test("each new render uses current titles and cwds without retaining live-data maps", async () => {
  const h = await harness();
  h.render();
  h.state.panes[2].title = "✳ Updated task";
  h.state.panes[1].cwd = "/different";
  h.view.repos[key("/different")] = null;
  h.state.calls = { spaces: 0, panes: 0, paneVisits: 0 };
  const tree = h.render();
  assert.equal(text(byId(tree, "pane-pane-t-agent-✳ Fix API")), "├updated task");
  assert.ok(byId(tree, `group-${key("/different")}`));
  assert.deepEqual(h.state.calls, { spaces: 1, panes: 1, paneVisits: h.state.panes.length });
});

test("split tab labels and menus use their branch while pane labels keep their own names", async () => {
  const h = await harness();
  Object.assign(h.state.spaces[1], { branch: "feature/Login", named: true, name: "Custom space" });
  const tree = h.render();
  assert.equal(text(byId(tree, "tab-t-agent")), "feature/Login");
  assert.equal(text(byId(tree, "pane-pane-t-agent-✳ Fix API")), "├fix api");
  byId(tree, "tab-t-agent").handlers.on_mouse_down({}, h.cx);
  assert.equal(h.state.overlays.at(-1).props.target.name, "feature/Login");
  h.state.role = "top";
  const top = h.render();
  assert.equal(text(byId(top, "crumb-tab")), "feature-login");
  byId(top, "crumb-tab").handlers.on_click({}, h.cx);
  assert.equal(h.state.overlays.at(-1).props.target.name, "feature/Login");
  assert.ok(!h.state.commands.some(([name]) => name === "tab.rename"));
});

test("split tab names fall back to their worktree folder, then the space name", async () => {
  for (const [folder, expected] of [
    ["/worktrees/Detached/", "Detached"],
    ["C:\\worktrees\\Feature\\", "Feature"],
    ["", "Checkout"],
  ]) {
    const h = await harness();
    Object.assign(h.state.spaces[1], { branch: null, folder, name: "Checkout" });
    assert.equal(text(byId(h.render(), "tab-t-agent")), expected);
  }
});

test("a split worktree tab keeps its explicit name and returns to pane naming when unnamed and alone", async () => {
  const h = await harness();
  const worktree = h.state.spaces[0];
  worktree.branch = "feature/Worktree";
  h.state.panes.push(pane("t-worktree", worktree.folder, "Zsh", shell));
  h.state.shared.set("frantss.collapsed", ["space:worktree:open"]);
  assert.equal(text(byId(h.render(), "tab-t-worktree")), "Feature");
  worktree.tabs[0].named = false;
  assert.equal(text(byId(h.render(), "tab-t-worktree")), "feature/Worktree");
  h.state.panes = h.state.panes.filter((each) => each.title !== "Zsh" || each.tab !== "t-worktree");
  // Standing for its tab, the worktree shows its branch where the tab's name doesn't say it.
  assert.equal(text(byId(h.render(), "space-worktree")), "featurefeature/Worktree");
  assert.equal(worktree.tabs[0].name, "Feature");
});

test("pane headers retain their single pane lookup without workspace indexing", async () => {
  const h = await harness("pane");
  Object.assign(h.state.panes[2], { status: "blocked" });
  const tree = h.render();
  assert.match(text(tree), /fix api/);
  assert.doesNotMatch(text(tree), /Claude Code|Needs you/);
  assert.match(text(tree), /main · agent/);
  assert.deepEqual(h.state.calls, { spaces: 0, panes: 1, paneVisits: 0 });
  // One props read for the role and one for the pane, not one per pane searched.
  assert.equal(h.state.propsCalls, 2);
  for (const id of ["split-right", "split-down", "zoom-pane", "close-pane"])
    byId(tree, id).handlers.on_click({}, h.cx);
  const target = "pane-t-agent-✳ Fix API";
  assert.deepEqual(plain(h.state.commands.slice(-4)), [
    ["pane.split", { direction: "right", pane: target }],
    ["pane.split", { direction: "down", pane: target }],
    ["pane.zoom", { pane: target }],
    ["pane.close", { pane: target }],
  ]);
  // A lone pane splits but neither zooms nor closes on its own.
  h.state.pane = "pane-t-named-Ignored title";
  const lone = h.render();
  assert.ok(byId(lone, "split-right"));
  assert.equal(byId(lone, "zoom-pane"), null);
  assert.equal(byId(lone, "close-pane"), null);
});

test("only terminal panes sharing their tab offer an accessible move-to-tab control", async () => {
  const h = await harness("pane");
  Object.assign(h.state.panes[2], { terminal: "t42" });
  const control = byId(h.render(), "move-pane-to-tab");
  assert.ok(control);
  assert.ok(control.styles.some(([name, value]) => name === "tab_stop" && value));
  assert.ok(
    control.styles.some(
      ([name, value]) => name === "accessibility_label" && value === "Move to new tab",
    ),
  );
  control.handlers.on_click({}, h.cx);
  assert.deepEqual(plain(h.state.commands), [
    [`frantss.move-pane:${encodeURIComponent(h.state.pane)}`],
  ]);

  h.state.pane = h.state.panes[4].pane;
  h.state.panes[4].terminal = "t43";
  assert.equal(byId(h.render(), "move-pane-to-tab"), null);
  h.state.pane = h.state.panes[5].pane;
  Object.assign(h.state.panes[5], { terminal: null, mod: "canvas" });
  assert.equal(byId(h.render(), "move-pane-to-tab"), null);
});

test("moving waits for parking, ignores repeat requests, and retains the terminal in its original space", async () => {
  const h = await harness();
  const target = h.state.panes[2];
  target.terminal = "build/t42";
  let release;
  const sleeps: number[] = [];
  const cx = {
    sleep: (ms) => {
      sleeps.push(ms);
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  };
  h.state.onCommand = (name, args) => {
    if (name === "terminal.keep")
      h.state.panes.push({ ...target, pane: "new-pane", tab: "new-tab", terminal: args.terminal });
  };
  const move = h.view.movePane(target.pane, cx);
  assert.deepEqual(plain(h.state.commands), [["terminal.park", { terminal: "build/t42" }]]);
  await h.view.movePane(target.pane, cx);
  const sibling = h.state.panes.find((each) => each !== target && each.tab === target.tab);
  sibling.terminal = "build/t43";
  const otherMove = h.view.movePane(sibling.pane, cx);
  assert.equal(h.state.commands.length, 1);
  await otherMove;
  assert.deepEqual(sleeps, [100]);
  h.state.panes = h.state.panes.filter((each) => each !== target);
  release();
  await move;
  assert.deepEqual(plain(h.state.commands), [
    ["terminal.park", { terminal: "build/t42" }],
    ["tab.select", { id: target.tab }],
    ["terminal.keep", { terminal: "build/t42", place: "tab" }],
  ]);
  assert.equal(h.state.errors.length, 0);
});

test("a failed park does not keep or close a terminal, reports the failure, and allows retry", async () => {
  const h = await harness();
  const target = h.state.panes[2];
  target.terminal = "t42";
  const cx = { sleep: async () => {} };
  await h.view.movePane(target.pane, cx);
  assert.deepEqual(plain(h.state.commands), [["terminal.park", { terminal: "t42" }]]);
  assert.equal(h.state.errors.length, 1);
  assert.match(plain(h.state.errors)[0].title, /Could not move/);
  await h.view.movePane(target.pane, cx);
  assert.equal(h.state.commands.length, 2);
});

test("a failed keep offers a recovery action for the running terminal", async () => {
  const h = await harness();
  const target = h.state.panes[2];
  target.terminal = "t42";
  h.state.onCommand = (name) => {
    if (name === "terminal.park") h.state.panes = h.state.panes.filter((each) => each !== target);
  };
  await h.view.movePane(target.pane, { sleep: async () => {} });
  assert.deepEqual(plain(h.state.errors)[0].action, {
    name: "terminal.keep",
    args: { terminal: "t42", place: "tab" },
  });
  assert.ok(!h.state.commands.some(([name]) => name === "pane.close" || name === "terminal.kill"));
});

test("stale, lone, and mod pane move requests have no side effects", async () => {
  const h = await harness();
  h.state.panes[4].terminal = "t43";
  for (const id of ["missing", h.state.panes[4].pane, h.state.panes[5].pane])
    await h.view.movePane(id, {});
  assert.equal(h.state.commands.length, 0);
});

test("the rail owns pane moves requested by pane header commands", async () => {
  const h = await harness();
  const moves: string[] = [];
  h.view.movePane = async (id) => {
    moves.push(id);
  };
  h.state.commandQueue.push("move-pane:pane%2F42");
  h.view.init({}, h.cx);
  void h.state.tasks[0](h.cx);
  await new Promise(setImmediate);
  await h.state.tasks.at(-1)(h.cx);
  assert.deepEqual(moves, ["pane/42"]);
});

test("the rail's footer opens the settings and adds a machine", async () => {
  const h = await harness("rail");
  const tree = h.render();
  byId(tree, "settings").handlers.on_click({}, h.cx);
  byId(tree, "add-machine").handlers.on_click({}, h.cx);
  assert.deepEqual(plain(h.state.commands.slice(-2)), [
    ["app.settings"],
    ["mod.open", { name: "machine-add" }],
  ]);
});

test("duplicate saved workspaces retain the first folder for rows and menus", async () => {
  const h = await harness();
  h.state.shared.set("frantss.workspaces", [
    { folder: "/project/first" },
    { folder: "/closed/first" },
    { folder: "/project/second" },
    { folder: "/closed/second" },
  ]);
  h.view.repos[key("/project/first")] = "/project/.git";
  h.view.repos[key("/project/second")] = "/project/.git";
  h.view.repos[key("/closed/first")] = "/closed/.git";
  h.view.repos[key("/closed/second")] = "/closed/.git";
  const tree = h.render(),
    project = key("/project/.git"),
    closed = key("/closed/.git");
  const groups = descendants(tree)
    .map((node) => node?.elementId)
    .filter((id) => id?.startsWith("group-"));
  assert.deepEqual(groups, [
    `group-${project}`,
    `group-${closed}`,
    `group-${key("/project/.git", "build")}`,
    `group-${key("/outside")}`,
  ]);
  byId(tree, `group-${project}`).handlers.on_mouse_down({}, h.cx);
  assert.deepEqual(plain(h.state.overlays.at(-1).props), { folder: "/project/first", saved: true });
  byId(tree, `group-${closed}`).handlers.on_mouse_down({}, h.cx);
  assert.deepEqual(plain(h.state.overlays.at(-1).props), { folder: "/closed/first", saved: true });
  byId(tree, `group-${closed}`).handlers.on_click({}, h.cx);
  assert.equal(h.state.commands.at(-1)[0], "space.new");
  assert.equal(h.state.commands.at(-1)[1].folder, "/closed/first");
  byId(hoverRender(h, `group-${closed}`), `new-${closed}`).handlers.on_click({}, h.cx);
  assert.equal(h.state.overlays.at(-1).props.folder, "/closed/first");
});

test("workspace membership key reads stay linear as saved and open workspaces grow", async () => {
  const h = await harness(),
    savedCount = 300,
    unsavedCount = 100;
  h.state.spaces = Array.from({ length: savedCount + unsavedCount }, (_, index) =>
    space(`space-${index}`, `/workspace/${index}`, [tab(`tab-${index}`, { named: true })]),
  );
  h.state.panes = [];
  h.state.shared.set(
    "frantss.workspaces",
    Array.from({ length: savedCount }, (_, index) => ({ folder: `/workspace/${index}` })),
  );
  for (const space of h.state.spaces) h.view.repos[key(space.folder)] = null;
  let keyReads = 0;
  const workspace = h.view.workspace.bind(h.view),
    groups = h.view.spaceGroups.bind(h.view);
  const counted = (item) => {
    const value = item.key;
    return Object.defineProperty(item, "key", {
      get() {
        keyReads++;
        return value;
      },
    });
  };
  h.view.workspace = (saved) => counted(workspace(saved));
  h.view.spaceGroups = (snapshot) => groups(snapshot).map(counted);
  const tree = h.render();
  const rows = descendants(tree).filter((node) => node?.elementId?.startsWith("group-"));
  assert.equal(rows.length, savedCount + unsavedCount);
  assert.ok(
    keyReads <= 20 * (savedCount + unsavedCount),
    `Expected linear key reads, received ${keyReads}`,
  );
});

test("the rail lists agent groups and navigates agents in the order they need attention", async () => {
  const h = await harness();
  h.state.agents = ["idle", "working", "done", "blocked"].map((status) => ({
    address: status,
    space: "primary",
    space_name: "primary",
    status,
    program: agent,
    title: "x",
  }));
  const tree = h.render();
  const headers = descendants(tree)
    .map((node) => node?.elementId)
    .filter((id) => ["blocked", "done", "working", "idle"].includes(id?.replace("header-", "")));
  assert.deepEqual(headers, ["header-blocked", "header-done", "header-working", "header-idle"]);
  assert.deepEqual(plain(h.state.agentOrder), ["blocked", "done", "working", "idle"]);
});

const railAgent = (address: string, status: string, other = {}) => ({
  address,
  pane: `pane-${address}`,
  space: "primary",
  space_name: "primary",
  status,
  program: agent,
  title: address,
  pinned: false,
  focused: false,
  ...other,
});
const agentRows = (tree) =>
  descendants(tree)
    .map((node) => node?.elementId)
    .filter((id) => id?.startsWith("agent-"))
    .map((id) => id.slice("agent-".length));

test("native pins lead every status group without duplicates and retain snapshot order", async () => {
  const h = await harness();
  h.state.agents = ["idle", "working", "done", "blocked"].flatMap((status) => [
    railAgent(`${status}-first`, status),
    railAgent(`${status}-pin`, status, { pinned: true }),
    railAgent(`${status}-last`, status),
  ]);
  const tree = h.render();
  const expected = [
    "idle-pin",
    "working-pin",
    "done-pin",
    "blocked-pin",
    "blocked-first",
    "blocked-last",
    "done-first",
    "done-last",
    "working-first",
    "working-last",
    "idle-first",
    "idle-last",
  ];
  assert.deepEqual(agentRows(tree), expected);
  assert.deepEqual(plain(h.state.agentOrder), expected);
  const headers = descendants(tree)
    .map((node) => node?.elementId)
    .filter((id) => id?.startsWith("header-"));
  assert.deepEqual(headers, [
    "header-spaces",
    "header-pinned",
    "header-blocked",
    "header-done",
    "header-working",
    "header-idle",
    "header-usage",
  ]);
  assert.equal(text(byId(tree, "header-pinned")), "Pinned4");
});

test("pinned rows retain each native status while unpinned rows keep their existing appearance", async () => {
  const h = await harness();
  const labels = { blocked: "Needs you", done: "Unread", working: "Working", idle: "Idle" };
  const palette = { blocked: "#ff0000", done: "#00ff00", working: "#0000ff", idle: "#888888" };
  h.state.agents = Object.keys(labels).flatMap((status) => [
    railAgent(`${status}-pin`, status, { pinned: true }),
    railAgent(`${status}-normal`, status),
  ]);
  let tree = h.view.rail(
    palette,
    h.state.agents,
    {
      spaces: [],
      leadByTab: new Map(),
      panesByTab: new Map(),
      cwdBySpace: new Map(),
      placeBySpace: new Map(),
    },
    h.cx,
  );
  for (const [status, label] of Object.entries(labels)) {
    const indicator = byId(tree, `status-${status}-pin`);
    assert.ok(indicator, `${status} pin has a status indicator`);
    assert.ok(indicator.styles.some(([name, value]) => name === "bg" && value === palette[status]));
    assert.ok(indicator.styles.some(([name, value]) => name === "size" && value === 6));
    assert.ok(indicator.styles.some(([name, value]) => name === "tooltip" && value === label));
    assert.ok(
      indicator.styles.some(([name, value]) => name === "accessibility_label" && value === label),
    );
    assert.equal(
      indicator.styles.some(([name]) => name === "loop"),
      status === "blocked",
    );
    assert.equal(byId(tree, `status-${status}-normal`), null);
    const normal = byId(tree, `agent-${status}-normal`);
    assert.equal(text(normal), `${status}-normal·primary`);
    assert.equal(
      descendants(normal).some((node) => node?.styles?.some(([name]) => name === "tooltip")),
      false,
    );
  }
  h.view.hovered = "agent-working-pin";
  tree = h.render();
  assert.ok(byId(tree, "status-working-pin"));
  assert.ok(byId(tree, "interrupt-working-pin"));
});

test("native pin and unpin snapshots move existing rows while retaining their menus and controls", async () => {
  const h = await harness();
  const initial = [
    railAgent("t1", "idle"),
    railAgent("build/t2", "working"),
    railAgent("t3", "blocked"),
  ];
  h.state.agents = initial;
  const before = h.render();
  assert.equal(byId(before, "header-pinned"), null);
  assert.deepEqual(agentRows(before), ["t3", "build/t2", "t1"]);
  h.state.agents = initial.map((a) => ({ ...a, pinned: a.address === "build/t2" }));
  const pinned = hoverRender(h, "agent-build/t2");
  assert.deepEqual(agentRows(pinned), ["build/t2", "t3", "t1"]);
  assert.deepEqual(plain(h.state.agentOrder), agentRows(pinned));
  byId(pinned, "agent-build/t2").handlers.on_mouse_down({}, h.cx);
  assert.deepEqual(plain(h.state.overlays.at(-1).props), {
    tab: "pane",
    target: { pane: "pane-build/t2", terminal: "build/t2" },
  });
  assert.ok(byId(pinned, "peek-build/t2"));
  assert.ok(byId(pinned, "interrupt-build/t2"));
  byId(pinned, "agent-build/t2").handlers.on_click({}, h.cx);
  assert.deepEqual(plain(h.state.commands.at(-1)), ["agent.focus", { terminal: "build/t2" }]);
  h.state.agents = initial.map((a) => ({ ...a, pinned: false }));
  const unpinned = h.render();
  assert.equal(byId(unpinned, "header-pinned"), null);
  assert.deepEqual(agentRows(unpinned), ["t3", "build/t2", "t1"]);
  assert.deepEqual(plain(h.state.agentOrder), agentRows(unpinned));
});

test("the current row is filled and tab rows keep the rail's text size", async () => {
  const h = await harness();
  h.state.agents = [railAgent("t1", "working", { focused: true }), railAgent("t2", "working")];
  const palette = { selected: "#200000", dim: "#777777", muted: "#aaaaaa", foreground: "#ffffff" };
  const tree = h.view.rail(
    palette,
    h.state.agents,
    {
      ...h.view,
      spaces: [],
      leadByTab: new Map(),
      panesByTab: new Map(),
      cwdBySpace: new Map(),
      placeBySpace: new Map(),
    },
    h.cx,
  );
  const filled = (id: string) =>
    byId(tree, id).styles.some(([name, value]) => name === "bg" && value === palette.selected);
  assert.equal(filled("agent-t1"), true);
  assert.equal(filled("agent-t2"), false);
  const rail = h.render();
  assert.equal(
    byId(rail, "tab-t-named").styles.some(([name, value]) => name === "text_size" && value !== 12),
    false,
  );
});

test("agent rows say how long they have been in their status", async () => {
  const h = await harness();
  h.state.agents = [railAgent("t1", "working")];
  h.state.storage.set(
    "statusStamps",
    JSON.stringify({ t1: { status: "working", at: Date.now() - 5 * 60_000 } }),
  );
  assert.equal(text(byId(h.render(), "agent-t1")), "t1·Pprimary5m");
  h.state.agents = [railAgent("t1", "done")];
  assert.equal(text(byId(h.render(), "agent-t1")), "t1·Pprimarynow");
  assert.equal(JSON.parse(h.state.storage.get("statusStamps")).t1.status, "idle");
});

test("space rows show commits ahead and behind their upstream", async () => {
  const h = await harness();
  h.view.branches = {};
  h.state.branchStatus = "# branch.head main\n# branch.ab +2 -1\n";
  h.render();
  await Promise.all(h.state.tasks.splice(0).map((task) => task(h.cx)));
  assert.ok(h.state.branchReads.some(([cwd]) => cwd === "/project/live"));
  assert.equal(text(byId(h.render(), "space-primary")), "main↑2↓1");
  // Read lately, a render doesn't ask git again.
  const reads = h.state.branchReads.length;
  h.render();
  assert.equal(h.state.tasks.length, 0);
  assert.equal(h.state.branchReads.length, reads);
});

test("workspaces get a color that their agents' rows share", async () => {
  const h = await harness();
  h.state.agents = [railAgent("t1", "working")];
  h.state.theme = { accent: "#a78bfa" };
  const tree = h.render();
  const colors = h.state.shared.get("frantss.workspaceColors") as Record<string, string>;
  const group = key("/project/.git");
  assert.equal(colors[group], "accent");
  const hasColor = (node) =>
    descendants(node).some((each) =>
      each?.styles?.some(
        ([name, value]) => ["bg", "text_color"].includes(name) && value?.startsWith("#a78bfa"),
      ),
    );
  assert.equal(hasColor(byId(tree, `group-${group}`)), true);
  assert.equal(hasColor(byId(tree, "agent-t1")), true);
});

test("a closed section shows its most urgent status", async () => {
  const h = await harness();
  h.state.agents = [
    railAgent("t1", "blocked", { pinned: true }),
    railAgent("t2", "done", { pinned: true }),
  ];
  h.state.shared.set("frantss.collapsed", ["pinned"]);
  const header = byId(h.render(), "header-pinned");
  const dots = descendants(header).filter((node) =>
    node?.styles?.some(([name, value]) => name === "size" && value === 6),
  );
  assert.equal(dots.length, 1);
  assert.ok(dots[0].styles.some(([name]) => name === "loop"));
});

test("folded pinned and status sections retain the existing grouped navigation order", async () => {
  const h = await harness();
  h.state.agents = [
    railAgent("t1", "idle", { pinned: true }),
    railAgent("t2", "blocked"),
    railAgent("t3", "working"),
  ];
  const tree = h.render();
  byId(tree, "header-pinned").handlers.on_click({}, h.cx);
  byId(tree, "header-blocked").handlers.on_click({}, h.cx);
  const folded = h.render();
  assert.equal(text(byId(folded, "header-pinned")), "Pinned1");
  assert.deepEqual(agentRows(folded), ["t3"]);
  assert.deepEqual(plain(h.state.agentOrder), ["t1", "t2", "t3"]);
  byId(folded, "header-pinned").handlers.on_click({}, h.cx);
  const expanded = h.render();
  assert.deepEqual(agentRows(expanded), ["t1", "t3"]);
  assert.deepEqual(plain(h.state.agentOrder), ["t1", "t2", "t3"]);
});

test("terminated pins disappear and leave no empty pinned section or stale navigation entry", async () => {
  const h = await harness();
  h.state.agents = [railAgent("t1", "blocked", { pinned: true }), railAgent("t2", "idle")];
  assert.ok(byId(h.render(), "header-pinned"));
  h.state.agents = [railAgent("t2", "idle")];
  const tree = h.render();
  assert.equal(byId(tree, "header-pinned"), null);
  assert.equal(byId(tree, "agent-t1"), null);
  assert.deepEqual(plain(h.state.agentOrder), ["t2"]);
  h.state.agents = [];
  assert.deepEqual(agentRows(h.render()), []);
  assert.deepEqual(plain(h.state.agentOrder), []);
});

test("native statuses honor cross-client seen changes and ignore obsolete custom unread marks", async () => {
  const h = await harness();
  const oldMarks = ["t1", "t2"];
  h.state.shared.set("frantss.unread", oldMarks);
  h.state.agents = [railAgent("t1", "idle"), railAgent("t2", "working"), railAgent("t3", "done")];
  const tree = h.render();
  assert.deepEqual(agentRows(tree), ["t3", "t2", "t1"]);
  assert.equal(text(byId(tree, "header-done")), "Unread1");
  assert.equal(text(byId(tree, "header-idle")), "Idle1");
  assert.equal(h.state.shared.get("frantss.unread"), oldMarks);
  h.state.agents = h.state.agents.map((a) => ({
    ...a,
    status: a.address === "t3" ? "idle" : a.status,
  }));
  const seen = h.render();
  assert.equal(byId(seen, "header-done"), null);
  assert.deepEqual(agentRows(seen), ["t2", "t1", "t3"]);
  assert.deepEqual(plain(h.state.agentOrder), agentRows(seen));
});

test("the focused agent's row shows its context from its labeled session file", async () => {
  const h = await harness();
  const codex = (address, focused, seq) => ({
    address,
    space: "primary",
    space_name: "primary",
    status: "working",
    app: "codex",
    program: agent,
    title: "x",
    focused,
    seq,
  });
  h.state.agents = [codex("t1", true, 1), codex("t2", false, 1)];
  h.state.terminals = [
    { address: "t1", state: "live", labels: { "frantss.session": "/s/one.jsonl" } },
    { address: "t2", state: "live", labels: {} },
  ];
  h.state.contextLine = JSON.stringify({
    payload: {
      type: "token_count",
      info: { last_token_usage: { total_tokens: 95000 }, model_context_window: 100000 },
    },
  });
  h.render();
  await Promise.all(h.state.tasks.splice(0).map((task) => task(h.cx)));
  assert.deepEqual(plain(h.state.contextReads), [["/s/one.jsonl", null]]);
  const tree = h.render();
  assert.equal(text(byId(tree, "agent-t1")), "x·Pprimary95%");
  assert.equal(text(byId(tree, "agent-t2")), "x·Pprimarynow");
  // Unchanged, the timer doesn't read the file again; a new seq does.
  h.view.refreshContext(h.cx);
  assert.equal(h.state.tasks.length, 0);
  h.state.agents[0].seq = 2;
  h.view.refreshContext(h.cx);
  assert.equal(h.state.tasks.length, 1);
});

test("Pi's focused row follows context labels without reading a transcript", async () => {
  const h = await harness();
  h.state.agents = [
    {
      address: "build/t1",
      space: "build/remote",
      space_name: "remote",
      app: "pi",
      status: "working",
      program: { name: "Pi", key: "pi", agent: true },
      title: "Pi task",
      focused: true,
      seq: 1,
    },
  ];
  const labels = { "frantss.context": '{"tokens":95000,"window":100000}' };
  h.state.terminals = [{ address: "build/t1", state: "live", labels }];
  assert.equal(text(byId(h.render(), "agent-build/t1")), "pi task·Premote95%");
  labels["frantss.context"] = '{"tokens":50000,"window":200000}';
  assert.equal(text(byId(h.render(), "agent-build/t1")), "pi task·Premote25%");
  labels["frantss.context"] = "";
  assert.equal(text(byId(h.render(), "agent-build/t1")), "pi task·Premotenow");
  assert.equal(h.state.contextReads.length, 0);
});

test("a pending transcript read cannot replace Pi's context after focus changes", async () => {
  const h = await harness();
  h.state.agents = [{ address: "t1", space: "primary", app: "codex", focused: true, seq: 1 }];
  h.state.terminals = [
    { address: "t1", state: "live", labels: { "frantss.session": "/s/one.jsonl" } },
  ];
  h.state.contextLine = JSON.stringify({
    payload: {
      info: {
        last_token_usage: { total_tokens: 95000 },
        model_context_window: 100000,
      },
    },
  });
  h.view.refreshContext(h.cx);
  h.state.agents = [{ address: "t2", space: "primary", app: "pi", focused: true, seq: 1 }];
  h.state.terminals.push({
    address: "t2",
    state: "live",
    labels: {
      "frantss.context": '{"tokens":50000,"window":200000}',
    },
  });
  h.view.refreshContext(h.cx);
  await h.state.tasks[0](h.cx);
  assert.deepEqual(plain(h.view.context), {
    address: "t2",
    usage: { tokens: 50000, window: 200000 },
  });
});

test("closed Pi sessions offer Pi's session picker", async () => {
  const h = await harness();
  h.state.shared.set("frantss.closedAgents", [
    {
      address: "t7",
      app: "pi",
      program: { name: "Pi", key: "pi", agent: true },
      title: "Pi task",
      cwd: "/project/live",
      closed: 1,
    },
  ]);
  const tree = h.render();
  byId(tree, "resume-t7").handlers.on_click({}, h.cx);
  assert.deepEqual(plain(h.state.commands.at(-1)), [
    "tab.new",
    { space: "primary", folder: "/project/live", argv: ["pi", "--resume"] },
  ]);
});

test("the rail records local agents and lists closed ones with history, resume, and forget", async () => {
  const h = await harness();
  h.state.agents = [
    { address: "t9", space: "primary", app: "claude-code", program: agent, title: "✳ Fix API" },
    { address: "build/t1", space: "build/remote", app: "claude-code", program: agent, title: "x" },
  ];
  h.state.shared.set("frantss.closedAgents", [
    {
      address: "t7",
      app: "codex",
      program: agent,
      title: "Old task",
      cwd: "/elsewhere",
      closed: 1,
    },
    {
      address: "t8",
      app: "claude-code",
      program: agent,
      title: "Fix tabs",
      cwd: "/project/live",
      closed: Date.now() - 5 * 60_000,
    },
  ]);
  h.state.terminals = [
    { address: "t7", state: "finished", cwd: "/elsewhere" },
    { address: "t8", state: "finished", cwd: "/project/live" },
    { address: "t9", state: "live", cwd: "/project/live" },
  ];
  const records = () => h.state.shared.get("frantss.closedAgents") as any[];
  const settle = () => h.state.tasks.at(-1)({ sleep: async () => {} });
  const tree = h.render();
  assert.equal(h.state.tasks.length, 1);
  await settle();
  assert.deepEqual(plain(records().map((r) => r.address)), ["t7", "t8", "t9"]);
  assert.equal(records()[2].title, "Fix API");

  // A new title alone doesn't write shared state; the agent's last one is saved when it goes.
  const saved = records();
  h.state.agents[0].title = "✳ Fix rail";
  h.render();
  assert.equal(h.state.tasks.length, 1);
  assert.equal(records(), saved);
  h.state.agents.shift();
  h.state.terminals[2].state = "finished";
  h.render();
  assert.equal(h.state.tasks.length, 2);
  assert.deepEqual(h.state.cancelled, [h.state.tasks[0]]);
  await settle();
  assert.equal(records().find((r) => r.address === "t9").title, "Fix rail");
  assert.ok(records().find((r) => r.address === "t9").closed);

  const ids = descendants(tree)
    .map((node) => node?.elementId)
    .filter((id) => id?.startsWith("closed-"));
  assert.deepEqual(ids, ["closed-t8", "closed-t7"]);
  assert.match(text(byId(tree, "header-closed")), /Recently closed/);
  assert.equal(text(byId(tree, "closed-t8")), "fix tabs5m");

  byId(tree, "closed-t8").handlers.on_click({}, h.cx);
  assert.deepEqual(plain(h.state.commands.slice(-2)), [
    ["space.select", { id: "primary" }],
    [
      "tab.new",
      {
        space: "primary",
        folder: "/project/live",
        argv: ["hc", "read", "t8", "--lines", "100000"],
        name: "fix tabs history",
      },
    ],
  ]);
  byId(tree, "resume-t7").handlers.on_click({}, h.cx);
  assert.deepEqual(plain(h.state.commands.at(-1)), [
    "space.new",
    { folder: "/elsewhere", argv: ["codex", "--no-daemon", "resume"] },
  ]);
  assert.ok(byId(tree, "forget-t8"));
  byId(tree, "closed-t8").handlers.on_mouse_down({}, h.cx);
  assert.deepEqual(plain(h.state.overlays.at(-1).props), {
    tab: "closed",
    target: { terminal: "t8", cwd: "/project/live", name: "fix tabs", app: "claude-code" },
  });
  const calls = h.state.hcCalls.length;
  byId(tree, "forget-t8").handlers.on_click({}, h.cx);
  assert.equal(h.state.hcCalls.length, calls);
  assert.equal(h.state.overlays.at(-1).mod, "confirm");
  assert.equal(h.state.overlays.at(-1).props.command.name, "frantss.forget-history:t8");
  assert.ok(records().some((r) => r.address === "t8"));
});

test("confirmed forgetting removes only the target and keeps records added during removal", async () => {
  const h = await harness();
  const target = { address: "t/8", closed: 1 };
  h.state.shared.set("frantss.closedAgents", [target]);
  let finish;
  h.state.removalResult = new Promise((resolve) => {
    finish = resolve;
  });
  h.state.commandQueue.push("unrelated", "forget-history:t%2F8");
  h.view.init({}, h.cx);
  void h.state.tasks[0]({});
  await new Promise(setImmediate);
  assert.deepEqual(h.state.hcCalls, [["rm", "t/8"]]);
  const newer = { address: "t9", closed: 2 };
  h.state.shared.set("frantss.closedAgents", [target, newer]);
  finish({ code: 0, stdout: "", stderr: "" });
  await new Promise(setImmediate);
  assert.deepEqual(plain(h.state.shared.get("frantss.closedAgents")), [newer]);
  assert.equal(h.state.errors.length, 0);
});

test("forgetting retains history on command failure and ignores live or missing records", async () => {
  const h = await harness();
  const records = [{ address: "t8", closed: 1 }, { address: "t9" }];
  h.state.shared.set("frantss.closedAgents", records);
  for (const result of [
    Promise.resolve({ code: 1, stdout: "", stderr: "Still in use" }),
    Promise.reject(new Error("Disconnected")),
  ]) {
    h.state.removalResult = result;
    await h.view.forgetHistory("t8");
    assert.equal(h.state.shared.get("frantss.closedAgents"), records);
  }
  assert.equal(h.state.errors.length, 2);
  assert.equal((h.state.errors[0] as any).body, "Still in use");
  const count = h.state.hcCalls.length;
  await h.view.forgetHistory("t9");
  await h.view.forgetHistory("missing");
  assert.equal(h.state.hcCalls.length, count);
});

test("usage starts closed above Settings and summarizes each subscription's most used window", async () => {
  const h = await harness();
  const now = Date.now();
  h.view.subscriptionUsage.data.claude = {
    windows: [
      { label: "5h", usedPercent: 42, resetsAt: now / 1000 + 3600 },
      { label: "7d", usedPercent: 18, resetsAt: now / 1000 + 86400 },
    ],
    updatedAt: now,
  };
  h.view.subscriptionUsage.data.codex = {
    windows: [{ label: "5h", usedPercent: 91, resetsAt: now / 1000 + 38 * 60 - 30 }],
    updatedAt: now,
  };
  const tree = h.render();
  const usage = byId(tree, "subscription-usage");
  assert.ok(usage);
  assert.equal(byId(byId(tree, "frantss-rail"), "subscription-usage"), null);
  assert.ok(
    tree.childNodes.indexOf(usage) < tree.childNodes.findIndex((node) => byId(node, "settings")),
  );
  assert.equal(text(byId(usage, "usage-summary-claude")), "Claude42%");
  assert.equal(text(byId(usage, "usage-summary-codex")), "Codex91% 38m");
  assert.equal(byId(usage, "usage-claude"), null);
  assert.ok(
    byId(usage, "refresh-subscriptions").styles.some(
      ([key, value]) => key === "accessibility_label" && value === "Refresh subscription usage",
    ),
  );
  byId(usage, "header-usage").handlers.on_click({}, h.cx);
  assert.equal(JSON.stringify(h.state.shared.get("frantss.collapsed")), '["usage:open"]');
});

test("open usage shows each window's reset and marks stale and failed reads", async () => {
  const h = await harness();
  const now = Date.now();
  h.state.shared.set("frantss.collapsed", ["usage:open"]);
  h.view.subscriptionUsage.data.claude = {
    windows: [
      { label: "5h", usedPercent: 42, resetsAt: now / 1000 + 3600 },
      { label: "7d", usedPercent: 75, resetsAt: now / 1000 - 1 },
    ],
    updatedAt: now - 900000,
    error: "Offline",
  };
  const usage = byId(h.render(), "subscription-usage");
  assert.equal(byId(usage, "usage-summary-claude"), null);
  assert.match(text(byId(usage, "header-usage")), /Usage15m ago/);
  assert.equal(text(byId(usage, "usage-claude")), "ClaudeStale5h42%1h 0m7d——Offline");
  assert.equal(text(byId(usage, "usage-codex")), "CodexWaiting for usage…");
});

const checkoutOutput = (trees: { path: string; branch?: string }[]) =>
  trees
    .map(
      (tree) =>
        `worktree ${tree.path}\0HEAD 0123456789abcdef\0${tree.branch ? `branch refs/heads/${tree.branch}` : "detached"}\0\0`,
    )
    .join("");

async function worktreeHarness() {
  const h = await harness();
  h.state.worktreeOutput = checkoutOutput([
    { path: "/project", branch: "main" },
    { path: "/home/.herdr/worktrees/project/feature", branch: "feature" },
    { path: "/new checkout", branch: "new-branch" },
    { path: "/detached" },
  ]);
  h.view.checkoutRoots[key("/project/live")] = "/project";
  return h;
}

async function finishWorktreeRefresh(h) {
  if (h.view.pendingBulkRemoval && !h.view.pendingBulkRemoval.started)
    h.view.inspectBulkWorktreeRemoval(h.view.pendingBulkRemoval.token, h.cx);
  await h.state.tasks.pop()(h.cx);
}

test("worktree discovery is lazy, never runs during render, and routes one query per repository", async () => {
  const h = await worktreeHarness();
  const group = key("/project/.git");
  let tree = h.render();
  assert.equal(text(byId(tree, `worktrees-${group}`)), "Other worktrees");
  const refresh = byId(tree, `worktrees-refresh-${group}`);
  assert.ok(refresh);
  assert.deepEqual(h.state.worktreeReads, []);
  h.view.refreshWorktrees(h.cx);
  assert.deepEqual(h.state.worktreeReads, []);
  byId(tree, `worktrees-${group}`).handlers.on_click({}, h.cx);
  assert.match(text(byId(h.render(), `worktrees-loading-${group}`)), /Checking worktrees/);
  assert.deepEqual(h.state.worktreeReads, []);
  await finishWorktreeRefresh(h);
  assert.deepEqual(plain(h.state.worktreeReads), [
    [["worktree", "list", "--porcelain", "-z"], "/home/.herdr/worktrees/project/feature", null],
  ]);
  tree = h.render();
  h.render();
  h.view.refreshWorktrees(h.cx);
  await finishWorktreeRefresh(h);
  assert.equal(h.state.worktreeReads.length, 1);
  byId(tree, `worktrees-${group}`).handlers.on_click({}, h.cx);
  const taskCount = h.state.tasks.length;
  h.view.refreshWorktrees(h.cx);
  assert.equal(h.state.tasks.length, taskCount);
});

test("worktree entries open on their machine, deduplicate clicks, and select a newly opened space", async () => {
  const h = await worktreeHarness();
  const group = key("/project/.git", "build");
  h.state.shared.set("frantss.collapsed", [`worktrees:${group}`]);
  h.view.refreshWorktrees(h.cx);
  await finishWorktreeRefresh(h);
  const rowId = `worktree-${JSON.stringify([group, "/new checkout"])}`;
  const row = byId(h.render(), rowId);
  assert.ok(row);
  h.render();
  h.view.railFocus.get(rowId).focus();
  row.handlers.on_key_down({ key: "enter" }, h.cx);
  row.handlers.on_click({}, h.cx);
  assert.deepEqual(plain(h.state.commands), [
    ["space.new", { folder: "/new checkout", machine: "build" }],
  ]);
  h.state.spaces.push(space("new-space", "/new checkout", [], { machine: "build" }));
  h.view.repos[key("/new checkout", "build")] = "/project/.git";
  await finishWorktreeRefresh(h);
  row.handlers.on_key_down({ key: "space" }, h.cx);
  assert.deepEqual(plain(h.state.commands.at(-1)), ["space.select", { id: "new-space" }]);
  assert.equal(byId(h.render(), rowId), null);
  const localGroup = key("/project/.git");
  h.state.shared.set("frantss.collapsed", [`worktrees:${localGroup}`, `worktrees:${group}`]);
  h.view.refreshWorktrees(h.cx);
  await finishWorktreeRefresh(h);
  const localRow = byId(h.render(), `worktree-${JSON.stringify([localGroup, "/new checkout"])}`);
  assert.ok(localRow);
  localRow.handlers.on_click({}, h.cx);
  assert.deepEqual(plain(h.state.commands.at(-1)), [
    "space.new",
    { folder: "/new checkout", machine: "" },
  ]);
});

test("the refresh icon stays in the heading and refreshes a collapsed list without expanding it", async () => {
  const h = await worktreeHarness();
  const group = key("/project/.git");
  const tree = h.render();
  const header = byId(tree, `worktrees-${group}`);
  const refresh = byId(header, `worktrees-refresh-${group}`);
  assert.ok(refresh);
  refresh.handlers.on_click({}, h.cx);
  assert.equal(h.state.propagationStops, 1);
  assert.equal(h.state.shared.has("frantss.collapsed"), false);
  await finishWorktreeRefresh(h);
  assert.equal(h.state.worktreeReads.length, 1);
  const taskCount = h.state.tasks.length;
  h.view.refreshWorktrees(h.cx);
  assert.equal(h.state.tasks.length, taskCount);
});

test("worktree controls appear on hover and remain visible while the row or a control has focus", async () => {
  const h = await worktreeHarness();
  const group = key("/project/.git", "build");
  h.state.shared.set("frantss.collapsed", [`worktrees:${group}`]);
  h.view.refreshWorktrees(h.cx);
  await finishWorktreeRefresh(h);
  const id = `worktree-${JSON.stringify([group, "/new checkout"])}`;
  let tree = h.render();
  for (const action of ["open", "thread", "remove"])
    assert.equal(byId(tree, `${id}-${action}`), null);
  tree = hoverRender(h, id);
  for (const action of ["open", "thread", "remove"]) assert.ok(byId(tree, `${id}-${action}`));
  h.view.hovered = null;
  h.view.railFocus.get(id).focus();
  tree = h.render();
  assert.ok(byId(tree, `${id}-open`));
  h.view.railFocus.get(`${id}-thread`).focus();
  tree = h.render();
  assert.ok(byId(tree, `${id}-thread`));
  byId(tree, id).handlers.on_key_down({ key: "enter" }, h.cx);
  assert.equal(h.state.commands.length, 0, "a child's key must not activate its parent row");
  byId(tree, `${id}-thread`).handlers.on_click({}, h.cx);
  assert.equal(h.state.propagationStops, 1);
  assert.equal(h.state.overlays.at(-1).mod, "frantss-thread");
  assert.equal(h.state.overlays.at(-1).props.folder, "/new checkout");
  assert.equal(h.state.overlays.at(-1).props.machine, "build");
  assert.equal(h.state.commands.length, 0);
  h.view.railFocus.get(`${id}-thread`).release();
  assert.equal(byId(h.render(), `${id}-thread`), null);
  assert.equal(h.state.worktreeReads.length, 1);
  h.state.shared.set("frantss.collapsed", []);
  h.render();
  assert.equal(h.view.railFocus.has(id), false);
  assert.equal(h.view.railFocus.has(`${id}-thread`), false);
  h.state.shared.set("frantss.collapsed", ["spaces"]);
  h.render();
  assert.equal(h.view.railFocus.has(id), false);
});

test("the main checkout has no Remove control and cannot start removal", async () => {
  const h = await worktreeHarness();
  const group = key("/project/.git");
  h.state.spaces = h.state.spaces.filter((space) => space.id === "worktree");
  h.state.panes = h.state.panes.filter((pane) => pane.tab === "t-worktree");
  h.state.shared.set("frantss.collapsed", [`worktrees:${group}`]);
  h.view.refreshWorktrees(h.cx);
  await finishWorktreeRefresh(h);
  const id = `worktree-${JSON.stringify([group, "/project"])}`;
  const tree = hoverRender(h, id);
  assert.ok(byId(tree, `${id}-open`));
  assert.ok(byId(tree, `${id}-thread`));
  assert.equal(byId(tree, `${id}-remove`), null);
  const main = h.view.worktrees.state(group).worktrees.find((tree) => tree.path === "/project");
  const tasks = h.state.tasks.length;
  h.view.requestWorktreeRemoval(main, group, h.cx);
  assert.equal(h.state.tasks.length, tasks);
  assert.equal(h.state.removalGitReads.length, 0);
});

async function removalHarness() {
  const h = await worktreeHarness();
  const group = key("/project/.git", "build");
  h.state.shared.set("frantss.collapsed", [`worktrees:${group}`]);
  h.view.refreshWorktrees(h.cx);
  await finishWorktreeRefresh(h);
  const id = `worktree-${JSON.stringify([group, "/new checkout"])}`;
  byId(hoverRender(h, id), `${id}-remove`).handlers.on_click({}, h.cx);
  return { ...h, group, id };
}

function removalToken(h) {
  return h.state.overlays.at(-1).props.command.name.slice("frantss.remove-worktree:".length);
}

test("removal checks local changes first and only deletes after confirmation, keeping normal Git guards", async () => {
  const h = await removalHarness();
  assert.equal(h.state.removalGitReads.length, 0);
  await finishWorktreeRefresh(h);
  assert.equal(h.state.removalGitReads.length, 3);
  assert.equal(h.state.commands.length, 0);
  const dialog = h.state.overlays.at(-1);
  assert.equal(dialog.mod, "confirm");
  assert.match(dialog.props.title, /Remove new-branch/);
  assert.match(dialog.props.detail, /including ignored files/);
  assert.match(dialog.props.detail, /Git branch is kept/);
  assert.match(dialog.props.detail, /new local changes/);
  const token = removalToken(h);
  h.state.onWorktreeRemoval = (path) => {
    assert.equal(path, "/new checkout");
    h.state.worktreeOutput = checkoutOutput([
      { path: "/project", branch: "main" },
      { path: "/detached" },
    ]);
  };
  h.view.confirmedWorktreeRemoval(token, h.cx);
  h.view.confirmedWorktreeRemoval(token, h.cx);
  await finishWorktreeRefresh(h);
  assert.equal(h.state.removalGitReads.length, 6);
  assert.deepEqual(plain(h.state.removalGitReads.at(-1)), [
    ["--git-dir", "/project/.git", "worktree", "remove", "/new checkout"],
    { on: "build" },
  ]);
  await finishWorktreeRefresh(h);
  assert.equal(byId(h.render(), h.id), null);
  assert.equal(h.state.errors.length, 0);
  assert.equal(
    h.state.commands.some(([name]) => name === "space.close"),
    false,
  );
});

test("dirty worktrees stop before confirmation and an opened worktree stops before deletion", async () => {
  const dirty = await removalHarness();
  dirty.state.dirtyWorktree = true;
  await finishWorktreeRefresh(dirty);
  assert.equal(dirty.state.overlays.length, 0);
  assert.match(plain(dirty.state.errors)[0].body, /Commit or move/);
  assert.equal(dirty.state.removalGitReads.length, 3);
  assert.equal(dirty.view.pendingRemoval, null);
  const opened = await removalHarness();
  await finishWorktreeRefresh(opened);
  opened.state.spaces.push(space("opened", "/new checkout", [], { machine: "build" }));
  opened.view.confirmedWorktreeRemoval(removalToken(opened), opened.cx);
  await finishWorktreeRefresh(opened);
  assert.equal(opened.state.removalGitReads.length, 3);
  assert.match(plain(opened.state.errors)[0].body, /Close its Herdr space first/);
});

test("a worktree opened while inspection runs never receives a removal confirmation", async () => {
  const h = await removalHarness();
  h.state.onWorktreeStatus = async () => {
    h.state.spaces.push(space("opened", "/new checkout", [], { machine: "build" }));
  };
  await finishWorktreeRefresh(h);
  assert.equal(h.state.overlays.length, 0);
  assert.match(plain(h.state.errors)[0].body, /Close its Herdr space first/);
  assert.equal(h.state.removalGitReads.length, 3);
});

test("pending space opens block removal and active removal blocks this rail's launch actions", async () => {
  const pending = await removalHarness();
  pending.view.openingWorktrees.add(JSON.stringify([pending.group, "/new checkout"]));
  await finishWorktreeRefresh(pending);
  assert.equal(pending.state.overlays.length, 0);
  assert.match(plain(pending.state.errors)[0].body, /Close its Herdr space first/);
  const h = await removalHarness();
  await finishWorktreeRefresh(h);
  h.view.confirmedWorktreeRemoval(removalToken(h), h.cx);
  const tree = h.view.worktrees
    .state(h.group)
    .worktrees.find((tree) => tree.path === "/new checkout");
  h.view.openWorktree(tree, h.group, h.cx);
  h.view.newWorktreeThread(tree, h.group);
  assert.equal(h.state.commands.length, 0);
  assert.equal(h.state.overlays.length, 1);
  assert.equal(h.state.errors.length, 2);
  assert.equal(h.view.removingWorktrees.size, 1);
  h.state.worktreeRemoveResult = { code: 128, stdout: "", stderr: "Locked worktree" };
  await finishWorktreeRefresh(h);
  assert.equal(h.view.removingWorktrees.size, 0);
});

test("failed removal reports Git's refusal without force, and stale confirmations do nothing", async () => {
  const h = await removalHarness();
  await finishWorktreeRefresh(h);
  const oldToken = removalToken(h);
  const tree = h.view.worktrees
    .state(h.group)
    .worktrees.find((tree) => tree.path === "/new checkout");
  h.view.requestWorktreeRemoval(tree, h.group, h.cx);
  await finishWorktreeRefresh(h);
  const tasks = h.state.tasks.length;
  h.view.confirmedWorktreeRemoval(oldToken, h.cx);
  assert.equal(h.state.tasks.length, tasks);
  h.state.worktreeRemoveResult = { code: 128, stdout: "", stderr: "Worktree has local changes" };
  h.view.confirmedWorktreeRemoval(removalToken(h), h.cx);
  await finishWorktreeRefresh(h);
  assert.match(plain(h.state.errors)[0].body, /Worktree has local changes/);
  assert.equal(
    h.state.removalGitReads.some(([args]) => args.includes("--force")),
    false,
  );
  assert.ok(byId(h.render(), h.id));
});

test("bulk removal opens the checking dialog before any Git checks start", async () => {
  const h = await worktreeHarness();
  const group = key("/project/.git", "build");
  h.view.requestBulkWorktreeRemoval(group, h.cx);
  assert.equal(h.state.overlays.at(-1)?.mod, "frantss-worktree-removal");
  assert.equal(h.state.overlays.at(-1).props.token, h.view.pendingBulkRemoval.token);
  assert.equal(h.view.pendingBulkRemoval.plan, null);
  assert.equal(h.state.removalGitReads.length, 0);
});

async function bulkRemovalHarness() {
  const h = await worktreeHarness();
  const group = key("/project/.git", "build");
  h.view.requestBulkWorktreeRemoval(group, h.cx);
  return { ...h, group };
}

function bulkRemovalToken(h) {
  return h.state.overlays.at(-1).props.command.name.slice("frantss.remove-worktrees:".length);
}

test("Remove all is a heading hover/focus control and does not expand the list or query during render", async () => {
  const h = await worktreeHarness();
  const group = key("/project/.git");
  const header = `worktrees-${group}`;
  const id = `worktrees-remove-all-${group}`;
  assert.equal(byId(h.render(), id), null);
  assert.ok(byId(hoverRender(h, header), id));
  h.view.hovered = null;
  h.view.railFocus.get(id).focus();
  const tree = h.render();
  assert.ok(byId(tree, id));
  assert.ok(byId(tree, `worktrees-refresh-${group}`));
  assert.deepEqual(h.state.removalGitReads, []);
  byId(tree, id).handlers.on_click({}, h.cx);
  assert.equal(h.state.propagationStops, 1);
  assert.equal(h.state.shared.has("frantss.collapsed"), false);
  await finishWorktreeRefresh(h);
  assert.equal(h.state.overlays.at(-1).mod, "frantss-worktree-removal");
  assert.equal(
    h.state.removalGitReads.some(([args]) => args.includes("remove")),
    false,
  );
});

test("bulk removal confirms fresh candidates, reports skips and keeps branches and machine routing", async () => {
  const h = await bulkRemovalHarness();
  await finishWorktreeRefresh(h);
  const dialog = h.state.overlays.at(-1);
  assert.equal(dialog.mod, "frantss-worktree-removal");
  assert.deepEqual(plain(h.state.bulkRemovalResults.at(-1).paths), [
    "/detached",
    "/home/.herdr/worktrees/project/feature",
    "/new checkout",
  ]);
  assert.match(h.state.bulkRemovalResults.at(-1).skipped[0].reason, /Main checkout is protected/);
  const token = bulkRemovalToken(h);
  h.view.confirmedBulkWorktreeRemoval(token, h.cx);
  h.view.confirmedBulkWorktreeRemoval(token, h.cx);
  assert.equal(h.view.removingWorktrees.size, 3);
  await finishWorktreeRefresh(h);
  const removals = h.state.removalGitReads.filter(([args]) => args[3] === "remove");
  assert.equal(removals.length, 3);
  for (const [args, options] of removals) {
    assert.equal(options.on, "build");
    assert.equal(args.includes("--force"), false);
  }
  assert.equal(h.view.removingWorktrees.size, 0);
  assert.equal(h.view.busyBulkRemoval.size, 0);
  assert.match(plain(h.state.errors).at(-1).title, /Removed 3 worktrees; skipped 1/);
  assert.equal(h.state.commands.length, 0);
});

test("bulk removal skips newly opened and dirty candidates, and blocks rail launches while running", async () => {
  const h = await bulkRemovalHarness();
  await finishWorktreeRefresh(h);
  h.state.spaces.push(space("opened", "/detached", [], { machine: "build" }));
  h.state.dirtyWorktrees.add("/new checkout");
  h.view.confirmedBulkWorktreeRemoval(bulkRemovalToken(h), h.cx);
  const tree = { path: "/new checkout", main: false };
  h.view.openWorktree(tree, h.group, h.cx);
  h.view.newWorktreeThread(tree, h.group);
  assert.equal(h.state.commands.length, 0);
  assert.equal(h.state.overlays.length, 1);
  await finishWorktreeRefresh(h);
  const paths = h.state.removalGitReads
    .filter(([args]) => args[3] === "remove")
    .map(([args]) => args[4]);
  assert.deepEqual(plain(paths), ["/home/.herdr/worktrees/project/feature"]);
  const summary = plain(h.state.errors).at(-1);
  assert.match(summary.title, /Removed 1 worktree; skipped 3/);
  assert.match(summary.body, /local changes/);
  assert.match(summary.body, /open or opening/);
});

test("bulk removal protects spaces in checkout subdirectories before discovery or root lookup", async () => {
  for (const duringInspection of [false, true]) {
    const h = await bulkRemovalHarness();
    const addSpace = () =>
      h.state.spaces.push(space("nested", "/new checkout/src", [], { machine: "build" }));
    if (duringInspection)
      h.state.onWorktreeStatus = async (path) => {
        if (path === "/new checkout") addSpace();
      };
    else addSpace();
    assert.equal(h.view.worktrees.state(h.group), undefined);
    await finishWorktreeRefresh(h);
    assert.equal(
      h.view.pendingBulkRemoval.plan.targets.some((target) => target.path === "/new checkout"),
      false,
    );
    assert.ok(
      h.view.pendingBulkRemoval.plan.skipped.some(
        (item) => item.path === "/new checkout" && /open or opening/.test(item.reason),
      ),
    );
  }
});

test("bulk removal with no eligible candidates updates the existing dialog without enabling removal", async () => {
  const h = await bulkRemovalHarness();
  h.state.dirtyWorktree = true;
  await finishWorktreeRefresh(h);
  assert.equal(h.state.overlays.length, 1);
  assert.deepEqual(plain(h.state.bulkRemovalResults.at(-1).paths), []);
  assert.match(h.state.bulkRemovalResults.at(-1).skipped[0].reason, /local changes/);
  assert.equal(h.view.busyBulkRemoval.size, 0);
});

test("slow inspection keeps the dialog visible, blocks early confirmation and drops cancelled results", async () => {
  const h = await bulkRemovalHarness();
  const token = bulkRemovalToken(h);
  let entered;
  const checking = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.state.onWorktreeStatus = async () => {
    entered();
    await gate;
  };
  h.view.inspectBulkWorktreeRemoval(token, h.cx);
  const task = h.state.tasks.pop()(h.cx);
  await checking;
  assert.equal(h.state.overlays.length, 1);
  assert.equal(h.view.pendingBulkRemoval.plan, null);
  const count = h.state.tasks.length;
  h.view.confirmedBulkWorktreeRemoval(token, h.cx);
  assert.equal(h.state.tasks.length, count);
  h.view.cancelBulkWorktreeRemoval(token);
  release();
  await task;
  assert.equal(h.state.bulkRemovalResults.length, 0);
  assert.equal(h.view.pendingBulkRemoval, null);
  assert.equal(h.view.busyBulkRemoval.size, 0);
});

test("superseded inspection cannot publish results or unlock a newer inspection", async () => {
  const h = await bulkRemovalHarness();
  const oldToken = bulkRemovalToken(h);
  let entered;
  const checking = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.state.onWorktreeStatus = async () => {
    entered();
    await gate;
  };
  h.view.inspectBulkWorktreeRemoval(oldToken, h.cx);
  const oldTask = h.state.tasks.pop()(h.cx);
  await checking;
  h.view.cancelBulkWorktreeRemoval(oldToken);
  h.view.requestBulkWorktreeRemoval(h.group, h.cx);
  const token = bulkRemovalToken(h);
  release();
  await oldTask;
  assert.equal(h.state.bulkRemovalResults.length, 0);
  assert.equal(h.view.pendingBulkRemoval.token, token);
  assert.ok(h.view.busyBulkRemoval.has(h.group));
  await finishWorktreeRefresh(h);
  assert.equal(h.state.bulkRemovalResults.at(-1).token, token);
});

test("inventory failures update the open dialog without allowing confirmation", async () => {
  const h = await bulkRemovalHarness();
  h.state.worktreeFailure = true;
  await finishWorktreeRefresh(h);
  assert.equal(h.state.overlays.length, 1);
  assert.match(h.state.bulkRemovalResults.at(-1).error, /Inventory unavailable/);
  assert.equal(h.view.pendingBulkRemoval.plan, null);
  const tasks = h.state.tasks.length;
  h.view.confirmedBulkWorktreeRemoval(bulkRemovalToken(h), h.cx);
  assert.equal(h.state.tasks.length, tasks);
});

test("bulk removal deduplicates inspection, fails closed and ignores superseded confirmation tokens", async () => {
  const h = await bulkRemovalHarness();
  const tasks = h.state.tasks.length;
  h.view.requestBulkWorktreeRemoval(h.group, h.cx);
  assert.equal(h.state.tasks.length, tasks);
  await finishWorktreeRefresh(h);
  const oldToken = bulkRemovalToken(h);
  h.view.requestBulkWorktreeRemoval(h.group, h.cx);
  await finishWorktreeRefresh(h);
  const before = h.state.tasks.length;
  h.view.confirmedBulkWorktreeRemoval(oldToken, h.cx);
  assert.equal(h.state.tasks.length, before);
  h.state.worktreeFailure = true;
  h.view.confirmedBulkWorktreeRemoval(bulkRemovalToken(h), h.cx);
  await finishWorktreeRefresh(h);
  assert.equal(
    h.state.removalGitReads.some(([args]) => args[3] === "remove"),
    false,
  );
  assert.match(plain(h.state.errors).at(-1).title, /Removed 0 worktrees/);
  assert.equal(h.view.removingWorktrees.size, 0);
});

test("collapsed workspace and section stop discovery, and remote checks retain machine identity", async () => {
  const h = await worktreeHarness();
  const group = key("/project/.git", "build");
  for (const closed of ["spaces", `workspace:${group}`]) {
    h.state.shared.set("frantss.collapsed", [`worktrees:${group}`, closed]);
    const taskCount = h.state.tasks.length;
    h.view.refreshWorktrees(h.cx);
    assert.equal(h.state.tasks.length, taskCount);
  }
  h.state.shared.set("frantss.collapsed", [`worktrees:${group}`]);
  h.view.refreshWorktrees(h.cx);
  await finishWorktreeRefresh(h);
  assert.equal(h.state.worktreeReads.length, 1);
  assert.equal(h.state.worktreeReads[0][2], "build");
});

test("worktree matching uses checkout roots, preserves multiple spaces, and prefers nested checkouts", async () => {
  const h = await worktreeHarness();
  const group = key("/project/.git");
  h.state.worktreeOutput = checkoutOutput([
    { path: "/project", branch: "main" },
    { path: "/project/nested", branch: "nested" },
  ]);
  h.state.spaces = [space("a", "/project/nested/src", []), space("b", "/project/nested/src", [])];
  h.state.panes = [];
  h.view.repos[key("/project/nested/src")] = "/project/.git";
  h.state.shared.set("frantss.collapsed", [`worktrees:${group}`]);
  h.view.refreshWorktrees(h.cx);
  await finishWorktreeRefresh(h);
  const tree = h.render();
  assert.ok(byId(tree, "space-a"));
  assert.ok(byId(tree, "space-b"));
  assert.ok(byId(tree, `worktree-${JSON.stringify([group, "/project"])}`));
  assert.equal(byId(tree, `worktree-${JSON.stringify([group, "/project/nested"])}`), null);
});

test("Unix backslashes remain distinct from directory separators in checkout paths", async () => {
  const h = await worktreeHarness();
  const group = key("/project/.git");
  const literal = "/project/a\\b";
  const nested = "/project/a/b";
  h.state.worktreeOutput = checkoutOutput([
    { path: literal, branch: "literal" },
    { path: nested, branch: "nested" },
  ]);
  h.state.spaces = [space("literal", literal, [])];
  h.state.panes = [];
  h.view.repos[key(literal)] = "/project/.git";
  h.view.checkoutRoots[key(literal)] = literal;
  h.state.shared.set("frantss.collapsed", [`worktrees:${group}`]);
  h.view.refreshWorktrees(h.cx);
  await finishWorktreeRefresh(h);
  const tree = h.render();
  assert.equal(byId(tree, `worktree-${JSON.stringify([group, literal])}`), null);
  const unopened = byId(tree, `worktree-${JSON.stringify([group, nested])}`);
  assert.ok(unopened);
  unopened.handlers.on_click({}, h.cx);
  assert.deepEqual(plain(h.state.commands.at(-1)), ["space.new", { folder: nested, machine: "" }]);
});

test("unqueried worktrees do no matching and cached matching visits only each repository's spaces", async () => {
  const h = await harness();
  const count = 100;
  h.state.spaces = Array.from({ length: count }, (_, i) => space(`s${i}`, `/repo-${i}`, []));
  h.state.panes = [];
  h.state.shared.set("frantss.workspaces", []);
  h.view.repos = Object.fromEntries(
    h.state.spaces.map((space) => [key(space.folder), `${space.folder}/.git`]),
  );
  h.view.checkoutRoots = Object.fromEntries(
    h.state.spaces.map((space) => [key(space.folder), space.folder]),
  );
  const match = h.view.worktreeSpaces;
  let visits = 0;
  h.view.worktreeSpaces = function (key, snapshot, list) {
    visits += (list ?? snapshot.spaces).length;
    return match.call(this, key, snapshot, list);
  };
  h.render();
  assert.equal(visits, 0);
  h.view.worktrees.state = (group) => {
    const [, gitDir] = JSON.parse(group);
    return { worktrees: [{ path: gitDir.slice(0, -5), branch: "main", head: "abc" }] };
  };
  h.render();
  assert.equal(visits, count);
  assert.equal(h.state.worktreeReads.length, 0);
});

test("worktree errors retain cached rows, show stale state, and allow explicit retry", async () => {
  const h = await worktreeHarness();
  const group = key("/project/.git");
  h.state.shared.set("frantss.collapsed", [`worktrees:${group}`]);
  h.state.worktreeFailure = true;
  h.view.refreshWorktrees(h.cx);
  await finishWorktreeRefresh(h);
  assert.match(text(byId(h.render(), `worktrees-${group}`)), /Unavailable/);
  h.state.worktreeFailure = false;
  byId(h.render(), `worktrees-refresh-${group}`).handlers.on_click({}, h.cx);
  await finishWorktreeRefresh(h);
  h.state.worktreeFailure = true;
  byId(h.render(), `worktrees-refresh-${group}`).handlers.on_click({}, h.cx);
  await finishWorktreeRefresh(h);
  assert.match(text(byId(h.render(), `worktrees-${group}`)), /Stale/);
  assert.ok(byId(h.render(), `worktree-${JSON.stringify([group, "/new checkout"])}`));
  h.state.worktreeFailure = false;
  h.state.worktreeOutput = checkoutOutput([
    { path: "/project", branch: "main" },
    { path: "/home/.herdr/worktrees/project/feature", branch: "feature" },
  ]);
  byId(h.render(), `worktrees-refresh-${group}`).handlers.on_click({}, h.cx);
  await finishWorktreeRefresh(h);
  assert.match(text(byId(h.render(), `worktrees-empty-${group}`)), /No other worktrees/);
  assert.equal(byId(h.render(), `worktree-${JSON.stringify([group, "/new checkout"])}`), null);
  assert.ok(byId(h.render(), "space-worktree"));
});

test("only the rail reads usage on startup, every five minutes, and on manual refresh", async () => {
  const h = await harness();
  h.view.init({}, h.cx);
  assert.equal(h.state.timers[0].ms, 300000);
  await h.state.tasks.at(-1)(h.cx);
  assert.deepEqual(h.state.usageReads, ["claude", "codex"]);
  const usage = byId(h.render(), "refresh-subscriptions");
  usage.handlers.on_click({}, h.cx);
  await h.state.tasks.at(-1)(h.cx);
  assert.equal(h.state.usageReads.length, 4);
  h.state.timers[0].callback(h.cx);
  await h.state.tasks.at(-1)(h.cx);
  assert.equal(h.state.usageReads.length, 6);
  h.state.commandQueue.push("refresh-usage");
  void h.state.tasks[0](h.cx);
  await Promise.resolve();
  await h.state.tasks.at(-1)(h.cx);
  assert.equal(h.state.usageReads.length, 8);
  for (const role of ["top", "pane"]) {
    const other = await harness(role);
    other.view.init({}, other.cx);
    assert.equal(other.state.timers.length, 0);
    assert.equal(other.state.usageReads.length, 0);
  }
});

test("rail keyboard navigation activates the focused object, opens its menu, and ignores child keys", async () => {
  const h = await harness();
  h.render();
  let tree = h.render();
  const target = "tab-t-named";
  h.view.railFocus.get(target).focus();
  byId(tree, target).handlers.on_key_down({ key: "enter" }, h.cx);
  assert.deepEqual(plain(h.state.commands.at(-1)), ["tab.select", { id: "t-named" }]);
  byId(tree, target).handlers.on_key_down({ key: "f10", keystroke: "shift-f10" }, h.cx);
  assert.equal(h.state.overlays.at(-1).props.target.pane, "pane-t-named-Ignored title");
  byId(tree, target).handlers.on_key_down({ key: "down" }, h.cx);
  tree = h.render();
  byId(tree, "tab-t-empty").handlers.on_key_down({ key: "space" }, h.cx);
  assert.deepEqual(plain(h.state.commands.at(-1)), ["tab.select", { id: "t-empty" }]);
  h.view.railFocus.get(`group-${key("/project/.git")}`).focus();
  tree = h.render();
  const controls = byId(tree, `new-${key("/project/.git")}`);
  assert.ok(controls);
  h.view.railFocus.get(`new-${key("/project/.git")}`).focus();
  const before = h.state.shared.get("frantss.collapsed");
  byId(tree, `group-${key("/project/.git")}`).handlers.on_key_down({ key: "enter" }, h.cx);
  assert.equal(h.state.shared.get("frantss.collapsed"), before);
  assert.ok(byId(h.render(), `new-${key("/project/.git")}`));
});

test("workspace new threads prefer a Git-classified main checkout over an earlier external worktree", async () => {
  const h = await harness();
  const linked = h.state.spaces[0];
  linked.folder = "/external-feature";
  h.state.panes.find((p) => p.tab === "t-worktree").cwd = linked.folder;
  h.view.repos[key(linked.folder)] = "/project/.git";
  h.view.checkouts[key(linked.folder)] = "linked";
  h.view.checkoutRoots[key("/project/live")] = "/project";
  const group = `group-${key("/project/.git")}`;
  byId(hoverRender(h, group), `new-${key("/project/.git")}`).handlers.on_click({}, h.cx);
  assert.equal(h.state.overlays.at(-1).props.space, "primary");
  assert.equal(h.state.overlays.at(-1).props.folder, "/project");
  h.state.spaces = h.state.spaces.filter((s) => s.id !== "primary");
  byId(hoverRender(h, group), `new-${key("/project/.git")}`).handlers.on_click({}, h.cx);
  assert.equal(h.state.overlays.at(-1).props.space, "worktree");
  assert.equal(h.state.overlays.at(-1).props.folder, "/external-feature");
});

test("closed records without a saved folder retain history but cannot Resume", async () => {
  const h = await harness();
  h.state.shared.set("frantss.closedAgents", [
    { address: "no-folder", app: "codex", program: agent, title: "Old session", closed: 1 },
  ]);
  const tree = h.render();
  assert.equal(byId(tree, "resume-no-folder"), null);
  byId(tree, "closed-no-folder").handlers.on_click({}, h.cx);
  assert.deepEqual(plain(h.state.commands.at(-1)[1].argv), [
    "hc",
    "read",
    "no-folder",
    "--lines",
    "100000",
  ]);
});

test("settled tabs fold without stopping terminals, restore explicitly, and return on attention", async () => {
  const h = await harness();
  const settled = h.state.spaces
    .find((s) => s.id === "primary")
    .tabs.find((t) => t.id === "t-named");
  settled.settled = true;
  settled.status = "idle";
  let tree = h.render();
  assert.equal(byId(tree, "tab-t-named"), null);
  assert.ok(byId(tree, "settled-primary"));
  assert.deepEqual(h.state.commands, []);
  byId(tree, "settled-primary").handlers.on_click({}, h.cx);
  tree = h.render();
  byId(tree, "restore-tab-t-named").handlers.on_click({}, h.cx);
  assert.deepEqual(plain(h.state.commands.at(-1)), ["tab.unsettle", { id: "t-named" }]);
  settled.settled = false;
  assert.ok(byId(h.render(), "tab-t-named"));
  for (const status of ["blocked", "done"]) {
    settled.settled = true;
    settled.status = status;
    assert.ok(byId(h.render(), "tab-t-named"));
    assert.equal(byId(h.render(), "settled-primary"), null);
  }
});
