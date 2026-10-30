import type { AsyncContext, Context, Element, Color } from "gpui-kit";
import type { ExecResult, SpaceInfo } from "herdr";
import type { InboxGroup, InboxItem, PullRequest, PullRequests } from "./github.ts";

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  spaces,
  panes,
  focused,
  props,
  exec,
  hc,
  run,
  theme,
  agents,
  terminals,
  knownAgents,
  home,
  notify,
  shared,
  setShared,
} from "herdr";
import { button } from "./button.ts";
import { ACTIONS, buildInbox, findCheckout, loadPullRequests, squash, taskFor } from "./github.ts";
import { followedPane, panelShown } from "./panel.ts";

interface Location {
  cwd: string | null;
  on: string | null;
}
type Theme = Record<string, Color>;

const POLL_MS = 60000;
// While the panel is hidden, results refresh less often: only the GitHub button's count shows them.
const HIDDEN_POLL_MS = 5 * 60000;
// The number of inbox items that ask for work where the panel looks, for the GitHub button.
const INBOX_COUNT = "github-inbox-count";
// Agents commit only; set to true to let them push to the pull request branch.
const PUSH = false;
// Starting more agents than this at once asks for a second click.
const BATCH_CONFIRM = 3;
const PR_LABEL = "herdr.pr",
  ACTION_LABEL = "herdr.pr.action";
const ICONS = {
  "fix-ci": "mods/github/wrench.svg",
  address: "mods/github/message.svg",
  review: "mods/github/eye.svg",
  open: "mods/github/external-link.svg",
};
const CHEVRON_RIGHT = "mods/workspace-chrome/chevron-right.svg",
  CHEVRON_DOWN = "mods/workspace-chrome/chevron-down.svg";
const SPINNER = "mods/workspace-chrome/spinner.svg",
  REFRESH = "mods/github/refresh.svg";

function location(): Location {
  const explicit = props();
  if (explicit?.cwd) return { cwd: explicit.cwd, on: explicit.on ?? null };
  const space = spaces().find((s) => s.active),
    focus = focused();
  const pane = followedPane(focus);
  return {
    cwd: pane?.cwd || focus?.cwd || (space && spaceFolder(space)) || null,
    on: space?.machine ?? null,
  };
}

// Where a space is now: its first terminal's live folder, else where it was made.
function spaceFolder(space: SpaceInfo) {
  const tabs = new Set(space.tabs.map((tab) => tab.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || space.folder || null;
}

const contextKey = (place) => JSON.stringify(place);
const errorText = (error: unknown) => {
  const message = (error as { message?: unknown })?.message ?? error;
  // oxlint-disable-next-line typescript/no-base-to-string -- Host rejections may contain arbitrary values.
  return String(message).slice(0, 500);
};
const ago = (iso) => {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return seconds < 3600
    ? `${Math.max(1, Math.round(seconds / 60))}m`
    : seconds < 86400
      ? `${Math.round(seconds / 3600)}h`
      : `${Math.round(seconds / 86400)}d`;
};
const slug = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

async function checked(promise: Promise<ExecResult>, what: string) {
  const result = await promise;
  if (result.code !== 0)
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || `${what} failed.`);
  return result.stdout.trim();
}

export default class GitHub extends View {
  declare groups: InboxGroup[];
  declare selected: Set<string>;
  declare starting: Set<string>;
  declare expanded: Set<string>;
  declare inflight: Set<string>;
  declare errors: Map<string, string>;
  declare agentOptions: Awaited<ReturnType<typeof knownAgents>>;
  declare agentKey: string | null;
  declare cache: Map<string, PullRequests>;
  declare repos: Map<string, string | null>;
  declare collapsed: Set<string>;
  declare context: string;
  declare place: Location;
  declare confirming: boolean;
  declare pendingInitialRefresh: boolean;
  declare refreshingAll: boolean;
  declare inboxSource: PullRequests | null;
  declare inboxBusy: Set<string>;
  declare polledAt: number;

  init(_props, cx: AsyncContext) {
    this.pendingInitialRefresh = true;
    this.refreshingAll = false;
    this.inboxSource = null;
    this.inboxBusy = new Set();
    this.polledAt = 0;
    this.groups = [];
    this.selected = new Set();
    this.starting = new Set();
    this.expanded = new Set();
    this.inflight = new Set();
    this.errors = new Map();
    this.agentOptions = [];
    this.agentKey = localStorage.getItem("agent");
    // Saved results show at once after a restart or a code reload; a load replaces them.
    let saved: { cache?: [string, PullRequests][]; repos?: [string, string | null][] } = {};
    try {
      saved = JSON.parse(localStorage.getItem("cache") ?? "{}");
    } catch {
      /* Start empty. */
    }
    this.cache = new Map(saved.cache ?? []);
    this.repos = new Map(saved.repos ?? []);
    try {
      this.collapsed = new Set(JSON.parse(localStorage.getItem("collapsed") ?? "[]"));
    } catch {
      this.collapsed = new Set();
    }
    cx.timer.every(POLL_MS, (cx) => {
      if (this.visible() || Date.now() - this.polledAt >= HIDDEN_POLL_MS) this.refreshAll(cx);
    });
    if (this.visible()) this.refreshAll(cx);
  }

  visible() {
    if (props()?.cwd) return true;
    return panelShown("github");
  }

  // Results are kept per repository, so a space shows its repository's last results at once.
  get repo() {
    return this.repos.get(this.context) ?? null;
  }
  get data() {
    return this.cache.get(this.repo) ?? null;
  }
  get error() {
    return this.errors.get(this.repo ?? this.context) ?? null;
  }

  loading() {
    return this.inflight.has(this.repo);
  }

  // The repository a folder belongs to: its common Git folder on its machine.
  async repoOf(place: Location) {
    const key = contextKey(place);
    if (!this.repos.has(key)) {
      const result = await exec(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        { cwd: place.cwd, on: place.on },
      );
      this.repos.set(
        key,
        result.code === 0 ? contextKey({ repo: result.stdout.trim(), on: place.on ?? null }) : null,
      );
    }
    return this.repos.get(key);
  }

  load(place: Location, cx: Context) {
    cx.spawn((cx) => this.loadPlace(place, cx));
  }

  persistCache() {
    try {
      localStorage.setItem(
        "cache",
        JSON.stringify({ cache: [...this.cache], repos: [...this.repos] }),
      );
    } catch {
      /* Memory still has them. */
    }
  }

  async loadPlace(
    place: Location,
    cx: Context,
    options: { seen?: Set<string>; persist?: boolean } = {},
  ) {
    const context = contextKey(place),
      previousRepo = this.repos.get(context);
    let repo = null,
      started = false,
      errorChanged = false;
    const displayed = () => this.context === context || (repo !== null && this.repo === repo);
    try {
      repo = await this.repoOf(place);
      if (!repo) throw new Error("Not a Git repository.");
      if (options.seen?.has(repo)) return;
      options.seen?.add(repo);
      if (this.inflight.has(repo)) return;
      this.inflight.add(repo);
      started = true;
      if (displayed()) cx.notify();
      this.cache.set(
        repo,
        await loadPullRequests((args) => exec("gh", args, { cwd: place.cwd, on: place.on })),
      );
      this.errors.delete(repo);
      if (options.persist !== false) this.persistCache();
    } catch (error) {
      const key = repo ?? context,
        message = errorText(error);
      errorChanged = this.errors.get(key) !== message;
      this.errors.set(key, message);
    } finally {
      if (started) this.inflight.delete(repo);
      const mappingChanged = this.repos.get(context) !== previousRepo;
      if (
        (started && displayed()) ||
        (errorChanged && displayed()) ||
        (mappingChanged && this.context === context)
      )
        cx.notify();
    }
  }

  refresh(cx: Context, notifyNow = true, loadNow = true) {
    const place = location(),
      key = contextKey(place);
    if (key !== this.context) {
      if (!this.place || (place.on ?? null) !== (this.place.on ?? null))
        this.loadAgents(cx, place.on);
      this.context = key;
      this.place = place;
      this.selected = new Set();
      this.expanded = new Set();
      this.confirming = false;
    }
    if (place.cwd && loadNow) this.load(place, cx);
    if (notifyNow) cx.notify();
  }

  // Every space's repository, so switching to any space shows results at once.
  // The shown one loads first; the others follow one at a time so they don't delay it.
  refreshAll(cx: Context) {
    this.pendingInitialRefresh = false;
    if (this.refreshingAll) return;
    this.polledAt = Date.now();
    this.refresh(cx, false, false);
    const places = [
      this.place,
      ...spaces().map((space) => ({ cwd: spaceFolder(space), on: space.machine ?? null })),
    ].filter((place) => place?.cwd);
    this.refreshingAll = true;
    cx.spawn(async (cx) => {
      try {
        const seen = new Set<string>();
        for (const place of places) await this.loadPlace(place, cx, { seen, persist: false });
      } finally {
        this.refreshingAll = false;
        this.persistCache();
      }
    });
  }

  loadAgents(cx: Context, on) {
    cx.spawn(async (cx) => {
      try {
        this.agentOptions = (await knownAgents({ on })).filter((agent) => agent.installed);
      } catch {
        this.agentOptions = [];
      }
      cx.notify();
    });
  }

  agent() {
    return (
      this.agentOptions.find((agent) => agent.key === this.agentKey) ?? this.agentOptions[0] ?? null
    );
  }

  cycleAgent(cx: Context) {
    if (!this.agentOptions.length) return;
    const index = this.agentOptions.indexOf(this.agent());
    this.agentKey = this.agentOptions[(index + 1) % this.agentOptions.length].key;
    localStorage.setItem("agent", this.agentKey);
    cx.notify();
  }

  // Live terminals that were started for this repository's pull requests.
  linkedAgents(data = this.data) {
    if (!data) return [];
    const prefix = `${data.repo}#`,
      live = new Map(agents().map((agent) => [agent.address, agent]));
    return terminals()
      .filter((t) => t.state === "live" && t.labels?.[PR_LABEL]?.startsWith(prefix))
      .map((t) => {
        const agent = live.get(t.address);
        return {
          address: t.address,
          number: Number(t.labels[PR_LABEL].slice(prefix.length)),
          kinds: (t.labels[ACTION_LABEL] ?? "").split(",").filter(Boolean),
          status: agent?.status ?? t.status ?? null,
          name: agent?.program?.name ?? t.program?.name ?? "agent",
        };
      });
  }

  // A checkout of the pull request's branch: an existing one, else a new worktree beside the worktree mod's.
  async checkout(pr: PullRequest, place: Location) {
    const git = (args) => exec("git", args, { cwd: place.cwd, on: place.on });
    const existing = findCheckout(
      await checked(git(["worktree", "list", "--porcelain"]), "git worktree list"),
      pr.branch,
    );
    if (existing) return existing;
    const common = await checked(
      git(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      "git rev-parse",
    );
    const main = common.endsWith("/.git") ? common.slice(0, -5) : common;
    const userHome = place.on
      ? await checked(exec("sh", ["-c", 'printf %s "$HOME"'], { on: place.on }), "Reading home")
      : home();
    const path = `${userHome}/.herdr/worktrees/${main.split("/").pop()}/${slug(pr.branch)}`;
    await checked(
      exec("git", ["worktree", "add", "--detach", path], { cwd: main, on: place.on }),
      "git worktree add",
    );
    await checked(
      exec("gh", ["pr", "checkout", String(pr.number)], { cwd: path, on: place.on }),
      "gh pr checkout",
    );
    return path;
  }

  // One agent for all of a pull request's items.
  async startOne(
    items: InboxItem[],
    place: Location,
    repo: string,
    agent: Awaited<ReturnType<typeof knownAgents>>[number],
  ) {
    const { pr } = items[0];
    const path = await this.checkout(pr, place);
    const name = `#${pr.number} ${items.map((item) => ACTIONS[item.kind]).join(" + ")}`,
      task = taskFor(items, repo, { push: PUSH });
    const space = spaces().find(
      (s) => (s.machine ?? null) === (place.on ?? null) && spaceFolder(s) === path,
    );
    const [command, args]: [string, Record<string, unknown>] = space
      ? ["tab.new", { space: space.id, folder: path, name, argv: agent.run, task }]
      : ["space.new", { folder: path, machine: place.on, tab: name, argv: agent.run, task }];
    const made = JSON.parse(
      await checked(exec("herdr-app", ["do", command, JSON.stringify(args)]), command),
    );
    if (made.error || !made.terminal)
      throw new Error(made.error ?? `${command} started no terminal.`);
    await checked(
      hc([
        "label",
        made.terminal,
        `${PR_LABEL}=${repo}#${pr.number}`,
        `${ACTION_LABEL}=${items.map((item) => item.kind).join(",")}`,
      ]),
      "hc label",
    );
  }

  start(items: InboxItem[], cx: Context) {
    const agent = this.agent(),
      place = this.place,
      repo = this.data?.repo;
    if (!agent || !repo) {
      notify({
        title: "No agent to start",
        body: "Install an agent that Herdr knows, such as Claude Code or Codex.",
        level: "warning",
      });
      return;
    }
    const byPr = new Map<number, InboxItem[]>();
    for (const item of items) byPr.set(item.pr.number, [...(byPr.get(item.pr.number) ?? []), item]);
    for (const item of items) this.starting.add(item.id);
    this.selected = new Set();
    this.confirming = false;
    cx.spawn(async (cx) => {
      // Sequential: two worktrees of one repo must not be added at the same time.
      for (const [number, prItems] of byPr) {
        try {
          await this.startOne(prItems, place, repo, agent);
        } catch (error) {
          notify({
            title: `Couldn't start an agent for #${number}`,
            body: errorText(error),
            level: "error",
          });
        } finally {
          for (const item of prItems) this.starting.delete(item.id);
          cx.notify();
        }
      }
    });
    cx.notify();
  }

  openInBrowser(url) {
    exec("gh", ["pr", "view", url, "--web"]).catch((error) =>
      notify({ title: "Couldn't open the pull request", body: errorText(error), level: "error" }),
    );
  }

  button(id, label, action, { disabled = false, tooltip = undefined, primary = false } = {}) {
    return button(id, label, action, {
      variant: primary ? "primary" : "quiet",
      disabled,
      tooltip,
    });
  }

  iconButton(
    id,
    icon,
    action,
    {
      disabled = false,
      spinning = false,
      tooltip,
    }: { disabled?: boolean; spinning?: boolean; tooltip?: string } = {},
  ) {
    return button(
      id,
      spinning
        ? svg(SPINNER).size(14).spin(900)
        : typeof icon === "string"
          ? svg(icon).size(14)
          : icon,
      action,
      { variant: "quiet", square: true, disabled, tooltip },
    );
  }

  groupHeader(title, count, color, t) {
    const collapsed = this.collapsed.has(title);
    return h_flex()
      .id(`group-${title}`)
      .h(26)
      .px(6)
      .gap(6)
      .items_center()
      .flex_none()
      .text_size(10)
      .cursor_pointer()
      .rounded(3)
      .hover((el) => el.bg(t.hover))
      .accessibility_label(`${title}, ${count}, ${collapsed ? "collapsed" : "expanded"}`)
      .on_click((_e, cx) => {
        if (collapsed) this.collapsed.delete(title);
        else this.collapsed.add(title);
        try {
          localStorage.setItem("collapsed", JSON.stringify([...this.collapsed]));
        } catch {
          /* Memory still has it. */
        }
        cx.notify();
      })
      .child(
        svg(collapsed ? CHEVRON_RIGHT : CHEVRON_DOWN)
          .size(12)
          .flex_none()
          .text_color(t.muted),
      )
      .child(div().text_color(color).child(title.toUpperCase()))
      .child(div().text_color(t.muted).child(String(count)));
  }

  itemRow(item: InboxItem, t: Theme) {
    const agentKind = item.kind !== "open",
      selected = this.selected.has(item.id),
      starting = this.starting.has(item.id);
    const expanded = this.expanded.has(item.id);
    const toggleSelected = (cx) => {
      if (selected) this.selected.delete(item.id);
      else this.selected.add(item.id);
      this.confirming = false;
      cx.notify();
    };
    const toggleExpanded = (cx) => {
      if (expanded) this.expanded.delete(item.id);
      else this.expanded.add(item.id);
      cx.notify();
    };
    const { pr } = item;
    const header = h_flex()
      .id(`item-${item.id}`)
      .pl(6)
      .pr(6)
      .py(6)
      .gap(6)
      .items_start()
      .flex_none()
      .cursor_pointer()
      .hover((el) => el.bg(t.hover))
      .on_click((_e, cx) => toggleExpanded(cx))
      .role("list_item")
      .accessibility_label(
        `#${item.pr.number} ${item.pr.title}, ${item.detail}, ${expanded ? "expanded" : "collapsed"}`,
      )
      .child(
        h_flex()
          .h(18)
          .gap(6)
          .items_center()
          .flex_none()
          .child(
            svg(expanded ? CHEVRON_DOWN : CHEVRON_RIGHT)
              .size(12)
              .flex_none()
              .text_color(t.muted),
          )
          .child(
            div()
              .id(`select-${item.id}`)
              .size(12)
              .flex_none()
              .rounded(2)
              .border_1()
              .border_color(agentKind ? (selected ? t.accent : t.input) : "#00000000")
              .when(selected, (el) => el.bg(t.accent))
              .when(agentKind && !starting, (el) =>
                el.tooltip(selected ? "Deselect" : "Select for a batch").on_click((_e, cx) => {
                  cx.stop_propagation();
                  toggleSelected(cx);
                }),
              ),
          ),
      )
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(4)
          .child(
            h_flex()
              .h(18)
              .gap(6)
              .items_center()
              .min_w(0)
              .child(
                div()
                  .id(`link-${item.id}`)
                  .flex_none()
                  .text_color(t.accent)
                  .cursor_pointer()
                  .tooltip("Open on GitHub")
                  .on_click((_e, cx) => {
                    cx.stop_propagation();
                    this.openInBrowser(pr.url);
                  })
                  .child(`#${pr.number}`),
              )
              .child(div().flex_1().min_w(0).truncate().font_semibold().child(pr.title)),
          )
          .child(
            div()
              .truncate()
              .text_size(10)
              .text_color(t.muted)
              .child(
                [pr.author, pr.branch, pr.updatedAt && `${ago(pr.updatedAt)} ago`]
                  .filter(Boolean)
                  .join(" · "),
              ),
          )
          .child(h_flex().gap(4).flex_wrap().children(this.chips(pr, t))),
      )
      .child(
        item.kind === "open"
          ? this.iconButton(`act-${item.id}`, ICONS.open, () => this.openInBrowser(item.pr.url), {
              tooltip: "Open on GitHub to merge",
            })
          : this.iconButton(`act-${item.id}`, ICONS[item.kind], (cx) => this.start([item], cx), {
              disabled: starting || !this.agent(),
              spinning: starting,
              tooltip: starting
                ? "Starting agent…"
                : `${ACTIONS[item.kind]} with ${this.agent()?.name ?? "an agent"}`,
            }),
      );
    return v_flex()
      .mx(6)
      .flex_none()
      .rounded(3)
      .border_1()
      .overflow_hidden()
      .border_color(selected ? t.accent : t.border)
      .bg(selected ? t.selected : "#00000000")
      .child(header)
      .when(expanded, (el) => el.child(this.details(item, t)));
  }

  // The pull request's state at a glance: checks, review, conversations, size, draft and conflicts.
  chips(pr: PullRequest, t: Theme) {
    const chip = (label: string, color: Color, icon?: Element) =>
      h_flex()
        .h(18)
        .px(6)
        .gap(4)
        .items_center()
        .flex_none()
        .rounded(3)
        .border_1()
        .border_color(t.border)
        .text_size(10)
        .text_color(color)
        .when(Boolean(icon), (el) => el.child(icon))
        .child(label);
    const dot = (color) => div().size(6).rounded(3).bg(color);
    const { checks } = pr,
      chips = [];
    if (pr.draft) chips.push(chip("Draft", t.muted));
    if (checks.failed.length)
      chips.push(
        chip(`${checks.failed.length} of ${checks.total} checks failed`, t.blocked, dot(t.blocked)),
      );
    else if (checks.pending)
      chips.push(chip(`${checks.pending} checks running`, t.muted, dot(t.muted)));
    else if (checks.state === "SUCCESS")
      chips.push(chip("Checks passed", t.working, dot(t.working)));
    const review = (
      {
        APPROVED: ["Approved", t.working],
        CHANGES_REQUESTED: ["Changes requested", t.blocked],
        REVIEW_REQUIRED: ["Needs review", t.muted],
      } satisfies Record<string, [string, Color]>
    )[pr.decision];
    if (review) chips.push(chip(review[0], review[1]));
    if (pr.threads.length)
      chips.push(chip(String(pr.threads.length), t.foreground, svg(ICONS.address).size(10)));
    if (pr.conflicts) chips.push(chip("Conflicts", t.blocked));
    chips.push(
      h_flex()
        .h(18)
        .px(6)
        .gap(4)
        .items_center()
        .flex_none()
        .rounded(3)
        .border_1()
        .border_color(t.border)
        .text_size(10)
        .child(div().text_color(t.ansi2).child(`+${pr.additions}`))
        .child(div().text_color(t.ansi1).child(`−${pr.deletions}`)),
    );
    return chips;
  }

  // Failed checks for a CI item; the open conversations for every other item.
  details(item: InboxItem, t: Theme) {
    const { pr } = item;
    const link = (id, url, content) =>
      v_flex()
        .id(id)
        .px(6)
        .py(4)
        .gap(2)
        .rounded(3)
        .flex_none()
        .when(Boolean(url), (el) =>
          el
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .tooltip("Open on GitHub")
            .on_click((_e, cx) => {
              cx.stop_propagation();
              this.openInBrowser(url);
            }),
        )
        .children(content);
    const rows =
      item.kind === "fix-ci"
        ? pr.checks.failed.map((check, i) =>
            link(`check-${item.id}-${i}`, check.url, [
              h_flex()
                .gap(6)
                .items_center()
                .child(div().size(6).flex_none().rounded(3).bg(t.blocked))
                .child(div().flex_1().min_w(0).truncate().child(check.name)),
            ]),
          )
        : pr.threads.map((thread, i) =>
            link(`thread-${item.id}-${i}`, thread.url, [
              h_flex()
                .gap(6)
                .min_w(0)
                .text_size(10)
                .text_color(t.muted)
                .child(
                  div()
                    .flex_1()
                    .min_w(0)
                    .truncate()
                    .child(`${thread.path}${thread.line ? `:${thread.line}` : ""}`),
                )
                .child(
                  div()
                    .flex_none()
                    .child(
                      `${thread.author}${thread.replies ? ` · ${thread.replies} ${thread.replies > 1 ? "replies" : "reply"}` : ""}`,
                    ),
                ),
              div()
                .text_size(11)
                .whitespace_normal()
                .child(squash(thread.body).slice(0, 240) || "(no text)"),
            ]),
          );
    const empty = item.kind === "fix-ci" ? "No failed checks." : "No open conversations.";
    return v_flex()
      .pl(30)
      .pr(10)
      .pt(4)
      .pb(6)
      .gap(2)
      .border_t(1)
      .border_color(t.border)
      .children(
        rows.length ? rows : [div().px(6).py(4).text_size(11).text_color(t.muted).child(empty)],
      );
  }

  agentRow(linked, t) {
    const pr = this.data.prs.find((p) => p.number === linked.number);
    return h_flex()
      .id(`agent-${linked.address}`)
      .h(40)
      .px(10)
      .gap(8)
      .items_center()
      .flex_none()
      .cursor_pointer()
      .hover((el) => el.bg(t.hover))
      .tooltip("Show agent")
      .on_click(() => run("agent.focus", { terminal: linked.address }))
      .child(
        div()
          .size(8)
          .mx(2)
          .flex_none()
          .rounded(4)
          .bg(t[linked.status] ?? t.unknown),
      )
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .child(
            div()
              .truncate()
              .child(
                `#${linked.number} ${linked.kinds.map((kind) => ACTIONS[kind] ?? kind).join(" + ")}${pr ? ` · ${pr.title}` : ""}`,
              ),
          )
          .child(
            div()
              .truncate()
              .text_size(10)
              .text_color(t.muted)
              .child(`${linked.name} · ${linked.status ?? "running"} · ${linked.address}`),
          ),
      );
  }

  // The inbox's groups, without the items an agent already works on.
  inbox(data: PullRequests) {
    const busy = new Set(
      this.linkedAgents(data).flatMap((a) => a.kinds.map((kind) => `${a.number}:${kind}`)),
    );
    if (
      this.inboxSource !== data ||
      this.inboxBusy.size !== busy.size ||
      [...busy].some((id) => !this.inboxBusy.has(id))
    ) {
      this.groups = buildInbox(data, busy);
      this.inboxSource = data;
      this.inboxBusy = busy;
    }
    return this.groups;
  }

  // A pane opened on a folder of its own leaves the count to the panel.
  publishInboxCount() {
    if (props()?.cwd) return;
    const data = this.cache.get(this.repos.get(contextKey(location())));
    const count = data
      ? this.inbox(data)
          .filter((group) => group.key !== "ready")
          .reduce((total, group) => total + group.items.length, 0)
      : 0;
    if (shared(INBOX_COUNT) !== count) setShared(INBOX_COUNT, count);
  }

  body(t) {
    const data = this.data;
    if (!data) {
      const message =
        this.error ??
        (this.loading()
          ? "Loading pull requests…"
          : this.place?.cwd
            ? "Use Refresh to load pull requests."
            : "Open a terminal in a GitHub repository.");
      return div()
        .p(10)
        .text_color(this.error ? t.foreground : t.muted)
        .child(message);
    }
    const linked = this.linkedAgents();
    this.inbox(data);
    const colors = { ci: t.blocked, comments: t.accent, review: t.accent, ready: t.idle };
    const [ci, comments, review, ready] = this.groups;
    const section = (title, color, count, renderRows) =>
      count
        ? [
            v_flex()
              .gap(6)
              .child(this.groupHeader(title, count, color, t))
              .when(!this.collapsed.has(title), (el) => el.children(renderRows())),
          ]
        : [];
    const group = (g) =>
      section(g.title, colors[g.key], g.items.length, () =>
        g.items.map((item) => this.itemRow(item, t)),
      );
    const sections = [
      ...group(ci),
      ...group(comments),
      ...group(review),
      ...section("Agents on it", t.working, linked.length, () =>
        linked.map((a) => this.agentRow(a, t)),
      ),
      ...group(ready),
    ];
    return v_flex()
      .id("github-inbox")
      .flex_1()
      .min_h(0)
      .overflow_y_scrollbar()
      .py(6)
      .gap(18)
      .when(Boolean(this.error), (el) => el.child(div().px(10).py(6).child(this.error)))
      .children(
        sections.length ? sections : [div().p(10).text_color(t.muted).child("Nothing needs you.")],
      );
  }

  footer(t) {
    const items = this.groups
      .flatMap((group) => group.items)
      .filter((item) => this.selected.has(item.id));
    const label = !items.length
      ? ""
      : this.confirming
        ? `Start ${items.length} agents? Click again`
        : `Start ${items.length} agent${items.length > 1 ? "s" : ""}`;
    return h_flex()
      .h(32)
      .px(6)
      .gap(6)
      .items_center()
      .flex_none()
      .border_t(1)
      .border_color(t.border)
      .child(
        div()
          .flex_1()
          .truncate()
          .text_size(10)
          .text_color(t.muted)
          .child(this.data ? `${this.data.prs.length} open pull requests` : ""),
      )
      .when(items.length > 0, (el) =>
        el
          .child(
            this.button("github-clear", "Clear", (cx) => {
              this.selected = new Set();
              this.confirming = false;
              cx.notify();
            }),
          )
          .child(
            this.button(
              "github-start",
              label,
              (cx) => {
                if (items.length > BATCH_CONFIRM && !this.confirming) {
                  this.confirming = true;
                  cx.notify();
                  return;
                }
                this.start(items, cx);
              },
              { primary: true, disabled: !this.agent() },
            ),
          ),
      );
  }

  render(cx: Context) {
    this.publishInboxCount();
    if (!this.visible()) return div();
    if (this.pendingInitialRefresh) this.refreshAll(cx);
    else if (contextKey(location()) !== this.context) this.refresh(cx, false);
    const t = theme() as Theme,
      agent = this.agent();
    return v_flex()
      .id("github")
      .size_full()
      .min_h(0)
      .rounded(3)
      .overflow_hidden()
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(12)
      .child(
        h_flex()
          .h(30)
          .px(10)
          .gap(6)
          .items_center()
          .flex_none()
          .border_b(1)
          .border_color(t.border)
          .child(div().child("GitHub"))
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_size(10)
              .text_color(t.muted)
              .child(this.data?.repo ?? ""),
          )
          .child(
            agent?.icon
              ? this.iconButton(
                  "github-agent",
                  agent.tint ? svg(agent.icon).size(14) : image(agent.icon).size(14),
                  (cx) => this.cycleAgent(cx),
                  {
                    disabled: this.agentOptions.length < 2,
                    tooltip: `Starts ${agent.name}. Click to switch.`,
                  },
                )
              : this.button(
                  "github-agent",
                  agent ? agent.name : "No agent",
                  (cx) => this.cycleAgent(cx),
                  {
                    disabled: this.agentOptions.length < 2,
                    tooltip: "Agent to start. Click to switch.",
                  },
                ),
          )
          .child(
            this.iconButton(
              "github-refresh",
              this.loading() ? svg(REFRESH).size(14).spin(900) : REFRESH,
              (cx) => this.refresh(cx),
              {
                disabled: this.loading(),
                tooltip: this.loading() ? "Updating pull requests…" : "Refresh pull requests",
              },
            ),
          ),
      )
      .child(this.body(t))
      .child(this.footer(t));
  }
}
