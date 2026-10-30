import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const key = (folder: string, machine: string | null = null) => JSON.stringify([machine, folder]);
const plain = (value) => JSON.parse(JSON.stringify(value));
const tab = (id, other = {}) => ({ id, name: id, named: false, active: false, ...other });
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
    calls: { spaces: 0, panes: 0, paneVisits: 0 },
    tasks: [] as ((cx: unknown) => Promise<void>)[],
    terminals: [] as { address: string; state: string; cwd?: string }[],
    cancelled: [] as unknown[],
  };
  function element(kind = "div", source?) {
    const node: any = {
      kind,
      source,
      elementId: undefined,
      childNodes: [],
      styles: [],
      handlers: {},
    };
    const proxy = new Proxy(node, {
      get(target, name) {
        if (name in target) return target[name];
        if (name === "then") return undefined;
        return (...args) => {
          if (name === "when") {
            if (args[0]) args[1](proxy);
          } else if (name === "child") node.childNodes.push(args[0]);
          else if (name === "children") node.childNodes.push(...args[0]);
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
  const context = vm.createContext({});
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
      props: () => ({ role: state.role, pane: state.pane }),
      theme: () => ({}),
      settings: () => ({}),
      shared: (name) => state.shared.get(name) ?? null,
      setShared: (name, value) => state.shared.set(name, value),
      setAgentOrder() {},
      run: (...args) => state.commands.push(args),
      openOverlay: (options) => state.overlays.push(options),
      exec: unused,
      pickFolder: unused,
      knownAgents: unused,
      hc: async () => ({ code: 0, stdout: JSON.stringify({ terminals: state.terminals }) }),
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
  const cx = {
    spawn: (task) => {
      state.tasks.push(task);
      return { cancel: () => state.cancelled.push(task) };
    },
    stop_propagation() {},
  };
  return { state, view, cx, render: () => view.render(cx) };
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
  assert.equal(
    descendants(byId(tree, "space-primary")).some(
      (node) => node?.source === "mods/workspace-chrome/branch.svg",
    ),
    false,
  );
  byId(tree, `new-${group}`).handlers.on_click({}, h.cx);
  assert.deepEqual(plain(h.state.overlays.at(-1).props), {
    space: "primary",
    folder: "/project/live",
    machine: null,
    repo: true,
  });
  byId(tree, "space-worktree").handlers.on_mouse_down({}, h.cx);
  assert.equal(h.state.overlays.at(-1).props.target.checkout, "linked");
  byId(tree, "tab-t-named").handlers.on_mouse_down({}, h.cx);
  assert.deepEqual(plain(h.state.overlays.at(-1).props.target), {
    id: "t-named",
    space: "primary",
    name: "Keep CASE",
  });
  byId(tree, `new-${remoteGroup}`).handlers.on_click({}, h.cx);
  assert.deepEqual(plain(h.state.overlays.at(-1).props), {
    space: "build/remote",
    folder: "/project/live",
    machine: "build",
    repo: true,
  });
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

test("rail shows a tab's panes in its place when it has more than one", async () => {
  const h = await harness();
  const tree = h.render();
  const rows = descendants(tree)
    .map((node) => node?.elementId)
    .filter((id) => /^(tab|pane)-pane-t-(agent|mod)/.test(id) || /^tab-t-(agent|mod)$/.test(id));
  assert.deepEqual(rows, [
    "pane-pane-t-agent-Zsh",
    "pane-pane-t-agent-✳ Fix API",
    "pane-pane-t-agent-✳ Later agent",
    "pane-pane-t-mod-Canvas",
    "pane-pane-t-mod-/path",
  ]);
  assert.deepEqual(
    rows.map((id) => text(byId(tree, id))),
    ["zsh", "fix api", "later agent", "canvas", "path"],
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
  assert.equal(text(byId(tree, "crumb-tab")), "fix-api");
  byId(tree, "crumb-workspace").handlers.on_click({}, h.cx);
  assert.deepEqual(plain(h.state.overlays.at(-1).props), { folder: "/project" });
  byId(tree, "crumb-space").handlers.on_click({}, h.cx);
  assert.deepEqual(plain(h.state.overlays.at(-1).props.target), {
    id: "primary",
    name: "main",
    checkout: "main",
  });
  byId(tree, "crumb-tab").handlers.on_click({}, h.cx);
  assert.equal(h.state.overlays.at(-1).props.target.name, "fix api");
  h.state.spaces.forEach((space) => {
    space.active = space.machine === "build";
  });
  const remote = h.render();
  assert.equal(text(byId(remote, "crumb-tab")), "remote-case");
  assert.equal(byId(remote, "crumb-workspace").handlers.on_click, undefined);
});

test("each new render uses current titles and cwds without retaining live-data maps", async () => {
  const h = await harness();
  h.render();
  h.state.panes[2].title = "✳ Updated task";
  h.state.panes[1].cwd = "/different";
  h.view.repos[key("/different")] = null;
  h.state.calls = { spaces: 0, panes: 0, paneVisits: 0 };
  const tree = h.render();
  assert.equal(text(byId(tree, "pane-pane-t-agent-✳ Fix API")), "updated task");
  assert.ok(byId(tree, `group-${key("/different")}`));
  assert.deepEqual(h.state.calls, { spaces: 1, panes: 1, paneVisits: h.state.panes.length });
});

test("pane headers retain their single pane lookup without workspace indexing", async () => {
  const h = await harness("pane");
  const tree = h.render();
  assert.match(text(tree), /Claude Code/);
  assert.match(text(tree), /main · agent/);
  assert.deepEqual(h.state.calls, { spaces: 0, panes: 1, paneVisits: 0 });
  byId(tree, "close-pane").handlers.on_click({}, h.cx);
  assert.deepEqual(plain(h.state.commands.at(-1)), [
    "pane.close",
    { pane: "pane-t-agent-✳ Fix API" },
  ]);
  h.state.pane = "pane-t-named-Ignored title";
  assert.equal(byId(h.render(), "close-pane"), null);
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
  assert.deepEqual(plain(h.state.commands.at(-1)), ["space.new", { folder: "/closed/first" }]);
  byId(tree, `new-${closed}`).handlers.on_click({}, h.cx);
  assert.deepEqual(plain(h.state.overlays.at(-1).props), { folder: "/closed/first", repo: true });
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
  assert.equal(text(byId(tree, "header-spaces")), "WORKSPACES400+");
  assert.ok(
    keyReads <= 20 * (savedCount + unsavedCount),
    `Expected linear key reads, received ${keyReads}`,
  );
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
  assert.match(text(byId(tree, "header-closed")), /RECENTLY CLOSED/);
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
    { folder: "/elsewhere", argv: ["codex", "resume"] },
  ]);
  assert.ok(byId(tree, "forget-t8"));
});
