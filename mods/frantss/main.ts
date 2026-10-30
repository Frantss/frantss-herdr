import type { Context, AsyncContext, Element, ClickEvent, MouseButtonEvent, Task } from "gpui-kit";
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import {
  agents,
  spaces,
  panes,
  props,
  run,
  theme,
  setAgentOrder,
  openOverlay,
  exec,
  shared,
  setShared,
  pickFolder,
  knownAgents,
  hc,
} from "herdr";

import type { AgentInfo, SpaceInfo, TabInfo, PaneInfo, Program } from "herdr";
import {
  age,
  closedAgents,
  historyArgv,
  recordAgents,
  resumeArgv,
  settleAgents,
  type AgentRecord,
  type CoreTerminal,
} from "./closed.ts";
import { button } from "./button.ts";

type Theme = Record<string, `#${string}`>;
type KnownAgent = Awaited<ReturnType<typeof knownAgents>>[number];
type RepositoryLookup = { repo: string | null; checkout: "main" | "linked" | null };
type SavedWorkspace = { folder: string };
type NamedWorkspace = SavedWorkspace & { key: string; repo: boolean; name: string };
type SpaceGroup = {
  key: string;
  repo: boolean;
  name: string;
  folder: string;
  local: boolean;
  spaces: SpaceInfo[];
};
type WorkspaceSnapshot = {
  spaces: SpaceInfo[];
  leadByTab: Map<string, PaneInfo>;
  panesByTab: Map<string, PaneInfo[]>;
  cwdBySpace: Map<string, string>;
  placeBySpace: Map<string, string>;
};
type RailRow = {
  id: string;
  current?: boolean;
  lit?: boolean;
  dim?: boolean;
  strong?: boolean;
  small?: boolean;
  indent?: number;
  lead?: Element | false;
  text: string;
  value?: string;
  end?: Element;
  onClick: (event: ClickEvent, cx: Context) => unknown;
  onMenu?: (event: MouseButtonEvent, cx: Context) => unknown;
  collapsed?: boolean;
  agent?: boolean;
};
type RailSection = {
  id: string;
  title: string;
  count?: number;
  status?: string;
  action?: Element;
  rows: RailRow[];
};

const GROUPS = [
  { status: "blocked", label: "NEEDS YOU" },
  { status: "working", label: "WORKING" },
  { status: "done", label: "UNREAD" },
  { status: "idle", label: "IDLE" },
];

// The rail places every item itself, so items, markers and the bar can glide between places.
// `emptyGap`: after a section with no rows, so empty agent groups sit close together.
const RAIL = { pad: 16, header: 24, row: 24, rowGap: 2, sectionGap: 16, emptyGap: 6 };
// Close to the site's dock ease (300ms, no overshoot); gpui-kit has no cubic-bezier easing.
const GLIDE = { response: 300, damping: 1 };
const glide = (e: Element, y: number) => e.absolute().top(y).spring("top", GLIDE);

// `status`: an agent state, which colors the label (theme colors named working, blocked, done, idle).
const label = (t: Theme, text: string, status: string) =>
  div()
    .flex_none()
    .text_size(10)
    .text_color(t[status] ?? t.dim)
    .child(text);
const icon = (t: Theme, program: Program, size = 14) =>
  !program?.icon
    ? null
    : (program.tint ? svg(program.icon).text_color(t.muted) : image(program.icon))
        .size(size)
        .flex_none();
// Only blocked pulses: a loop redraws the whole window every frame, and agents work for long stretches.
const dot = (t: Theme, status: string) =>
  div()
    .size(6)
    .rounded(3)
    .flex_none()
    .bg(t[status] ?? t.dim)
    .when(status === "blocked", (e) => e.loop("opacity", { from: 0.35, to: 1, period: 900 }));

// Opens the right-click menu with the props Herdr gives it: `tab` names which menu, `target` what it acts on.
// A popup is as tall as its items; height is only the most.
const menu = (tab: string, target: Record<string, unknown>) =>
  openOverlay({
    mod: "frantss-menu",
    kind: "popup",
    width: 320,
    height: 260,
    props: { tab, target },
  });

// A space's or tab's status dot, only when something in it is going on.
const statusDot = (t: Theme, status: string) =>
  status && status !== "idle" ? dot(t, status) : null;
// The rail's + is this wide, so rows without one can keep their dots in the same column.
const PLUS_WIDTH = 20;
const URGENT = ["blocked", "done", "working"];

// What a program says it is doing, from its terminal title: Claude Code names its thread there
// ("✳ Fix tab width"). Spinner glyphs go; paths, user@host and the program's own name aren't
// telling (the agents mod's rule). Null when there is nothing telling.
function threadTitle(title: string, program: Program) {
  const live = (title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
  const telling =
    live &&
    live !== program?.name &&
    live.toLowerCase() !== program?.key &&
    !/^[~/]|^[A-Za-z]:\\/.test(live) &&
    !live.includes("@");
  return telling ? live : null;
}

const base = (path: string) => path.replace(/\/+$/, "").split("/").pop();
// A repo's own folder from its git folder (`frantssb/.git`); a bare repo is its git folder (`frantssb.git`).
const repoRoot = (gitDir: string) => gitDir.replace(/\/\.git$/, "");
const repoName = (gitDir: string) => base(repoRoot(gitDir)).replace(/\.git$/, "");
const repositoryLookups = new Map<string, Promise<RepositoryLookup>>();

function discoverRepository(key: string): Promise<RepositoryLookup> {
  let lookup = repositoryLookups.get(key);
  if (!lookup) {
    const [on, cwd] = JSON.parse(key);
    lookup = (async () => {
      const git = (args: string[]) => exec("git", args, { cwd, on }).catch((): null => null);
      const [common, top] = await Promise.all([
        git(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
        git(["rev-parse", "--show-toplevel"]),
      ]);
      const repo = common?.code === 0 ? common.stdout.trim() : null;
      const checkout =
        repo && top?.code === 0 ? (repo === `${top.stdout.trim()}/.git` ? "main" : "linked") : null;
      return { repo, checkout };
    })();
    repositoryLookups.set(key, lookup);
  }
  return lookup;
}

// The workspaces you added, kept in shared state (persisted, and the workspace menu changes it):
// [{ folder }], folders on this machine. They stay in the rail when none of their spaces is open.
const WORKSPACES = "frantss.workspaces";
const savedWorkspaces = () => (shared(WORKSPACES) as SavedWorkspace[] | null) ?? [];
// The agents each machine has ("" for this one), as frantss-new-menu and frantss-thread keep them; the
// rail fills it when it starts, so those open with a fresh list.
const AGENTS = "frantss.agents";
async function refreshAgents(machine: string) {
  const found = await knownAgents({ on: machine || null });
  const known = (shared(AGENTS) as Record<string, KnownAgent[]> | null) ?? {};
  if (JSON.stringify(found) !== JSON.stringify(known[machine]))
    setShared(AGENTS, { ...known, [machine]: found });
}
const folderKey = (folder: string) => JSON.stringify([null, folder]);
// Each space's workspace key, published by the rail for other panels (the agent graph's Workspace filter).
const SPACE_WORKSPACES = "frantss.spaceWorkspaces";
// What you closed in the rail, kept in shared state (persisted): sections by id ("spaces" or an agent
// status), workspaces as "workspace:<key>". Spaces are closed unless active, so for them it keeps what
// you chose either way: "space:<id>:closed" or "space:<id>:open".
const COLLAPSED = "frantss.collapsed";
const collapsedIds = () => (shared(COLLAPSED) as string[] | null) ?? [];
const toggleCollapsed = (id: string) =>
  setShared(
    COLLAPSED,
    collapsedIds().includes(id)
      ? collapsedIds().filter((other) => other !== id)
      : [...collapsedIds(), id],
  );
// The local agents the rail has seen, kept in shared state (persisted) so the rail lists them after
// their tab closes (see closed.ts).
const CLOSED_AGENTS = "frantss.closedAgents";
const agentRecords = () => (shared(CLOSED_AGENTS) as AgentRecord[] | null) ?? [];
const saveRecords = (records: AgentRecord[]) => {
  if (JSON.stringify(records) !== JSON.stringify(agentRecords())) setShared(CLOSED_AGENTS, records);
};
const chevron = (t: Theme, collapsed: boolean) =>
  svg(`mods/frantss-files/chevron-${collapsed ? "right" : "down"}.svg`)
    .size(10)
    .flex_none()
    .text_color(t.dim);
function workspaceSnapshot(): WorkspaceSnapshot {
  const all = spaces();
  const spaceByTab = new Map<string, string>();
  for (const space of all) for (const tab of space.tabs) spaceByTab.set(tab.id, space.id);
  const leadByTab = new Map<string, PaneInfo>();
  const panesByTab = new Map<string, PaneInfo[]>();
  const cwdBySpace = new Map<string, string>();
  // Cwd follows the first pane in global order; tab names prefer the first agent pane.
  for (const pane of panes()) {
    const lead = leadByTab.get(pane.tab);
    if (!lead || (!lead.program?.agent && pane.program?.agent)) leadByTab.set(pane.tab, pane);
    panesByTab.set(pane.tab, [...(panesByTab.get(pane.tab) ?? []), pane]);
    const space = spaceByTab.get(pane.tab);
    if (space !== undefined && pane.cwd && !cwdBySpace.has(space)) cwdBySpace.set(space, pane.cwd);
  }
  const placeBySpace = new Map<string, string>();
  for (const space of all) {
    if (!cwdBySpace.has(space.id)) cwdBySpace.set(space.id, space.folder);
    placeBySpace.set(space.id, JSON.stringify([space.machine ?? null, cwdBySpace.get(space.id)]));
  }
  return { spaces: all, leadByTab, panesByTab, cwdBySpace, placeBySpace };
}

// A pane is called after its agent's thread, else its program, in lower case.
const paneName = (pane: PaneInfo | undefined) =>
  (threadTitle(pane?.title, pane?.program) ?? pane?.program?.name ?? "terminal").toLowerCase();

// An unnamed tab is called after its lead pane (its first agent, else its first pane), as the toolbar does.
const tabName = (tab: TabInfo, lead: PaneInfo | undefined) =>
  tab.named ? tab.name : paneName(lead);

// "Personal herdr layout" -> "personal-herdr-layout", as the site's paths read.
const slugify = (text: string) =>
  (text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");

// A space you named shows that name; else its branch, else Herdr's name for it (its repo or folder).
const spaceName = (s: SpaceInfo) => (s.named ? s.name : (s.branch ?? s.name));

export default class Frantss extends View {
  declare repos: Record<string, string | null>;
  declare checkouts: Record<string, "main" | "linked" | null>;
  declare marks: Record<string, number>;
  declare terminalsKey: string;
  // The local agents shown since the rail last recorded them, by address.
  declare seenAgents: Map<string, AgentInfo>;
  declare settling: Task;
  init(_p: unknown, _cx: AsyncContext) {
    // The rail and the breadcrumb both name workspaces by repo.
    if (props()?.role !== "rail" && props()?.role !== "top") return;
    this.repos = {}; // place key -> its repo's git folder, null outside a repo; a folder's repo doesn't change
    // place key -> "main" (a repo's own checkout), "linked" (a worktree) or null, once looked up: the space
    // menu's worktree items, handed to it so it opens without asking git itself.
    this.checkouts = {};
    if (props()?.role === "rail")
      for (const machine of new Set(["", ...spaces().map((s) => s.machine ?? "")]))
        refreshAgents(machine).catch(() => {});
  }

  // Looks up places it hasn't seen. Render runs whenever spaces, panes or shared state change, so
  // no timer is needed.
  track(cx: Context, snapshot: WorkspaceSnapshot, role: string) {
    if (!this.repos) return;
    const keys = [
      ...snapshot.placeBySpace.values(),
      ...savedWorkspaces().map((w) => folderKey(w.folder)),
    ];
    for (const key of keys) if (!(key in this.repos)) this.lookUp(key, cx);
    if (role === "rail") this.publishWorkspaces(snapshot);
  }

  // Asks the core which terminals finished whenever an agent or a pane goes (a closed tab takes
  // both), and records the local agents with its answer. Titles change often and a shared write
  // re-renders every mod, so until then the latest of each agent stays here.
  trackAgents(cx: Context, list: AgentInfo[], snapshot: WorkspaceSnapshot) {
    const remote = new Set(snapshot.spaces.filter((s) => s.machine).map((s) => s.id));
    const local = list.filter((a) => !remote.has(a.space));
    this.seenAgents ??= new Map();
    for (const a of local) this.seenAgents.set(a.address, a);
    const shown = [
      ...local.map((a) => a.address),
      ...[...snapshot.panesByTab.values()].flat().map((pane) => pane.terminal),
    ];
    const key = JSON.stringify(shown);
    if (key === this.terminalsKey) return;
    this.terminalsKey = key;
    const live = new Set(local.map((a) => a.address)),
      shownSet = new Set(shown);
    // A newer window replaces the last question, so quick changes don't stack loops.
    this.settling?.cancel();
    this.settling = cx.spawn(async (cx) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const result = await hc(["ls", "--all", "--json"]);
          if (result.code !== 0) return;
          const terminals: CoreTerminal[] = JSON.parse(result.stdout).terminals;
          const seen = [...this.seenAgents.values()].map((a) => ({
            address: a.address,
            app: a.app,
            program: a.program,
            title: threadTitle(a.title, a.program),
          }));
          const records = settleAgents(recordAgents(agentRecords(), seen), terminals, Date.now());
          saveRecords(records);
          // Gone agents are recorded now; keeping them would bring back one that settling dropped.
          for (const address of this.seenAgents.keys())
            if (!live.has(address)) this.seenAgents.delete(address);
          // A closed tab's terminals take a moment to finish, so it asks again while a recorded
          // agent that is gone from the window is still live.
          const recorded = new Set(records.map((record) => record.address));
          const gone = (terminal: CoreTerminal) =>
            terminal.state === "live" &&
            !shownSet.has(terminal.address) &&
            recorded.has(terminal.address);
          if (!terminals.some(gone)) return;
        } catch {
          return;
        }
        await cx.sleep(1000);
      }
    });
  }

  // Opens a tab running `argv` in `folder`'s space, else in a new space there.
  openIn(snapshot: WorkspaceSnapshot, folder: string, argv: string[], name?: string) {
    const space = snapshot.spaces.find(
      (s) => !s.machine && snapshot.cwdBySpace.get(s.id) === folder,
    );
    if (!space) return run("space.new", { folder, argv, ...(name ? { tab: name } : {}) });
    run("space.select", { id: space.id });
    run("tab.new", { space: space.id, folder, argv, ...(name ? { name } : {}) });
  }

  // A closed agent: clicking shows its history in a new tab; its controls resume its agent's session
  // picker in its folder, or forget it (the core removes its terminal).
  closedRow(t: Theme, record: AgentRecord, snapshot: WorkspaceSnapshot, now: number): RailRow {
    const text = (record.title ?? record.program?.name ?? "agent").toLowerCase();
    const resume = resumeArgv(record.app);
    const forget = (cx: Context) =>
      cx.spawn(async () => {
        const result = await hc(["rm", record.address]).catch((): null => null);
        if (result?.code === 0)
          saveRecords(agentRecords().filter((other) => other.address !== record.address));
      });
    return {
      id: `closed-${record.address}`,
      dim: true,
      lead: icon(t, record.program),
      text,
      value: age(now - record.closed),
      end: h_flex()
        .gap(4)
        .items_center()
        .when(Boolean(resume), (e) =>
          e.child(
            this.control(
              t,
              `resume-${record.address}`,
              "Resume",
              svg("mods/frantss/resume.svg").size(10),
              () => this.openIn(snapshot, record.cwd, resume),
            ),
          ),
        )
        .child(
          this.control(
            t,
            `forget-${record.address}`,
            "Forget",
            svg("mods/pane/close.svg").size(10),
            (cx) => forget(cx),
          ),
        ),
      onClick: () =>
        this.openIn(snapshot, record.cwd, historyArgv(record.address), `${text} history`),
    };
  }

  // A space's workspace: its repo on its machine, else its place.
  workspaceKey(s: SpaceInfo, snapshot: WorkspaceSnapshot) {
    const place = snapshot.placeBySpace.get(s.id);
    const repo = this.repos?.[place];
    return repo ? JSON.stringify([s.machine ?? null, repo]) : place;
  }

  publishWorkspaces(snapshot: WorkspaceSnapshot) {
    const published = (shared(SPACE_WORKSPACES) as Record<string, string> | null) ?? {};
    const changed =
      Object.keys(published).length !== snapshot.spaces.length ||
      snapshot.spaces.some((s) => published[s.id] !== this.workspaceKey(s, snapshot));
    if (changed)
      setShared(
        SPACE_WORKSPACES,
        Object.fromEntries(snapshot.spaces.map((s) => [s.id, this.workspaceKey(s, snapshot)])),
      );
  }

  // The git folder a place shares with its worktrees. A machine that can't answer groups by folder.
  lookUp(key: string, cx: Context) {
    this.repos[key] = null;
    cx.spawn(async (cx) => {
      const found = await discoverRepository(key);
      this.repos[key] = found.repo;
      this.checkouts[key] = found.checkout;
      cx.notify();
    });
  }

  // Spaces in order, those of one repo (or, outside a repo, one folder) together where the first of them is.
  spaceGroups(snapshot: WorkspaceSnapshot) {
    const groups = new Map<string, SpaceGroup>();
    for (const s of snapshot.spaces) {
      const repo = this.repos?.[snapshot.placeBySpace.get(s.id)];
      const key = this.workspaceKey(s, snapshot);
      if (!groups.has(key))
        groups.set(key, {
          key,
          repo: Boolean(repo),
          name: repo ? repoName(repo) : s.name,
          folder: repo ? repoRoot(repo) : snapshot.cwdBySpace.get(s.id),
          local: !s.machine,
          spaces: [],
        });
      groups.get(key).spaces.push(s);
    }
    return [...groups.values()];
  }

  // A saved workspace keyed as its spaces' group is (its repo, else its folder), so they find each other.
  workspace(w: SavedWorkspace) {
    const repo = this.repos?.[folderKey(w.folder)];
    return {
      ...w,
      key: repo ? JSON.stringify([null, repo]) : folderKey(w.folder),
      repo: Boolean(repo),
      name: repo ? repoName(repo) : base(w.folder),
    };
  }

  top(t: Theme, snapshot: WorkspaceSnapshot) {
    const space = snapshot.spaces.find((s) => s.active),
      tab = space?.tabs.find((t) => t.active);
    // Like the site's path line, faint crumbs joined by "/" with the current one accented, naming where
    // you stand in the rail: workspace / branch / tab. Each crumb opens what it names.
    const group =
      space && this.spaceGroups(snapshot).find((g) => g.spaces.some((s) => s.id === space.id));
    const saved =
      group &&
      savedWorkspaces()
        .map((w) => this.workspace(w))
        .find((w) => w.key === group.key);
    const workspaceName = slugify(saved?.name ?? group?.name);
    const branchName = slugify(space && spaceName(space));
    const crumbs = [
      // A menu of apps to open its folder in (frantss-open), when it is on this machine.
      group && {
        id: "workspace",
        text: workspaceName && `~/${workspaceName}`,
        onClick: group.local
          ? () =>
              openOverlay({
                mod: "frantss-open",
                kind: "popup",
                width: 200,
                height: 160,
                props: { folder: saved?.folder ?? group.folder },
              })
          : null,
      },
      // A space outside a repo is named like its workspace; one crumb says it.
      space &&
        branchName !== workspaceName && {
          id: "space",
          text: branchName,
          onClick: () =>
            menu("space", {
              id: space.id,
              name: spaceName(space),
              checkout: this.checkouts?.[snapshot.placeBySpace.get(space.id)],
            }),
        },
      tab && {
        id: "tab",
        text: slugify(tabName(tab, snapshot.leadByTab.get(tab.id))),
        onClick: () =>
          menu("tab", {
            id: tab.id,
            space: space.id,
            name: tabName(tab, snapshot.leadByTab.get(tab.id)),
          }),
      },
    ].filter((crumb) => crumb?.text);
    // The bar drags the window, so a crumb with an action keeps its press to itself.
    const crumbLink = (
      crumb: { id: string; text: string; onClick?: () => unknown },
      current: boolean,
    ) =>
      div()
        .id(`crumb-${crumb.id}`)
        .when(current, (e) => e.min_w(0).truncate().text_color(t.accent))
        .when(!current, (e) => e.flex_none())
        .when(Boolean(crumb.onClick), (e) =>
          e
            .cursor_pointer()
            .when(!current, (e) => e.hover((s) => s.text_color(t.foreground)))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click(crumb.onClick),
        )
        .child(crumb.text);
    const path = h_flex()
      .flex_1()
      .min_w(0)
      .items_center()
      .text_color(t.dim)
      .children(
        crumbs.flatMap((crumb, i) =>
          i === crumbs.length - 1
            ? [crumbLink(crumb, true)]
            : [crumbLink(crumb, false), div().flex_none().child("/")],
        ),
      );
    return h_flex().size_full().pl(RAIL.pad).pr(16).items_center().text_size(12).child(path);
  }

  // One rail row: "❯ label ······ value" with a `value`, else "❯ label" with an optional `end` beside it.
  // The ❯ is a separate marker that glides between rows. `lead`: the icon column, false for none.
  // `lit`: bright without being current (a group holding the current space); `dim`: faint (a workspace
  // with nothing open). `strong`: medium weight (a workspace); `small`: smaller text (a tab), so each
  // level of the tree reads apart. `collapsed`: a chevron in the first column, pointing the way what is
  // under the row is (true closed, false open); none when undefined.
  row(
    t: Theme,
    {
      id,
      current,
      lit,
      dim,
      strong,
      small,
      indent,
      lead,
      text,
      value,
      end,
      onClick,
      onMenu,
      collapsed,
    }: RailRow,
  ) {
    return (
      h_flex()
        .id(id)
        .left(0)
        .right(0)
        .h(RAIL.row)
        .px(12)
        .gap(8)
        .items_center()
        .text_size(small ? 11 : 12)
        .when(Boolean(strong), (e) => e.font_medium())
        .text_color(current || lit ? t.foreground : dim ? t.dim : t.muted)
        .hover((s) => s.text_color(t.foreground))
        .on_click(onClick)
        .when(Boolean(onMenu), (e) => e.on_mouse_down("right", onMenu))
        // The chevron sits at the row's indent, in the column a ❯ marks on other rows.
        .child(
          h_flex()
            .w(10 + (indent ?? 0))
            .flex_none()
            .justify_end()
            .when(collapsed !== undefined, (e) => e.child(chevron(t, collapsed))),
        )
        .when(lead !== false, (e) => e.child(lead ?? div().w(14).flex_none()))
        .child(div().flex_1().min_w(0).truncate().child(text))
        .when(value !== undefined, (e) =>
          e.child(
            div().flex_none().max_w(80).truncate().text_size(11).text_color(t.dim).child(value),
          ),
        )
        .when(Boolean(end), (e) => e.child(end))
    );
  }

  // A section's header; clicking it opens or closes the section. `action`: a control at the header's
  // end (the workspaces' +). The title takes its status's color, else the foreground.
  header(
    t: Theme,
    {
      id,
      title,
      count,
      status,
      action,
      collapsed,
    }: Omit<RailSection, "rows"> & { collapsed: boolean },
  ) {
    return h_flex()
      .id(`header-${id}`)
      .left(0)
      .right(0)
      .h(RAIL.header)
      .px(12)
      .gap(8)
      .items_center()
      .cursor_pointer()
      .on_click(() => toggleCollapsed(id))
      .child(chevron(t, collapsed))
      .child(
        div()
          .flex_none()
          .text_size(11)
          .font_medium()
          .text_color(t[status] ?? t.foreground)
          .child(title),
      )
      .child(div().text_size(11).text_color(t.muted).child(String(count)))
      .when(Boolean(action), (e) => e.child(div().flex_1()).child(action));
  }

  // A small "+" in the rail; it doesn't select the row it sits on.
  plus(t: Theme, id: string, tooltip: string, onClick: (cx: Context) => unknown) {
    return this.control(t, id, tooltip, "+", onClick);
  }

  // A small control at a rail row's end, in the +'s column; it doesn't select the row it sits on.
  control(
    t: Theme,
    id: string,
    tooltip: string,
    label: Element | string,
    onClick: (cx: Context) => unknown,
  ) {
    return button(id, label, onClick, {
      variant: "quiet",
      size: "dense",
      square: true,
      tooltip,
    }).text_color(t.dim);
  }

  addWorkspace(cx: Context) {
    cx.spawn(async () => {
      const folder = await pickFolder({ prompt: "Add workspace" });
      if (folder && !savedWorkspaces().some((w) => w.folder === folder))
        setShared(WORKSPACES, [...savedWorkspaces(), { folder }]);
    });
  }

  // A marker hides in place when nothing is current, so it glides from where it was when something is again.
  marker(id: string, y: number | null, draw: (element: Element) => Element) {
    if (y !== null) this.marks[id] = y;
    return glide(draw(div().id(id)), this.marks[id] ?? 0)
      .opacity(y === null ? 0 : 1)
      .transition("opacity", 150);
  }

  rail(t: Theme, list: AgentInfo[], snapshot: WorkspaceSnapshot) {
    const all = snapshot.spaces;
    const groups = GROUPS.map((g) => ({ ...g, agents: list.filter((a) => a.status === g.status) }));
    setAgentOrder(groups.flatMap((g) => g.agents.map((a) => a.address)));
    const named = new Set(
      all.flatMap((s) => s.tabs.filter((tab) => tab.named).map((tab) => tab.id)),
    );
    // Each repo (or folder) is a row with its spaces under it, and each space with its tabs under it
    // until you close it; the current space is lit and the current tab marked. Rows here are bare names,
    // a status dot after. A tab with more than one pane shows its panes in its place. A space with one
    // tab of one pane stands for that tab: it shows its name, takes the marker and has nothing to close.
    const tabPanes = (tab: TabInfo) => snapshot.panesByTab.get(tab.id) ?? [];
    const standsForTab = (s: SpaceInfo) => s.tabs.length === 1 && tabPanes(s.tabs[0]).length < 2;
    const collapsed = collapsedIds();
    const spaceClosed = (s: SpaceInfo) =>
      collapsed.includes(`space:${s.id}:closed`) ||
      (!s.active && !collapsed.includes(`space:${s.id}:open`));
    const toggleSpace = (s: SpaceInfo) =>
      setShared(COLLAPSED, [
        ...collapsedIds().filter((id) => !id.startsWith(`space:${s.id}:`)),
        `space:${s.id}:${spaceClosed(s) ? "open" : "closed"}`,
      ]);
    // A dot left of where a workspace row's + sits, under that row's own dot.
    const dotEnd = (status: string) => {
      const statusIndicator = statusDot(t, status);
      return (
        statusIndicator &&
        h_flex().gap(8).items_center().child(statusIndicator).child(div().w(PLUS_WIDTH))
      );
    };
    // A worktree space has a branch icon left of its dot's column, as Codex marks worktree threads.
    const spaceEnd = (s: SpaceInfo) => {
      const dotted = dotEnd(s.status);
      if (this.checkouts?.[snapshot.placeBySpace.get(s.id)] !== "linked") return dotted;
      return h_flex()
        .gap(8)
        .items_center()
        .child(svg("mods/workspace-chrome/branch.svg").size(12).flex_none().text_color(t.dim))
        .child(dotted ?? div().w(6 + 8 + PLUS_WIDTH));
    };
    const spaceRow = (s: SpaceInfo): RailRow => ({
      id: `space-${s.id}`,
      current: s.active && standsForTab(s),
      lit: s.active,
      indent: 14,
      lead: false,
      end: spaceEnd(s),
      collapsed: standsForTab(s) ? undefined : spaceClosed(s),
      text: standsForTab(s)
        ? tabName(s.tabs[0], snapshot.leadByTab.get(s.tabs[0].id))
        : spaceName(s),
      onClick: () => (standsForTab(s) ? run("space.select", { id: s.id }) : toggleSpace(s)),
      onMenu: () =>
        menu("space", {
          id: s.id,
          name: spaceName(s),
          checkout: this.checkouts?.[snapshot.placeBySpace.get(s.id)],
        }),
    });
    const tabRows = (s: SpaceInfo): RailRow[] =>
      standsForTab(s) || spaceClosed(s)
        ? []
        : s.tabs.flatMap((tab) => (tabPanes(tab).length > 1 ? paneRows(s, tab) : [tabRow(s, tab)]));
    const tabRow = (s: SpaceInfo, tab: TabInfo): RailRow => ({
      id: `tab-${tab.id}`,
      current: s.active && tab.active,
      indent: 28,
      dim: true,
      small: true,
      lead: false,
      end: dotEnd(tab.status),
      text: tabName(tab, snapshot.leadByTab.get(tab.id)),
      onClick: () => run("tab.select", { id: tab.id }),
      onMenu: () =>
        menu("tab", {
          id: tab.id,
          space: s.id,
          name: tabName(tab, snapshot.leadByTab.get(tab.id)),
        }),
    });
    const paneRows = (s: SpaceInfo, tab: TabInfo): RailRow[] =>
      tabPanes(tab).map((pane) => ({
        id: `pane-${pane.pane}`,
        current: s.active && tab.active && pane.focused,
        indent: 28,
        dim: true,
        small: true,
        lead: false,
        end: dotEnd(pane.status),
        text: paneName(pane),
        onClick: () => run("pane.focus", { pane: pane.pane }),
        onMenu: () => menu("pane", { pane: pane.pane, terminal: pane.terminal }),
      }));
    const withTabs = (s: SpaceInfo) => [spaceRow(s), ...tabRows(s)];
    // A group row is a workspace: its open spaces (its own checkout and worktrees) are under it, unless
    // you closed it. Clicking opens or closes it; its + starts a thread (frantss-thread) in its own
    // checkout (not one of Herdr's worktrees), else its first space; its menu keeps or removes it
    // (frantss-workspace).
    const newThread = (key: string, target: Record<string, unknown>) =>
      this.plus(t, `new-${key}`, "New thread", () =>
        openOverlay({
          mod: "frantss-thread",
          kind: "popup",
          width: 260,
          height: 420,
          props: target,
        }),
      );
    const workspaceMenu = (folder: string, saved: boolean) =>
      openOverlay({
        mod: "frantss-workspace",
        kind: "popup",
        width: 220,
        height: 120,
        props: { folder, saved },
      });
    const ownCheckout = (g: SpaceGroup) =>
      g.spaces.find((s) => !snapshot.cwdBySpace.get(s.id)?.includes("/.herdr/worktrees/")) ??
      g.spaces[0];
    const workspaceClosed = (g: SpaceGroup) => collapsed.includes(`workspace:${g.key}`);
    const groupRow = (g: SpaceGroup, saved: NamedWorkspace): RailRow => {
      const s = ownCheckout(g);
      return {
        id: `group-${g.key}`,
        lit: g.spaces.some((s) => s.active),
        strong: true,
        lead: false,
        text: saved?.name ?? g.name,
        collapsed: workspaceClosed(g),
        end: h_flex()
          .gap(8)
          .items_center()
          .child(
            statusDot(
              t,
              URGENT.find((st) => g.spaces.some((s) => s.status === st)),
            ) ?? div().w(6),
          )
          .child(
            newThread(g.key, {
              space: s.id,
              folder: snapshot.cwdBySpace.get(s.id),
              machine: s.machine,
              repo: g.repo,
            }),
          ),
        onClick: () => toggleCollapsed(`workspace:${g.key}`),
        // Only folders on this machine can be kept (the folder picker's, and new spaces', machine).
        onMenu: () => g.local && workspaceMenu(saved?.folder ?? g.folder, Boolean(saved)),
      };
    };
    // A saved workspace with nothing open: clicking opens a space in its folder.
    const closedRow = (w: NamedWorkspace): RailRow => ({
      id: `group-${w.key}`,
      dim: true,
      strong: true,
      lead: false,
      text: w.name,
      end: h_flex()
        .gap(8)
        .items_center()
        .child(div().w(6))
        .child(newThread(w.key, { folder: w.folder, repo: w.repo })),
      onClick: () => run("space.new", { folder: w.folder }),
      onMenu: () => workspaceMenu(w.folder, true),
    });
    const open = this.spaceGroups(snapshot);
    const openByKey = new Map(open.map((group) => [group.key, group]));
    const savedKeys = new Set<string>();
    const saved = savedWorkspaces()
      .map((w) => this.workspace(w))
      .filter((w) => {
        if (savedKeys.has(w.key)) return false;
        savedKeys.add(w.key);
        return true;
      });
    const unsaved = open.filter((group) => !savedKeys.has(group.key));
    const groupRows = (g: SpaceGroup, w: NamedWorkspace) => [
      groupRow(g, w),
      ...(workspaceClosed(g) ? [] : g.spaces.flatMap(withTabs)),
    ];
    const workspaceRows = [
      ...saved.flatMap((w) => {
        const g = openByKey.get(w.key);
        return g ? groupRows(g, w) : [closedRow(w)];
      }),
      ...unsaved.flatMap((g) => groupRows(g, null)),
    ];
    const closed = closedAgents(agentRecords()),
      now = Date.now();
    const sections: RailSection[] = [
      {
        id: "spaces",
        title: "WORKSPACES",
        count: saved.length + unsaved.length,
        action: this.plus(t, "add-workspace", "Add workspace", (cx) => this.addWorkspace(cx)),
        rows: workspaceRows,
      },
      // An agent group shows only while it has agents.
      ...groups
        .filter((g) => g.agents.length)
        .map((g) => ({
          id: g.status,
          title: g.label,
          status: g.status,
          rows: g.agents.map((a) => ({
            id: `agent-${a.address}`,
            current: a.focused,
            lead: icon(t, a.program),
            agent: true,
            text: named.has(a.tab)
              ? a.tab_name
              : (threadTitle(a.title, a.program) ?? a.program.name).toLowerCase(),
            value: a.space_name,
            onClick: () => run("agent.focus", { terminal: a.address }),
            onMenu: () => menu("pane", { pane: a.pane, terminal: a.address }),
          })),
        })),
      ...(closed.length
        ? [
            {
              id: "closed",
              title: "RECENTLY CLOSED",
              rows: closed.map((record) => this.closedRow(t, record, snapshot, now)),
            },
          ]
        : []),
    ];

    const items = [];
    let y = RAIL.pad,
      gap = 0,
      spaceY = null,
      agentY = null;
    for (const s of sections) {
      const closed = collapsed.includes(s.id);
      items.push(
        glide(this.header(t, { ...s, count: s.count ?? s.rows.length, collapsed: closed }), y),
      );
      y += RAIL.header + RAIL.rowGap;
      for (const r of closed ? [] : s.rows) {
        items.push(glide(this.row(t, r), y));
        if (r.current && r.agent) agentY = y;
        else if (r.current) spaceY = y;
        y += RAIL.row + RAIL.rowGap;
      }
      gap = s.rows.length ? RAIL.sectionGap : RAIL.emptyGap;
      y += gap - RAIL.rowGap;
    }

    this.marks ??= {};
    const chevron = (e: Element) =>
      e.left(12).h(RAIL.row).flex().items_center().text_size(12).text_color(t.accent).child("❯");
    return v_flex()
      .size_full()
      .child(
        v_flex()
          .id("frantss-rail")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .child(
            div()
              .relative()
              .w_full()
              .flex_none()
              .h(y - gap + RAIL.pad)
              .children(items)
              .child(this.marker("mark-space", spaceY, chevron))
              .child(this.marker("mark-agent", agentY, chevron))
              // The site's outline bar: one accent bar on the rail's right rule, beside the focused agent.
              .child(
                this.marker("mark-bar", agentY, (e) => e.right(0).w(2).h(RAIL.row).bg(t.accent)),
              ),
          ),
      )
      .child(this.footer(t));
  }

  // Herdr's own sidebar footer, in the rail's row style: it stays below the scrolling sections.
  footer(t: Theme) {
    const action = (id: string, icon: string, text: string, onClick: () => unknown): RailRow => ({
      id,
      text,
      lead: svg(`mods/workspace-chrome/${icon}.svg`).size(14).flex_none(),
      onClick,
    });
    return v_flex()
      .flex_none()
      .py(8)
      .gap(RAIL.rowGap)
      .border_t(1)
      .border_color(t.border)
      .child(
        this.row(
          t,
          action("settings", "settings", "Settings", () => run("app.settings")),
        ),
      )
      .child(
        this.row(
          t,
          action("add-machine", "plus", "Add machine", () =>
            run("mod.open", { name: "machine-add" }),
          ),
        ),
      );
  }

  // A pane's header; a pane that shares its tab can be closed from it (a lone one closes with its tab).
  pane(t: Theme) {
    const all = panes(),
      id = props().pane;
    const pane = all.find((p) => p.pane === id);
    const withOthers = Boolean(pane) && all.some((p) => p !== pane && p.tab === pane.tab);
    const where = [pane?.branch, pane?.cwd?.split("/").pop()].filter(Boolean).join(" · ");
    return h_flex()
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .text_size(11)
      .child(icon(t, pane?.program, 13) ?? div())
      .child(
        div()
          .flex_none()
          .text_color(pane?.focused ? t.foreground : t.muted)
          .child(pane?.program?.name ?? "Terminal"),
      )
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(where))
      .when(Boolean(pane?.status), (e) =>
        e
          .child(dot(t, pane.status))
          .child(
            label(
              t,
              GROUPS.find((g) => g.status === pane.status)?.label ?? pane.status.toUpperCase(),
              pane.status,
            ),
          ),
      )
      .when(withOthers, (e) =>
        e.child(
          this.control(t, "close-pane", "Close pane", svg("mods/pane/close.svg").size(10), () =>
            run("pane.close", { pane: pane.pane }),
          ),
        ),
      );
  }

  render(cx: Context) {
    const t = theme() as Record<string, `#${string}`>;
    const role = props()?.role;
    if (role === "pane") return this.pane(t);
    const snapshot = workspaceSnapshot();
    this.track(cx, snapshot, role);
    if (role === "top") return this.top(t, snapshot);
    const list = agents();
    this.trackAgents(cx, list, snapshot);
    return this.rail(t, list, snapshot);
  }
}
