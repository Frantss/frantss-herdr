import type {
  Context,
  AsyncContext,
  Element,
  ClickEvent,
  MouseButtonEvent,
  Task,
  FocusHandle,
} from "gpui-kit";
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
  nextCommand,
  notify,
  terminals,
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
import { paneName, tabName, threadTitle, prunePaneNames } from "./pane-names.ts";
import { hcOrToast } from "./agent-hc.ts";
import { confirmForgetHistory, openAgentTab } from "./closed-agent-actions.ts";
import {
  AGENT_PRS,
  CLOSED_AGENTS,
  PR_STATES,
  SHOW_AGENT_PRS,
  isOpen,
  mostUrgentPr,
  prLinks,
  trackedAgents,
  type AgentPr,
  type PrLink,
} from "./agent-prs.ts";
import { AgentPrTracker } from "./agent-pr-tracker.ts";
import {
  SESSION_LABEL,
  CONTEXT_LABEL,
  usesContextLabel,
  contextUsage,
  tokenCount,
  usageLineArgv,
  usedPercent,
  type ContextUsage,
} from "./context.ts";
import { SUBSCRIPTION_LAUNCH, SUBSCRIPTION_READER } from "./subscription-reader.ts";
import {
  SUBSCRIPTION_REFRESH_MS,
  SUBSCRIPTIONS,
  SubscriptionUsage,
  peakWindow,
  resetIn,
  usageWindow,
} from "./subscriptions.ts";
import { stampStatuses, type StatusStamps } from "./status-since.ts";
import { BRANCH_STATUS_ARGS, parseBranchStatus, type BranchStatus } from "./branch-status.ts";
import { assignColors } from "./workspace-colors.ts";
import { WorktreeDiscovery, type Worktree, type WorktreeTarget } from "./worktrees.ts";
import {
  inspectWorktree,
  removeWorktree,
  planWorktreeRemoval,
  removeWorktrees,
  type RemovalTarget,
  type RemovalPlan,
} from "./worktree-removal.ts";

type Theme = Record<string, `#${string}`>;
type KnownAgent = Awaited<ReturnType<typeof knownAgents>>[number];
type RepositoryLookup = {
  repo: string | null;
  top: string | null;
  checkout: "main" | "linked" | null;
};
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
  indent?: number;
  lead?: Element | false;
  text: string;
  // Dim context after the text, such as an agent's space.
  tail?: Element;
  value?: string | Element;
  end?: Element;
  onClick?: (event: ClickEvent, cx: Context) => unknown;
  activate?: (cx: Context) => unknown;
  focus?: FocusHandle;
  controlFocus?: FocusHandle[];
  onMenu?: (event: MouseButtonEvent, cx: Context) => unknown;
  // Controls shown in place of `value` and `end` while the row is hovered.
  hoverEnd?: Element;
  collapsed?: boolean;
  connector?: string;
  // No first column: the row starts at its edge (a workspace, which no ❯ marks).
  flush?: boolean;
  agent?: boolean;
};
type RailSection = {
  id: string;
  title: string;
  count?: number;
  status?: string;
  action?: Element;
  // Shown at the header's end while the section is closed: its most urgent status.
  urgent?: string;
  rows: RailRow[];
};

const GROUPS = [
  { status: "blocked", label: "Needs you" },
  { status: "done", label: "Unread" },
  { status: "working", label: "Working" },
  { status: "idle", label: "Idle" },
];

// The rail places every item itself, so items, markers and the bar can glide between places.
// `emptyGap`: after a section with no rows, so empty agent groups sit close together.
const RAIL = { pad: 16, header: 24, row: 28, rowGap: 2, sectionGap: 20, emptyGap: 10 };
// Close to the site's dock ease (300ms, no overshoot); gpui-kit has no cubic-bezier easing.
const GLIDE = { response: 300, damping: 1 };
const glide = (e: Element, y: number) => e.absolute().top(y).spring("top", GLIDE);
// A 4px meter's bar, filled to `percent`: red from 90%, muted when stale. Callers set its width.
const meterBar = (t: Theme, percent: number, stale = false) =>
  div()
    .h(4)
    .rounded(2)
    .bg(t.input)
    .child(
      div()
        .h_full()
        .rounded(2)
        .w(`${percent}%`)
        .bg(stale ? t.muted : percent >= 90 ? t.blocked : t.accent),
    );
// How often the focused agent's context is read again, while its session file may change.
const CONTEXT_REFRESH_MS = 5000;

const icon = (t: Theme, program: Program, size = 14) =>
  !program?.icon
    ? null
    : (program.tint ? svg(program.icon).text_color(t.muted) : image(program.icon))
        .size(size)
        .flex_none();
// The workspace tree's icon column: each level has its own icon, so rows read apart at a glance.
const treeIcon = (t: Theme, source: string) => svg(source).size(12).flex_none().text_color(t.dim);
const programIcon = (t: Theme, program: Program) =>
  icon(t, program, 12) ?? treeIcon(t, "mods/workspace-chrome/terminal.svg");
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
    height: 440,
    props: { tab, target },
  });

// A space's or tab's status dot, only when something in it is going on.
const statusDot = (t: Theme, status: string) =>
  status && status !== "idle" ? dot(t, status) : null;
// The rail's + is this wide, so rows without one can keep their dots in the same column.
const PLUS_WIDTH = 20;
const URGENT = GROUPS.map((g) => g.status).filter((status) => status !== "idle");
const mostUrgent = (statuses: string[]) => URGENT.find((status) => statuses.includes(status));
// Agent ages are in minutes, so the rail renders again this often.
const AGE_REFRESH_MS = 30_000;
// Agents' PR links are compared this often; a lookup runs only when they change or are due.
const PR_LINKS_MS = 2000;
// A place's ahead/behind counts are read again at the first render after this long.
const BRANCH_REFRESH_MS = 60_000;
const DEFAULT_BRANCHES = new Set(["main", "master"]);

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
      return { repo, top: top?.code === 0 ? top.stdout.trim() : null, checkout };
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
// Each workspace's avatar color by workspace key, a theme color name, kept in shared state (persisted).
const WORKSPACE_COLORS = "frantss.workspaceColors";
const workspaceColors = () => (shared(WORKSPACE_COLORS) as Record<string, string> | null) ?? {};
// When each agent's status last changed (status-since.ts), kept in this mod's storage.
const STATUS_STAMPS = "statusStamps";
// The local agents the rail has seen, kept in shared state (persisted) so the rail lists them after
// their tab closes (see closed.ts).
const agentRecords = () => (shared(CLOSED_AGENTS) as AgentRecord[] | null) ?? [];
// Opens the GitHub panel's Agents tab on the agent; `at` makes each click a change.
const showAgentPrs = (address: string) => {
  setShared(SHOW_AGENT_PRS, { address, at: Date.now() });
  run("layout.select", { stack: "panel", child: "github" });
  run("layout.show", { id: "panel" });
};
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
  // Cwd follows the first pane in global order; tab icons prefer the first agent pane.
  for (const pane of panes()) {
    const lead = leadByTab.get(pane.tab);
    if (!lead || (!lead.program?.agent && pane.program?.agent)) leadByTab.set(pane.tab, pane);
    const tabPanes = panesByTab.get(pane.tab);
    if (tabPanes) tabPanes.push(pane);
    else panesByTab.set(pane.tab, [pane]);
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

// "Personal herdr layout" -> "personal-herdr-layout", as the site's paths read.
const slugify = (text: string) =>
  (text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");

// A space you named shows that name; else its branch, else Herdr's name for it (its repo or folder).
const spaceName = (s: SpaceInfo) => (s.named ? s.name : (s.branch ?? s.name));

export default class Frantss extends View {
  subscriptionUsage = new SubscriptionUsage();
  movingTabs = new Set<string>();
  checkoutRoots: Record<string, string | null> = {};
  openingWorktrees = new Set<string>();
  worktreeFocus = new Map<string, FocusHandle>();
  usedWorktreeFocus = new Set<string>();
  syncingWorktreeFocus = false;
  removingWorktrees = new Set<string>();
  checkingRemoval = new Set<string>();
  pendingRemoval: { token: string; target: RemovalTarget } | null = null;
  pendingBulkRemoval: {
    token: string;
    key: string;
    plan: RemovalPlan | null;
    started: boolean;
  } | null = null;
  busyBulkRemoval = new Set<string>();
  removalSequence = 0;
  worktrees = new WorktreeDiscovery(async ({ cwd, machine }) => {
    const result = await exec("git", ["worktree", "list", "--porcelain", "-z"], {
      cwd,
      on: machine,
    });
    if (result.code !== 0) throw new Error("Could not list worktrees");
    return result.stdout;
  });
  declare repos: Record<string, string | null>;
  declare checkouts: Record<string, "main" | "linked" | null>;
  declare marks: Record<string, number>;
  declare terminalsKey: string;
  // The local agents shown since the rail last recorded them, by address, with their PR links.
  declare seenAgents: Map<string, AgentInfo & { prs: PrLink[] }>;
  declare settling: Task;
  declare hovered: string | null;
  // The focused agent's context, read from its session file: what was read (`key`) and for whom.
  declare context: { address: string; usage: ContextUsage } | null;
  declare contextKey: string;
  // The focused agent the rail last looked up, so a render looks up only a newly focused one.
  declare contextFor: string | null;
  declare contextReading: boolean;
  // Repo lookups still running, by place key: workspace keys can change until they finish.
  declare lookingUp: Set<string>;
  // Each place's commits ahead and behind its upstream (null outside a repo), and when it was read.
  declare branches: Record<string, { checkedAt: number; status: BranchStatus | null }>;
  declare statusStamps: StatusStamps;
  init(_p: unknown, cx: AsyncContext) {
    // The rail and the breadcrumb both name workspaces by repo.
    if (props()?.role !== "rail" && props()?.role !== "top") return;
    this.repos = {}; // place key -> its repo's git folder, null outside a repo; a folder's repo doesn't change
    // place key -> "main" (a repo's own checkout), "linked" (a worktree) or null, once looked up: the space
    // menu's worktree items, handed to it so it opens without asking git itself.
    this.checkouts = {};
    if (props()?.role === "rail") {
      for (const machine of new Set(["", ...spaces().map((s) => s.machine ?? "")]))
        refreshAgents(machine).catch(() => {});
      cx.spawn(async (cx) => {
        for (;;) {
          const command = await nextCommand();
          if (command === "refresh-usage") this.refreshSubscriptions(cx);
          if (command.startsWith("inspect-worktrees:"))
            this.inspectBulkWorktreeRemoval(command.slice("inspect-worktrees:".length), cx);
          if (command.startsWith("cancel-worktrees:"))
            this.cancelBulkWorktreeRemoval(command.slice("cancel-worktrees:".length));
          if (command.startsWith("remove-worktrees:"))
            this.confirmedBulkWorktreeRemoval(command.slice("remove-worktrees:".length), cx);
          if (command.startsWith("remove-worktree:"))
            this.confirmedWorktreeRemoval(command.slice("remove-worktree:".length), cx);
          if (command.startsWith("forget-history:"))
            await this.forgetHistory(decodeURIComponent(command.slice("forget-history:".length)));
          if (command.startsWith("move-pane:")) {
            const id = decodeURIComponent(command.slice("move-pane:".length));
            cx.spawn((cx) => this.movePane(id, cx));
          }
        }
      });
      this.refreshSubscriptions(cx);
      cx.timer.every(SUBSCRIPTION_REFRESH_MS, (cx) => this.refreshSubscriptions(cx));
      cx.timer.every(CONTEXT_REFRESH_MS, (cx) => this.refreshContext(cx));
      cx.timer.every(AGE_REFRESH_MS, (cx) => cx.notify());
      cx.timer.every(10_000, (cx) => this.refreshWorktrees(cx));
      this.refreshWorktrees(cx);
      const prs = new AgentPrTracker((args) => exec("gh", args), shared, setShared);
      cx.timer.every(PR_LINKS_MS, (cx) => {
        const tracked = trackedAgents(terminals(), agents(), agentRecords());
        if (prs.due(tracked, Date.now()))
          cx.spawn(() => prs.lookUp(tracked, Date.now()).catch(() => {}));
      });
    }
  }

  // The rail outlives the pane header removed by parking its terminal.
  async movePane(id: string, cx: AsyncContext) {
    const all = panes();
    const pane = all.find((each) => each.pane === id);
    if (
      !pane?.terminal ||
      this.movingTabs.has(pane.tab) ||
      !all.some((each) => each.pane !== id && each.tab === pane.tab)
    )
      return;
    const terminal = pane.terminal;
    this.movingTabs.add(pane.tab);
    const waitFor = async (ready: () => boolean) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (ready()) return;
        await cx.sleep(100);
      }
      if (!ready()) throw new Error("Herdr did not finish moving the terminal within 10 seconds.");
    };
    try {
      run("terminal.park", { terminal });
      await waitFor(() => !panes().some((each) => each.terminal === terminal));
      if (!spaces().some((space) => space.tabs.some((tab) => tab.id === pane.tab)))
        throw new Error("The original tab was closed during the move.");
      run("tab.select", { id: pane.tab });
      run("terminal.keep", { terminal, place: "tab" });
      await waitFor(() => panes().some((each) => each.terminal === terminal));
    } catch (error) {
      const parked = !panes().some((each) => each.terminal === terminal);
      notify({
        title: "Could not move pane to a new tab",
        body: `${error instanceof Error ? error.message : String(error)}${parked ? " Click this message to restore the terminal as a tab." : ""}`,
        level: "error",
        ...(parked ? { action: { name: "terminal.keep", args: { terminal, place: "tab" } } } : {}),
      });
    } finally {
      this.movingTabs.delete(pane.tab);
    }
  }

  // Reads the focused agent's context again when it or its session changed since the last read.
  // `seq` changes as the agent works, so an idle agent's file isn't read again.
  refreshContext(cx: Context) {
    const agent = agents().find((a) => a.focused);
    const labels = agent
      ? terminals().find((terminal) => terminal.address === agent.address)?.labels
      : undefined;
    if (usesContextLabel(agent?.app ?? null)) {
      this.contextKey = "";
      const usage = contextUsage(agent.app, labels?.[CONTEXT_LABEL] ?? "");
      this.context = usage ? { address: agent.address, usage } : null;
      return;
    }
    const transcript = labels?.[SESSION_LABEL];
    const argv = transcript && usageLineArgv(agent.app, transcript);
    if (!argv) {
      if (this.context) this.context = null;
      this.contextKey = "";
      return;
    }
    const key = JSON.stringify([agent.address, transcript, agent.seq]);
    if (key === this.contextKey || this.contextReading) return;
    this.contextKey = key;
    this.contextReading = true;
    const on = spaces().find((s) => s.id === agent.space)?.machine ?? null;
    cx.spawn(async (cx) => {
      try {
        const result = await exec(argv[0], argv.slice(1), { on }).catch((): null => null);
        const usage = result?.code === 0 ? contextUsage(agent.app, result.stdout.trim()) : null;
        if (this.contextKey === key)
          this.context = usage ? { address: agent.address, usage } : null;
      } finally {
        this.contextReading = false;
        cx.notify();
      }
    });
  }

  // The focused agent's context in its row's value slot: a short bar and its percent, or only its
  // tokens when the session file doesn't give the window.
  contextMeter(t: Theme, usage: ContextUsage) {
    const percent = usedPercent(usage);
    return h_flex()
      .gap(6)
      .items_center()
      .when(percent !== null, (e) => e.child(meterBar(t, percent).w(32)))
      .child(
        div()
          .text_color(percent >= 90 ? t.blocked : t.dim)
          .child(percent === null ? tokenCount(usage.tokens) : `${percent}%`),
      );
  }

  refreshSubscriptions(cx: Context) {
    if (this.subscriptionUsage.refreshing) return;
    cx.spawn(async (cx) => {
      await this.subscriptionUsage.refresh(
        async (provider) => {
          // Match the agent launcher: a desktop process may not have the user's Node on PATH.
          const result = await exec("sh", [
            "-c",
            SUBSCRIPTION_LAUNCH,
            "herdr-usage",
            "--input-type=module",
            "-e",
            SUBSCRIPTION_READER,
            provider,
          ]);
          if (result.code !== 0) throw new Error("Reader failed");
          return result.stdout;
        },
        () => Date.now(),
        () => cx.notify(),
      );
    });
  }

  // Looks up the places and saved workspaces it hasn't seen. Render runs whenever spaces, panes or
  // shared state change, so no timer is needed.
  track(cx: Context, places: Iterable<string>) {
    if (!this.repos) return;
    const keys = [...places, ...savedWorkspaces().map((w) => folderKey(w.folder))];
    for (const key of keys) if (!(key in this.repos)) this.lookUp(key, cx);
  }

  // Asks the core which terminals finished whenever an agent or a pane goes (a closed tab takes
  // both), and records the local agents with its answer. Titles change often and a shared write
  // re-renders every mod, so until then the latest of each agent stays here.
  trackAgents(cx: Context, list: AgentInfo[], snapshot: WorkspaceSnapshot) {
    const remote = new Set(snapshot.spaces.filter((s) => s.machine).map((s) => s.id));
    const local = list.filter((a) => !remote.has(a.space));
    this.seenAgents ??= new Map();
    // Read while the agent lives: mods see only live terminals' labels.
    const labels = new Map(terminals().map((terminal) => [terminal.address, terminal.labels]));
    for (const a of local)
      this.seenAgents.set(a.address, { ...a, prs: prLinks(labels.get(a.address)) });
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
            prs: a.prs,
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

  async forgetHistory(address: string) {
    if (!agentRecords().some((record) => record.address === address && record.closed !== undefined))
      return;
    const result = await hc(["rm", address]).catch((): null => null);
    if (result?.code === 0)
      saveRecords(agentRecords().filter((record) => record.address !== address));
    else
      notify({
        title: "Could not forget history",
        body: result?.stderr.trim() || undefined,
        level: "error",
      });
  }

  // A closed agent: clicking shows its history in a new tab; its controls resume its agent's session
  // picker in its folder, or ask to forget its retained terminal history.
  closedRow(t: Theme, record: AgentRecord, now: number): RailRow {
    const text = (record.title ?? record.program?.name ?? "agent").toLowerCase();
    const resume = resumeArgv(record.app);
    const prChip = this.prChip(t, record.address);
    return {
      id: `closed-${record.address}`,
      dim: true,
      lead: icon(t, record.program),
      text,
      value: age(now - record.closed),
      end: h_flex()
        .gap(4)
        .items_center()
        .when(Boolean(prChip), (e) => e.child(prChip))
        .when(Boolean(resume), (e) =>
          e.child(
            this.control(
              t,
              `resume-${record.address}`,
              "Resume…",
              svg("mods/frantss/resume.svg").size(10),
              () => openAgentTab(record.cwd, resume),
            ),
          ),
        )
        .child(
          this.control(
            t,
            `forget-${record.address}`,
            "Forget history…",
            svg("mods/pane/close.svg").size(10),
            () => confirmForgetHistory(record.address, text),
          ),
        ),
      onClick: () => openAgentTab(record.cwd, historyArgv(record.address), `${text} history`),
      onMenu: () =>
        menu("closed", {
          terminal: record.address,
          cwd: record.cwd,
          name: text,
          app: record.app,
        }),
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
    this.lookingUp ??= new Set();
    this.lookingUp.add(key);
    cx.spawn(async (cx) => {
      const found = await discoverRepository(key);
      this.repos[key] = found.repo;
      this.checkouts[key] = found.checkout;
      this.checkoutRoots[key] = found.top;
      this.lookingUp.delete(key);
      cx.notify();
    });
  }

  refreshWorktrees(cx: Context, forceKey?: string) {
    const collapsed = collapsedIds();
    if (
      collapsed.includes("spaces") ||
      (!forceKey && !collapsed.some((id) => id.startsWith("worktrees:")))
    )
      return;
    const snapshot = workspaceSnapshot();
    const targets: WorktreeTarget[] = this.spaceGroups(snapshot)
      .filter(
        (g) =>
          g.repo &&
          !collapsed.includes(`workspace:${g.key}`) &&
          (collapsed.includes(`worktrees:${g.key}`) || forceKey === g.key),
      )
      .map((g) => ({
        key: g.key,
        cwd: snapshot.cwdBySpace.get(g.spaces[0].id),
        machine: g.spaces[0].machine ?? null,
      }));
    if (targets.length)
      cx.spawn((cx) => this.worktrees.refresh(targets, () => cx.notify(), forceKey));
  }

  worktreeSpaces(key: string, snapshot: WorkspaceSnapshot, list = snapshot.spaces) {
    const [machine] = JSON.parse(key);
    const normalize = (path: string) => {
      const windows = /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\");
      return (windows ? path.replace(/\\/g, "/") : path).replace(/(.)\/$/, "$1");
    };
    const roots = (this.worktrees.state(key)?.worktrees ?? [])
      .map((tree) => normalize(tree.path))
      .sort((a, b) => b.length - a.length);
    const open = new Map<string, SpaceInfo>();
    for (const space of list) {
      if ((space.machine ?? null) !== machine) continue;
      const place = snapshot.placeBySpace.get(space.id);
      const top = this.checkoutRoots[place];
      const cwd = normalize(snapshot.cwdBySpace.get(space.id) ?? "");
      const root = top
        ? normalize(top)
        : (roots.find((root) => cwd === root || cwd.startsWith(`${root}/`)) ?? cwd);
      if (!open.has(root)) open.set(root, space);
    }
    return { open, normalize };
  }

  openWorktree(worktree: Worktree, key: string, cx: Context) {
    if (this.removingWorktrees.has(JSON.stringify([key, worktree.path]))) {
      notify({ title: "Worktree removal is in progress", level: "error" });
      return;
    }
    const { open, normalize } = this.worktreeSpaces(key, workspaceSnapshot());
    const existing = open.get(normalize(worktree.path));
    if (existing) return run("space.select", { id: existing.id });
    const openingKey = JSON.stringify([key, worktree.path]);
    if (this.openingWorktrees.has(openingKey)) return;
    this.openingWorktrees.add(openingKey);
    const [machine] = JSON.parse(key);
    run("space.new", { folder: worktree.path, machine: machine ?? "" });
    cx.spawn(async (cx) => {
      try {
        for (let attempt = 0; attempt < 100; attempt++) {
          const { open } = this.worktreeSpaces(key, workspaceSnapshot());
          if (open.has(normalize(worktree.path))) return;
          await cx.sleep(100);
        }
        notify({ title: "Could not open worktree", body: worktree.path, level: "error" });
      } finally {
        this.openingWorktrees.delete(openingKey);
      }
    });
  }

  worktreeFocusHandle(id: string) {
    this.usedWorktreeFocus.add(id);
    return this.worktreeFocus.get(id);
  }

  syncWorktreeFocus(cx: Context) {
    if (
      this.syncingWorktreeFocus ||
      (this.worktreeFocus.size === this.usedWorktreeFocus.size &&
        [...this.usedWorktreeFocus].every((id) => this.worktreeFocus.has(id)))
    )
      return;
    this.syncingWorktreeFocus = true;
    cx.timer.after(0, (cx) => {
      for (const [id, handle] of this.worktreeFocus) {
        if (this.usedWorktreeFocus.has(id)) continue;
        handle.release();
        this.worktreeFocus.delete(id);
      }
      for (const id of this.usedWorktreeFocus)
        if (!this.worktreeFocus.has(id)) this.worktreeFocus.set(id, cx.focus_handle());
      this.syncingWorktreeFocus = false;
      cx.notify();
    });
  }

  newWorktreeThread(tree: Worktree, key: string) {
    if (this.removingWorktrees.has(JSON.stringify([key, tree.path]))) {
      notify({ title: "Worktree removal is in progress", level: "error" });
      return;
    }
    const [machine] = JSON.parse(key);
    const { open, normalize } = this.worktreeSpaces(key, workspaceSnapshot());
    const existing = open.get(normalize(tree.path));
    openOverlay({
      mod: "frantss-thread",
      kind: "popup",
      width: 260,
      height: 420,
      props: { folder: tree.path, machine, space: existing?.id, repo: false },
    });
  }

  requestWorktreeRemoval(tree: Worktree, key: string, cx: Context) {
    const target = { key, path: tree.path };
    const removalKey = JSON.stringify([key, tree.path]);
    if (tree.main || this.checkingRemoval.has(removalKey) || this.removingWorktrees.has(removalKey))
      return;
    this.checkingRemoval.add(removalKey);
    this.pendingRemoval = null;
    if (this.pendingBulkRemoval) this.cancelBulkWorktreeRemoval(this.pendingBulkRemoval.token);
    cx.spawn(async () => {
      try {
        const { open, normalize } = this.worktreeSpaces(key, workspaceSnapshot());
        if (open.has(normalize(tree.path))) throw new Error("Close its Herdr space first.");
        const inspection = await inspectWorktree(target, exec);
        if (inspection.dirty)
          throw new Error("Commit or move this checkout's local changes before removing it.");
        const latest = this.worktreeSpaces(key, workspaceSnapshot());
        if (latest.open.has(latest.normalize(tree.path)) || this.openingWorktrees.has(removalKey))
          throw new Error("Close its Herdr space first.");
        const token = String(++this.removalSequence);
        if (this.pendingBulkRemoval) this.cancelBulkWorktreeRemoval(this.pendingBulkRemoval.token);
        this.pendingRemoval = { token, target };
        openOverlay({
          mod: "confirm",
          kind: "dialog",
          width: 440,
          height: 210,
          props: {
            title: `Remove ${tree.branch ?? tree.head.slice(0, 8)}?`,
            detail: `Deletes the checkout folder, including ignored files:\n${tree.path}\n\nThe Git branch is kept. Git will refuse removal if the checkout has new local changes, is locked, or contains submodules.`,
            command: { name: `frantss.remove-worktree:${token}` },
          },
        });
      } catch (error) {
        notify({ title: "Could not remove worktree", body: String(error), level: "error" });
      } finally {
        this.checkingRemoval.delete(removalKey);
      }
    });
  }

  confirmedWorktreeRemoval(token: string, cx: Context) {
    if (this.pendingRemoval?.token !== token) return;
    const { target } = this.pendingRemoval;
    this.pendingRemoval = null;
    const removalKey = JSON.stringify([target.key, target.path]);
    this.removingWorktrees.add(removalKey);
    cx.spawn(async (cx) => {
      try {
        const { open, normalize } = this.worktreeSpaces(target.key, workspaceSnapshot());
        if (open.has(normalize(target.path)) || this.openingWorktrees.has(removalKey))
          throw new Error("Close its Herdr space first.");
        await removeWorktree(target, exec, (target) => this.worktreeRemovalBlock(target, false));
        this.refreshWorktrees(cx, target.key);
      } catch (error) {
        notify({ title: "Could not remove worktree", body: String(error), level: "error" });
      } finally {
        this.removingWorktrees.delete(removalKey);
      }
    });
  }

  worktreeRemovalBlock(target: RemovalTarget, includeRemoving = true): string | null {
    const snapshot = workspaceSnapshot();
    const { open, normalize } = this.worktreeSpaces(target.key, snapshot);
    const [machine] = JSON.parse(target.key);
    const path = normalize(target.path);
    const contains = (folder: string) => {
      const normalized = normalize(folder);
      return normalized === path || normalized.startsWith(`${path}/`);
    };
    const hasSpace = snapshot.spaces.some(
      (space) =>
        (space.machine ?? null) === machine &&
        (contains(space.folder) || contains(snapshot.cwdBySpace.get(space.id) ?? "")),
    );
    const id = JSON.stringify([target.key, target.path]);
    if (open.has(path) || hasSpace || this.openingWorktrees.has(id))
      return "Checkout is open or opening in Herdr.";
    if (this.checkingRemoval.has(id) || (includeRemoving && this.removingWorktrees.has(id)))
      return "Another removal is in progress.";
    return null;
  }

  requestBulkWorktreeRemoval(key: string, _cx: Context) {
    if (this.busyBulkRemoval.has(key)) return;
    if (this.pendingBulkRemoval) this.cancelBulkWorktreeRemoval(this.pendingBulkRemoval.token);
    this.busyBulkRemoval.add(key);
    this.pendingRemoval = null;
    const token = String(++this.removalSequence);
    this.pendingBulkRemoval = { token, key, plan: null, started: false };
    openOverlay({
      mod: "frantss-worktree-removal",
      kind: "dialog",
      width: 640,
      height: 560,
      props: { token, command: { name: `frantss.remove-worktrees:${token}` } },
    });
  }

  cancelBulkWorktreeRemoval(token: string) {
    if (this.pendingBulkRemoval?.token !== token) return;
    this.busyBulkRemoval.delete(this.pendingBulkRemoval.key);
    this.pendingBulkRemoval = null;
  }

  inspectBulkWorktreeRemoval(token: string, cx: Context) {
    const pending = this.pendingBulkRemoval;
    if (pending?.token !== token || pending.started) return;
    pending.started = true;
    cx.spawn(async () => {
      try {
        const plan = await planWorktreeRemoval(pending.key, exec, (target) =>
          this.pendingBulkRemoval === pending
            ? this.worktreeRemovalBlock(target)
            : "Inspection cancelled.",
        );
        if (this.pendingBulkRemoval !== pending) return;
        pending.plan = plan;
        run(
          `frantss-worktree-removal.result:${encodeURIComponent(JSON.stringify({ token, paths: plan.targets.map((target) => target.path), skipped: plan.skipped }))}`,
        );
      } catch (error) {
        if (this.pendingBulkRemoval !== pending) return;
        run(
          `frantss-worktree-removal.result:${encodeURIComponent(JSON.stringify({ token, error: String(error) }))}`,
        );
      } finally {
        if (this.pendingBulkRemoval === pending) this.busyBulkRemoval.delete(pending.key);
      }
    });
  }

  confirmedBulkWorktreeRemoval(token: string, cx: Context) {
    if (this.pendingBulkRemoval?.token !== token || !this.pendingBulkRemoval.plan) return;
    const { key, plan } = this.pendingBulkRemoval;
    this.pendingBulkRemoval = null;
    if (this.busyBulkRemoval.has(key)) return;
    this.busyBulkRemoval.add(key);
    for (const target of plan.targets)
      this.removingWorktrees.add(JSON.stringify([key, target.path]));
    cx.spawn(async (cx) => {
      try {
        const result = await removeWorktrees(plan, exec, (target) =>
          this.worktreeRemovalBlock(target, false),
        );
        notify({
          title: `Removed ${result.removed.length} worktree${result.removed.length === 1 ? "" : "s"}; skipped ${result.skipped.length}`,
          body: [
            ...result.removed.map((path) => `Removed: ${path}`),
            ...result.skipped.map((item) => `Skipped: ${item.path}: ${item.reason}`),
          ].join("\n"),
        });
        this.refreshWorktrees(cx, key);
      } finally {
        for (const target of plan.targets)
          this.removingWorktrees.delete(JSON.stringify([key, target.path]));
        this.busyBulkRemoval.delete(key);
      }
    });
  }

  // Reads ahead/behind for the repo places it hasn't read lately.
  trackBranches(cx: Context, places: Iterable<string>) {
    this.branches ??= {};
    const now = Date.now();
    for (const key of new Set(places)) {
      if (!this.repos?.[key] || now - (this.branches[key]?.checkedAt ?? 0) < BRANCH_REFRESH_MS)
        continue;
      this.branches[key] = { checkedAt: now, status: this.branches[key]?.status ?? null };
      const [on, cwd] = JSON.parse(key);
      cx.spawn(async (cx) => {
        const result = await exec("git", BRANCH_STATUS_ARGS, { cwd, on }).catch((): null => null);
        const status = result?.code === 0 ? parseBranchStatus(result.stdout) : null;
        if (JSON.stringify(status) === JSON.stringify(this.branches[key].status)) return;
        this.branches[key].status = status;
        cx.notify();
      });
    }
  }

  // Stamps agents whose status changed, so their rows can say for how long.
  trackStatusTimes(list: AgentInfo[]) {
    if (!this.statusStamps) {
      try {
        this.statusStamps = JSON.parse(localStorage.getItem(STATUS_STAMPS) ?? "{}");
      } catch {
        this.statusStamps = {};
      }
    }
    const next = stampStatuses(this.statusStamps, list, Date.now());
    if (!next) return;
    this.statusStamps = next;
    localStorage.setItem(STATUS_STAMPS, JSON.stringify(next));
  }

  // Each workspace's color, giving new workspaces one once no repo lookup can still change their keys.
  colorWorkspaces(keys: string[]) {
    const colors = workspaceColors();
    if (this.lookingUp?.size) return colors;
    const next = assignColors(colors, keys);
    if (next) setShared(WORKSPACE_COLORS, next);
    return next ?? colors;
  }

  // Spaces in order, those of one repo (or, outside a repo, one folder) together where the first of them is.
  spaceGroups(snapshot: WorkspaceSnapshot, list = snapshot.spaces) {
    const groups = new Map<string, SpaceGroup>();
    for (const s of list) {
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

  top(t: Theme, snapshot: WorkspaceSnapshot, space: SpaceInfo | undefined) {
    const tab = space?.tabs.find((t) => t.active);
    // Like the site's path line, faint crumbs joined by "/" with the current one accented, naming where
    // you stand in the rail: workspace / branch / tab. Each crumb opens what it names.
    // Only the current space's place is looked up, which is all its group's name and folder need.
    const key = space && this.workspaceKey(space, snapshot);
    const [group] = space
      ? this.spaceGroups(
          snapshot,
          snapshot.spaces.filter((s) => this.workspaceKey(s, snapshot) === key),
        )
      : [];
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
        text: slugify(tabName(tab, snapshot.panesByTab.get(tab.id) ?? [], space)),
        onClick: () =>
          menu("tab", {
            id: tab.id,
            space: space.id,
            name: tabName(tab, snapshot.panesByTab.get(tab.id) ?? [], space),
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

  // One rail row: "❯ label · tail ······ value" with a `value`, else "❯ label" with an optional `end`
  // beside it. The ❯ is a separate marker that glides between rows; the current row is also filled.
  // `lead`: the icon column, false for none. `lit`: bright without being current (a workspace, the
  // active space); `dim`: faint (a workspace with nothing open, a closed agent). `strong`: medium weight
  // (a workspace). `collapsed`: a chevron in the first column, pointing the way what is under the row
  // is (true closed, false open); none when undefined. `connector`: a tree glyph in that column instead
  // (a tab's panes). `flush`: no first column at all.
  row(
    t: Theme,
    {
      id,
      current,
      lit,
      dim,
      strong,
      indent,
      lead,
      text,
      tail,
      value,
      end,
      onClick,
      activate,
      focus,
      controlFocus,
      onMenu,
      hoverEnd,
      collapsed,
      connector,
      flush,
    }: RailRow,
  ) {
    const hovered =
      Boolean(hoverEnd) &&
      (this.hovered === id || focus?.is_focused() || controlFocus?.some((h) => h?.is_focused()));
    return (
      h_flex()
        .id(id)
        // Inset 4px with rounded corners, like frantss-menu's rows; content keeps its 12px from the edge.
        // Margins, not offsets: footer and closed rows are in flow, where `left` would shift them.
        .left(0)
        .right(0)
        .mx(4)
        .h(RAIL.row)
        .px(8)
        .rounded(3)
        .gap(8)
        .items_center()
        .text_size(12)
        .when(Boolean(strong), (e) => e.font_medium())
        .text_color(current || lit ? t.foreground : dim ? t.dim : t.muted)
        .when(Boolean(current), (e) => e.bg(t.selected))
        .when(!current, (e) => e.hover((s) => s.bg(t.hover).text_color(t.foreground)))
        .when(Boolean(activate || onClick), (e) =>
          e.on_click(activate ? (_event, cx) => activate(cx) : onClick),
        )
        .when(Boolean(focus), (e) => e.track_focus(focus))
        .when(Boolean(activate), (e) =>
          e
            .tab_index(0)
            .accessibility_label(text)
            .focus((s) =>
              s.bg(t.selected).text_color(t.foreground).border_1().border_color(t.accent),
            )
            .on_key_down((event, cx) => {
              if (focus && !focus.is_focused()) return;
              if (event.key === "enter" || event.key === "space") {
                cx.stop_propagation();
                activate(cx);
              }
            }),
        )
        .when(Boolean(onMenu), (e) => e.on_mouse_down("right", onMenu))
        .when(Boolean(hoverEnd), (e) =>
          e.on_hover((over, cx) => {
            if (over) this.hovered = id;
            else if (this.hovered === id) this.hovered = null;
            cx.notify();
          }),
        )
        // The chevron sits at the row's indent, in the column a ❯ marks on other rows.
        .when(!flush, (e) =>
          e.child(
            h_flex()
              .w(10 + (indent ?? 0))
              .flex_none()
              .justify_end()
              .when(collapsed !== undefined, (e) => e.child(chevron(t, collapsed)))
              .when(connector !== undefined, (e) => e.text_color(t.dim).child(connector)),
          ),
        )
        .when(lead !== false, (e) => e.child(lead ?? div().w(14).flex_none()))
        .child(
          h_flex()
            .flex_1()
            .min_w(0)
            .gap(5)
            .items_center()
            .child(
              div()
                .min_w(0)
                .when(Boolean(tail), (e) => e.max_w(120))
                .truncate()
                .child(text),
            )
            .when(Boolean(tail), (e) => e.child(tail)),
        )
        .when(hovered, (e) => e.child(hoverEnd))
        .when(!hovered && value !== undefined, (e) =>
          e.child(
            div().flex_none().max_w(80).truncate().text_size(11).text_color(t.dim).child(value),
          ),
        )
        .when(!hovered && Boolean(end), (e) => e.child(end))
    );
  }

  // A section's header; clicking it opens or closes the section. `action`: a control at the header's
  // end (the workspaces' +). The title takes its status's color, else the foreground. Closed, it shows
  // its `urgent` status's dot.
  header(
    t: Theme,
    {
      id,
      title,
      count,
      status,
      action,
      urgent,
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
      .on_click((_event, cx) => {
        toggleCollapsed(id);
        if (id === "spaces") this.refreshWorktrees(cx);
      })
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
      .child(div().flex_1())
      .when(collapsed && Boolean(urgent), (e) => e.child(statusDot(t, urgent)))
      .when(Boolean(action), (e) => e.child(action));
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

  // An agent's open pull requests as one chip in their most urgent state's color, from what the
  // GitHub mod shares. Clicking it shows them in the GitHub panel.
  prChip(t: Theme, address: string) {
    const all = (shared(AGENT_PRS) as Record<string, AgentPr[]> | null)?.[address] ?? [];
    const prs = all.filter(isOpen),
      state = mostUrgentPr(prs);
    if (!state) return null;
    const { label, color } = PR_STATES[state];
    return h_flex()
      .id(`prs-${address}`)
      .h(16)
      .px(5)
      .gap(4)
      .items_center()
      .flex_none()
      .rounded(8)
      .border_1()
      .border_color(t.input)
      .text_size(10)
      .text_color(t.muted)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(`${label}. Show in GitHub`)
      .accessibility_label(`${prs.length} open pull requests, ${label}`)
      .on_click((_event, cx) => {
        cx.stop_propagation();
        showAgentPrs(address);
      })
      .child(
        div()
          .size(6)
          .rounded(3)
          .flex_none()
          .bg(t[color] ?? t.dim),
      )
      .child(`${prs.length} PR${prs.length > 1 ? "s" : ""}`);
  }

  // An agent row's hover controls: its PR chip, peek, and interrupt while it works.
  agentControls(t: Theme, a: AgentInfo) {
    const chip = this.prChip(t, a.address);
    return h_flex()
      .gap(4)
      .items_center()
      .when(Boolean(chip), (e) => e.child(chip))
      .child(
        this.control(t, `peek-${a.address}`, "Peek", svg("mods/github/eye.svg").size(10), () =>
          run("terminal.peek", { terminal: a.address }),
        ),
      )
      .when(a.status === "working", (e) =>
        e.child(
          this.control(
            t,
            `interrupt-${a.address}`,
            "Interrupt",
            svg("mods/workspace-chrome/square.svg").size(10),
            (cx) => cx.spawn(() => hcOrToast(["interrupt", a.address], "Could not interrupt")),
          ),
        ),
      );
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

  rail(t: Theme, list: AgentInfo[], snapshot: WorkspaceSnapshot, cx: Context) {
    this.usedWorktreeFocus.clear();
    const all = snapshot.spaces;
    const groups = [
      { status: "pinned", label: "Pinned", agents: list.filter((a) => a.pinned) },
      ...GROUPS.map((g) => ({
        ...g,
        agents: list.filter((a) => !a.pinned && a.status === g.status),
      })),
    ];
    setAgentOrder(groups.flatMap((g) => g.agents.map((a) => a.address)));
    const named = new Set(
      all.flatMap((s) => s.tabs.filter((tab) => tab.named).map((tab) => tab.id)),
    );
    // Each repo (or folder) is a row with its spaces under it, and each space with its tabs under it
    // until you close it; the current space is lit and the current tab marked. Each row has its level's
    // icon (folder; checkout or worktree branch; program), its name, then a status dot. A tab with more
    // than one pane lists its panes under it. A space with one tab of one pane stands for that tab: it
    // shows its name and program, takes the marker and has nothing to close.
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
    // A dot left of where a workspace row's + sits, under that row's own dot; `plus` fills that column.
    const dotEnd = (status: string, plus?: Element) => {
      const statusIndicator = statusDot(t, status);
      if (!statusIndicator && !plus) return null;
      return h_flex()
        .gap(8)
        .items_center()
        .child(statusIndicator ?? div().w(6))
        .child(plus ?? div().w(PLUS_WIDTH));
    };
    // A worktree space has a branch icon, as Codex marks worktree threads; its own checkout has a commit.
    // A space standing for its tab has the tab's program icon instead, so its branch moves to its end.
    const linked = (s: SpaceInfo) => this.checkouts?.[snapshot.placeBySpace.get(s.id)] === "linked";
    const branchIcon = () => treeIcon(t, "mods/workspace-chrome/branch.svg");
    const spaceIcon = (s: SpaceInfo) =>
      standsForTab(s)
        ? programIcon(t, snapshot.leadByTab.get(s.tabs[0].id)?.program)
        : linked(s)
          ? branchIcon()
          : treeIcon(t, "mods/frantss/checkout.svg");
    // A space's branch unless its row already names it or it is main or master, then its commits
    // ahead and behind. A worktree standing for its tab keeps its branch icon even without a name.
    const branchTail = (s: SpaceInfo, text: string) => {
      const branch =
        s.branch && !DEFAULT_BRANCHES.has(s.branch) && s.branch !== text ? s.branch : null;
      const { ahead = 0, behind = 0 } =
        this.branches?.[snapshot.placeBySpace.get(s.id)]?.status ?? {};
      const icon = Boolean(branch) || (standsForTab(s) && linked(s));
      if (!icon && !ahead && !behind) return null;
      return h_flex()
        .min_w(0)
        .max_w(104)
        .gap(4)
        .items_center()
        .text_size(11)
        .text_color(t.dim)
        .when(icon, (e) => e.child(branchIcon()))
        .when(Boolean(branch), (e) => e.child(div().min_w(0).truncate().child(branch)))
        .when(ahead > 0, (e) =>
          e.child(
            div()
              .flex_none()
              .text_color(t.ansi2 ?? t.working)
              .child(`↑${ahead}`),
          ),
        )
        .when(behind > 0, (e) =>
          e.child(
            div()
              .flex_none()
              .text_color(t.ansi1 ?? t.blocked)
              .child(`↓${behind}`),
          ),
        );
    };
    const spaceText = (s: SpaceInfo) =>
      standsForTab(s) ? tabName(s.tabs[0], tabPanes(s.tabs[0]), s) : spaceName(s);
    const spaceEnd = (s: SpaceInfo, plus?: Element) => {
      const dotted = dotEnd(s.status, plus);
      const tail = branchTail(s, spaceText(s));
      if (!tail) return dotted;
      return h_flex()
        .min_w(0)
        .gap(8)
        .items_center()
        .child(tail)
        .child(dotted ?? div().w(6 + 8 + PLUS_WIDTH));
    };
    const paneMenu = (pane: PaneInfo) => menu("pane", { pane: pane.pane, terminal: pane.terminal });
    const tabMenu = (s: SpaceInfo, tab: TabInfo) => {
      const panes = tabPanes(tab);
      return panes.length === 1
        ? paneMenu(panes[0])
        : menu("tab", { id: tab.id, space: s.id, name: tabName(tab, panes, s) });
    };
    const spaceRow = (s: SpaceInfo): RailRow => ({
      id: `space-${s.id}`,
      current: s.active && standsForTab(s),
      lit: s.active,
      lead: spaceIcon(s),
      end: spaceEnd(s),
      // Hovered, its + starts a thread as a new tab in this space (no repo: no Worktree choice).
      hoverEnd: spaceEnd(
        s,
        newThread(`tab-${s.id}`, {
          space: s.id,
          folder: snapshot.cwdBySpace.get(s.id),
          machine: s.machine,
        }),
      ),
      collapsed: standsForTab(s) ? undefined : spaceClosed(s),
      text: spaceText(s),
      onClick: () => (standsForTab(s) ? run("space.select", { id: s.id }) : toggleSpace(s)),
      onMenu: () =>
        standsForTab(s)
          ? tabMenu(s, s.tabs[0])
          : menu("space", {
              id: s.id,
              name: spaceName(s),
              checkout: this.checkouts?.[snapshot.placeBySpace.get(s.id)],
            }),
    });
    const tabRows = (s: SpaceInfo): RailRow[] =>
      standsForTab(s) || spaceClosed(s)
        ? []
        : s.tabs.flatMap((tab) => [tabRow(s, tab), ...paneRows(s, tab)]);
    const split = (tab: TabInfo) => tabPanes(tab).length > 1;
    const tabRow = (s: SpaceInfo, tab: TabInfo): RailRow => ({
      id: `tab-${tab.id}`,
      // A split tab's marker sits on its focused pane.
      current: s.active && tab.active && !split(tab),
      indent: 14,
      lead: programIcon(t, snapshot.leadByTab.get(tab.id)?.program),
      end: dotEnd(tab.status),
      text: tabName(tab, tabPanes(tab), s),
      onClick: () => run("tab.select", { id: tab.id }),
      onMenu: () => tabMenu(s, tab),
    });
    const paneRows = (s: SpaceInfo, tab: TabInfo): RailRow[] =>
      (split(tab) ? tabPanes(tab) : []).map((pane, index, all) => ({
        id: `pane-${pane.pane}`,
        current: s.active && tab.active && pane.focused,
        indent: 28,
        connector: index === all.length - 1 ? "└" : "├",
        lead: programIcon(t, pane.program),
        end: dotEnd(pane.status),
        text: paneName(pane),
        onClick: () => run("pane.focus", { pane: pane.pane }),
        onMenu: () => paneMenu(pane),
      }));
    const withTabs = (s: SpaceInfo) => [spaceRow(s), ...tabRows(s)];
    // A group row is a workspace: its open spaces (its own checkout and worktrees) are under it, unless
    // you closed it. Clicking opens or closes it; its + (on hover, as on space rows) starts a thread
    // (frantss-thread) in its own checkout (not one of Herdr's worktrees), else its first space; its
    // menu keeps or removes it (frantss-workspace).
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
    // A workspace's letter in its color on a tint of it, like the rail's other marks.
    const workspaceColor = (key: string) => t[colors[key]] ?? t.dim;
    // `size` 12: the small copy on an agent's row.
    const avatar = (key: string, name: string, faded = false, size = 14) =>
      h_flex()
        .size(size)
        .flex_none()
        .rounded(3)
        .bg(`${workspaceColor(key)}26`)
        .items_center()
        .justify_center()
        .text_size(size === 14 ? 9.5 : 8.5)
        .line_height(`${size}px`)
        .text_center()
        .font_medium()
        .text_color(workspaceColor(key))
        .when(faded, (e) => e.opacity(0.55))
        .child(name.slice(0, 1).toUpperCase() || "?");
    const groupRow = (g: SpaceGroup, saved: NamedWorkspace): RailRow => {
      const s = ownCheckout(g);
      const status = mostUrgent(g.spaces.map((space) => space.status));
      return {
        id: `group-${g.key}`,
        lit: true,
        strong: true,
        lead: avatar(g.key, saved?.name ?? g.name),
        text: saved?.name ?? g.name,
        flush: true,
        end: dotEnd(status),
        hoverEnd: dotEnd(
          status,
          newThread(g.key, {
            space: s.id,
            folder: snapshot.cwdBySpace.get(s.id),
            machine: s.machine,
            repo: g.repo,
          }),
        ),
        onClick: (_event, cx) => {
          toggleCollapsed(`workspace:${g.key}`);
          this.refreshWorktrees(cx);
        },
        // Only folders on this machine can be kept (the folder picker's, and new spaces', machine).
        onMenu: () => g.local && workspaceMenu(saved?.folder ?? g.folder, Boolean(saved)),
      };
    };
    // A saved workspace with nothing open: clicking opens a space in its folder.
    const closedRow = (w: NamedWorkspace): RailRow => ({
      id: `group-${w.key}`,
      flush: true,
      dim: true,
      strong: true,
      lead: avatar(w.key, w.name, true),
      text: w.name,
      hoverEnd: dotEnd("", newThread(w.key, { folder: w.folder, repo: w.repo })),
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
    const colors = this.colorWorkspaces([...savedKeys, ...unsaved.map((group) => group.key)]);
    const spaceById = new Map(all.map((s) => [s.id, s]));
    const worktreeRows = (g: SpaceGroup): RailRow[] => {
      if (!g.repo || collapsed.includes("spaces")) return [];
      const open = collapsed.includes(`worktrees:${g.key}`);
      const state = this.worktrees.state(g.key);
      let unopened = state?.worktrees;
      if (unopened?.length) {
        const { open: opened, normalize } = this.worktreeSpaces(g.key, snapshot, g.spaces);
        unopened = unopened.filter((tree) => !opened.has(normalize(tree.path)));
      }
      const refresh = (cx: Context) => this.refreshWorktrees(cx, g.key);
      const refreshId = `worktrees-refresh-${g.key}`;
      const refreshFocus = this.worktreeFocusHandle(refreshId);
      const removeId = `worktrees-remove-all-${g.key}`;
      const removeFocus = this.worktreeFocusHandle(removeId);
      const refreshControl = () =>
        this.control(
          t,
          refreshId,
          state?.error ? "Retry worktree refresh" : "Refresh worktrees",
          svg("mods/github/refresh.svg").size(10),
          refresh,
        ).when(Boolean(refreshFocus), (e) => e.track_focus(refreshFocus));
      const rows: RailRow[] = [
        {
          id: `worktrees-${g.key}`,
          lead: branchIcon(),
          focus: this.worktreeFocusHandle(`worktrees-${g.key}`),
          controlFocus: [refreshFocus, removeFocus],
          end: refreshControl(),
          hoverEnd: h_flex()
            .gap(4)
            .items_center()
            .child(
              this.control(
                t,
                removeId,
                "Remove all eligible worktrees…",
                svg("mods/frantss-files/trash.svg").size(10),
                (cx) => this.requestBulkWorktreeRemoval(g.key, cx),
              ).when(Boolean(removeFocus), (e) => e.track_focus(removeFocus)),
            )
            .child(refreshControl()),
          text: "Other worktrees",
          collapsed: !open,
          value: state?.error
            ? state.worktrees
              ? "Stale"
              : "Unavailable"
            : unopened && String(unopened.length),
          activate: (cx) => {
            toggleCollapsed(`worktrees:${g.key}`);
            this.refreshWorktrees(cx);
          },
        },
      ];
      if (!open) return rows;
      if (!state || state.loading)
        rows.push({
          id: `worktrees-loading-${g.key}`,
          indent: 14,
          text: "Checking worktrees…",
        });
      if (unopened?.length === 0 && !state?.error)
        rows.push({
          id: `worktrees-empty-${g.key}`,
          indent: 14,
          text: "No other worktrees",
        });
      for (const tree of unopened ?? []) {
        const id = `worktree-${JSON.stringify([g.key, tree.path])}`;
        const actions = ["open", "thread", ...(!tree.main ? ["remove"] : [])];
        const handles = actions.map((action) => this.worktreeFocusHandle(`${id}-${action}`));
        const open = this.control(
          t,
          `${id}-open`,
          "Open worktree",
          svg("mods/github/external-link.svg").size(10),
          (cx) => this.openWorktree(tree, g.key, cx),
        ).when(Boolean(handles[0]), (e) => e.track_focus(handles[0]));
        const thread = this.control(t, `${id}-thread`, "New thread", "+", () =>
          this.newWorktreeThread(tree, g.key),
        ).when(Boolean(handles[1]), (e) => e.track_focus(handles[1]));
        rows.push({
          id,
          focus: this.worktreeFocusHandle(id),
          controlFocus: handles,
          indent: 14,
          lead: branchIcon(),
          text: tree.branch ?? tree.head.slice(0, 8),
          hoverEnd: h_flex()
            .gap(4)
            .items_center()
            .child(open)
            .child(thread)
            .when(!tree.main, (e) =>
              e.child(
                this.control(
                  t,
                  `${id}-remove`,
                  "Remove worktree…",
                  svg("mods/frantss-files/trash.svg").size(10),
                  (cx) => this.requestWorktreeRemoval(tree, g.key, cx),
                ).when(Boolean(handles[2]), (e) => e.track_focus(handles[2])),
              ),
            ),
          activate: (cx) => this.openWorktree(tree, g.key, cx),
        });
      }
      return rows;
    };
    const groupRows = (g: SpaceGroup, w: NamedWorkspace) => [
      groupRow(g, w),
      ...(workspaceClosed(g) ? [] : [...g.spaces.flatMap(withTabs), ...worktreeRows(g)]),
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
    const pinnedStatus = (a: AgentInfo) => {
      const label = GROUPS.find((g) => g.status === a.status)?.label ?? a.status;
      return dot(t, a.status).id(`status-${a.address}`).tooltip(label).accessibility_label(label);
    };
    // An agent's space after its name, with its workspace's avatar.
    const workspaceNames = new Map<string, string>([
      ...open.map((g): [string, string] => [g.key, g.name]),
      ...saved.map((w): [string, string] => [w.key, w.name]),
    ]);
    const agentTail = (a: AgentInfo) => {
      const s = spaceById.get(a.space);
      const key = s && this.workspaceKey(s, snapshot);
      const name = workspaceNames.get(key);
      return h_flex()
        .flex_1()
        .min_w(0)
        .gap(4)
        .items_center()
        .text_color(t.dim)
        .child("·")
        .when(Boolean(name), (e) => e.child(avatar(key, name, false, 12)))
        .child(div().min_w(0).truncate().child(a.space_name));
    };
    const since = (a: AgentInfo) => {
      const stamp = this.statusStamps?.[a.address];
      return stamp ? age(now - stamp.at) : undefined;
    };
    const sections: RailSection[] = [
      {
        id: "spaces",
        title: "Workspaces",
        count: saved.length + unsaved.length,
        urgent: mostUrgent(all.map((s) => s.status)),
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
          urgent: mostUrgent(g.agents.map((a) => a.status)),
          rows: g.agents.map((a) => ({
            id: `agent-${a.address}`,
            current: a.focused,
            lead: a.pinned
              ? h_flex()
                  .gap(8)
                  .items_center()
                  .flex_none()
                  .child(icon(t, a.program))
                  .child(pinnedStatus(a))
              : icon(t, a.program),
            agent: true,
            text: named.has(a.tab)
              ? a.tab_name
              : paneName(
                  snapshot.panesByTab.get(a.tab)?.find((p) => p.pane === a.pane) ?? {
                    pane: a.pane,
                    title: a.title,
                    program: a.program,
                  },
                ),
            tail: a.space_name ? agentTail(a) : undefined,
            value:
              a.focused && this.context?.address === a.address
                ? this.contextMeter(t, this.context.usage)
                : since(a),
            end: this.prChip(t, a.address),
            onClick: () => run("agent.focus", { terminal: a.address }),
            onMenu: () => menu("pane", { pane: a.pane, terminal: a.address }),
            hoverEnd: this.agentControls(t, a),
          })),
        })),
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

    this.syncWorktreeFocus(cx);
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
      .when(closed.length > 0, (e) =>
        e.child(
          this.recentlyClosed(
            t,
            closed.map((record) => this.closedRow(t, record, now)),
            collapsed.includes("closed"),
          ),
        ),
      )
      .child(this.subscriptions(t, now))
      .child(this.footer(t));
  }

  // Subscription quota, pinned above the footer. Closed, its header shows each subscription's most used
  // window; tooltips don't show in this layout, so details stay in visible text.
  subscriptions(t: Theme, now: number) {
    const usage = this.subscriptionUsage;
    const open = collapsedIds().includes("usage:open");
    const providers = SUBSCRIPTIONS.map((provider) => {
      const snapshot = usage.data[provider];
      const stale = snapshot.windows.some((window) => usageWindow(window, snapshot, now).stale);
      return {
        provider,
        snapshot,
        name: provider === "claude" ? "Claude" : "Codex",
        status: stale ? "Stale" : snapshot.error ? "Unavailable" : "",
      };
    });
    const updatedAt = Math.max(...providers.map((p) => p.snapshot.updatedAt ?? 0));
    const updated = updatedAt ? age(now - updatedAt) : "";
    const meter = (percent: number, stale: boolean) =>
      meterBar(t, percent, stale).flex_1().min_w(0);
    const summary = providers.map(({ provider, snapshot, name, status }) => {
      const peak = peakWindow(snapshot, now);
      const full = !status && peak && peak.usedPercent >= 90;
      const value = [
        peak ? `${Math.round(peak.usedPercent)}%` : "—",
        full ? resetIn(peak.resetsAt, now) : null,
      ]
        .filter(Boolean)
        .join(" ");
      return { provider, name, value, color: status ? t.muted : full ? t.blocked : t.foreground };
    });
    return v_flex()
      .id("subscription-usage")
      .flex_none()
      .py(8)
      .gap(6)
      .border_t(1)
      .border_color(t.border)
      .child(
        h_flex()
          .id("header-usage")
          .h(RAIL.header)
          .px(12)
          .gap(8)
          .items_center()
          .cursor_pointer()
          .on_click(() => toggleCollapsed("usage:open"))
          .accessibility_label(
            `Usage: ${summary.map((s) => `${s.name} ${s.value}`).join(", ")}. ${open ? "Collapse" : "Expand"}`,
          )
          .child(chevron(t, !open))
          .child(
            div().flex_none().text_size(11).font_medium().text_color(t.foreground).child("Usage"),
          )
          .child(
            h_flex()
              .flex_1()
              .min_w(0)
              .gap(8)
              .justify_end()
              .text_size(10)
              .when(usage.refreshing, (e) =>
                e.child(div().text_color(t.muted).child("Refreshing…")),
              )
              .when(!usage.refreshing && open && Boolean(updated), (e) =>
                e.child(
                  div()
                    .text_color(t.muted)
                    .child(updated === "now" ? "now" : `${updated} ago`),
                ),
              )
              .when(!usage.refreshing && !open, (e) =>
                e.children(
                  summary.map((s) =>
                    h_flex()
                      .id(`usage-summary-${s.provider}`)
                      .flex_none()
                      .gap(4)
                      .child(div().text_color(t.muted).child(s.name))
                      .child(div().text_color(s.color).child(s.value)),
                  ),
                ),
              ),
          )
          .child(
            button("refresh-subscriptions", "↻", (cx) => this.refreshSubscriptions(cx), {
              variant: "quiet",
              size: "dense",
              square: true,
              disabled: usage.refreshing,
              tooltip: "Refresh subscription usage",
            }),
          ),
      )
      .when(open, (e) =>
        e.children(
          providers.map(({ provider, snapshot, name, status }) =>
            v_flex()
              .id(`usage-${provider}`)
              .px(16)
              .gap(4)
              .child(
                h_flex()
                  .items_center()
                  .gap(6)
                  .child(div().flex_1().text_size(11).text_color(t.foreground).child(name))
                  .child(div().text_size(10).text_color(t.muted).child(status)),
              )
              .children(
                snapshot.windows.map((window) => {
                  const state = usageWindow(window, snapshot, now);
                  const reset = resetIn(window.resetsAt, now);
                  return h_flex()
                    .id(`usage-${provider}-${window.label}`)
                    .gap(8)
                    .items_center()
                    .accessibility_label(
                      `${name} ${window.label}: ${state.percent} used${state.stale ? " (stale)" : ""}. ${reset ? `Resets in ${reset}` : "Reset passed"}`,
                    )
                    .child(
                      div()
                        .w(24)
                        .flex_none()
                        .truncate()
                        .text_size(10)
                        .text_color(t.muted)
                        .child(window.label),
                    )
                    .child(meter(state.expired ? 0 : window.usedPercent, state.stale))
                    .child(
                      div()
                        .w(32)
                        .flex_none()
                        .text_right()
                        .text_size(10)
                        .text_color(t.foreground)
                        .child(state.percent),
                    )
                    .child(
                      div()
                        .w(40)
                        .flex_none()
                        .text_right()
                        .text_size(10)
                        .text_color(t.muted)
                        .child(reset ?? "—"),
                    );
                }),
              )
              .when(Boolean(snapshot.error) || !snapshot.windows.length, (e) =>
                e.child(
                  div()
                    .text_size(10)
                    .text_color(t.muted)
                    .child(
                      snapshot.error ??
                        (usage.refreshing ? "Reading usage…" : "Waiting for usage…"),
                    ),
                ),
              ),
          ),
        ),
      );
  }

  // Recently closed agents, pinned above the footer; past a few rows it scrolls on its own.
  recentlyClosed(t: Theme, rows: RailRow[], collapsed: boolean) {
    return v_flex()
      .flex_none()
      .py(8)
      .gap(RAIL.rowGap)
      .border_t(1)
      .border_color(t.border)
      .child(
        this.header(t, { id: "closed", title: "Recently closed", count: rows.length, collapsed }),
      )
      .when(!collapsed, (e) =>
        e.child(
          v_flex()
            .id("frantss-closed")
            // A scroll container needs a definite height; max_h alone never scrolls.
            .h(Math.min(rows.length, 5) * (RAIL.row + RAIL.rowGap) - RAIL.rowGap)
            .flex_none()
            .overflow_y_scrollbar()
            // flex_none keeps the rows at full height, so they overflow the cap instead of shrinking into it.
            .child(
              v_flex()
                .flex_none()
                .gap(RAIL.rowGap)
                .children(rows.map((r) => this.row(t, r))),
            ),
        ),
      );
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

  // A shared pane can be zoomed or closed here; a terminal can also move to its own tab.
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
          .min_w(0)
          .truncate()
          .text_color(pane?.focused ? t.foreground : t.muted)
          .child(paneName(pane)),
      )
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(where))
      .when(Boolean(pane?.status), (e) => e.child(dot(t, pane.status)))
      .when(Boolean(pane), (e) =>
        e
          .child(
            this.control(
              t,
              "split-right",
              "Split right",
              svg("mods/pane/split-right.svg").size(12),
              () => run("pane.split", { direction: "right", pane: pane.pane }),
            ),
          )
          .child(
            this.control(
              t,
              "split-down",
              "Split down",
              svg("mods/frantss/split-down.svg").size(12),
              () => run("pane.split", { direction: "down", pane: pane.pane }),
            ),
          ),
      )
      .when(withOthers, (e) =>
        e
          .when(Boolean(pane.terminal), (e) =>
            e.child(
              this.control(
                t,
                "move-pane-to-tab",
                "Move to new tab",
                svg("mods/frantss/move-to-tab.svg").size(12),
                () => run(`frantss.move-pane:${encodeURIComponent(pane.pane)}`),
              ),
            ),
          )
          .child(
            this.control(
              t,
              "zoom-pane",
              pane.zoomed ? "Unzoom pane" : "Zoom pane",
              svg(`mods/pane/${pane.zoomed ? "unzoom" : "zoom"}.svg`).size(12),
              () => run("pane.zoom", { pane: pane.pane }),
            ),
          )
          .child(
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
    if (role === "top") {
      const space = snapshot.spaces.find((s) => s.active);
      this.track(cx, space ? [snapshot.placeBySpace.get(space.id)] : []);
      return this.top(t, snapshot, space);
    }
    prunePaneNames([...snapshot.panesByTab.values()].flat());
    this.track(cx, snapshot.placeBySpace.values());
    this.trackBranches(cx, snapshot.placeBySpace.values());
    this.publishWorkspaces(snapshot);
    const list = agents();
    this.trackAgents(cx, list, snapshot);
    this.trackStatusTimes(list);
    // A newly focused agent's context shows at once; the timer keeps it current after.
    const focused = list.find((a) => a.focused);
    const focusedAddress = focused?.address ?? null;
    if (focusedAddress !== this.contextFor || usesContextLabel(focused?.app ?? null)) {
      this.contextFor = focusedAddress;
      this.refreshContext(cx);
    }
    return this.rail(t, list, snapshot, cx);
  }
}
