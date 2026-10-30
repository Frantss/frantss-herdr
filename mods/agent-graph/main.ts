// Agents as a graph: each agent a card, a line from every agent to the sub-agents it started.
// A tree when it fits the width, else an indented outline of the same cards.
// Styled as a frantss side panel, beside Files and Changes.

import {
  View,
  div,
  image,
  svg,
  PathBuilder,
  type Context,
  type AsyncContext,
  type Color,
} from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, panes, focused, run, hc, settings, shared, theme } from "herdr";
import { panelShown } from "./panel.ts";

type AgentStatus = "working" | "blocked" | "idle" | "done" | "finished" | "error";
interface TerminalRecord {
  address: string;
  state: string;
  parent?: string;
  labels?: Record<string, string>;
  status?: AgentStatus | { state?: AgentStatus };
  created_ms?: number;
  finished_ms?: number;
  status_ms?: number;
  exit_code?: number;
  reason?: string;
  name?: string;
  template?: string;
  title?: string;
  cwd?: string;
  program?: { name?: string; icon?: string; tint?: boolean };
}
interface AgentNode {
  k: TerminalRecord;
  status: AgentStatus | null;
  allKids: TerminalRecord[];
  kids: AgentNode[];
  width?: number;
  kidsWidth?: number;
  x?: number;
  y?: number;
  w?: number;
}
type Statuses = Map<string, AgentStatus>;
type Theme = Record<string, Color>;

const CARD_W = 196;
const CARD_H = 52;
const GAP_X = 16;
const GAP_Y = 40;
const TREE_GAP = 32;
const PAD = 16;
const INDENT = 28;
const OUTLINE_GAP = 4;
const OUTLINE_TREE_GAP = 12;
const OUTLINE_MIN_W = 160;
// Narrower than this, the graph is always an outline, so every filter draws the same cards.
const OUTLINE_BELOW = 720;
// Where an outline's lines leave a parent, from its left edge.
const TRUNK = 14;
// How long a finished sub-agent stays on the graph after it ends.
const FINISHED_FOR_MS = 10 * 60000;
// Lines share trunks, so they are drawn least urgent first: the most urgent color stays on top.
const EDGE_ORDER: Partial<Record<AgentStatus, number>> = {
  finished: 0,
  idle: 1,
  done: 1,
  working: 2,
  blocked: 3,
};
const SCOPES = [
  { id: "workspace", label: "Workspace", tooltip: "Agents in this space's workspace" },
  { id: "space", label: "Space", tooltip: "Agents in this space" },
  { id: "tab", label: "Tab", tooltip: "Agents in this tab" },
  { id: "all", label: "All", tooltip: "Agents in every space" },
];

// Each space's workspace, published by the frantss rail. Without it, a space is its own workspace.
const SPACE_WORKSPACES = "frantss.spaceWorkspaces";

const machineOf = (address: string) => (address.includes("/") ? `${address.split("/")[0]}/` : "");
// Labels hold ids local to their machine; the app prefixes remote ones.
const labelOf = (k: TerminalRecord, key: string) =>
  k.labels?.[key] ? machineOf(k.address) + k.labels[key] : null;
const spaceOf = (k: TerminalRecord) => labelOf(k, "herdr.space");
const tabOf = (k: TerminalRecord) => labelOf(k, "herdr.tab");

// Whether a terminal belongs to a scope, seen from the focused place.
function scopeTest(scope: string, here: ReturnType<typeof focused>) {
  const workspaces = (shared(SPACE_WORKSPACES) ?? {}) as Record<string, string>;
  const workspaceOf = (id: string | null) => workspaces[id] ?? id;
  return (
    {
      workspace: (k: TerminalRecord) => workspaceOf(spaceOf(k)) === workspaceOf(here?.space),
      space: (k: TerminalRecord) => spaceOf(k) === here?.space,
      tab: (k: TerminalRecord) => tabOf(k) === here?.tab,
      all: () => true,
    }[scope] ?? (() => true)
  );
}

// Error counts as blocked. A sub-agent is never done: it reports to its parent.
function statusOf(k: TerminalRecord, listed: Statuses): AgentStatus | null {
  if (k.state !== "live") return "finished";
  const s = listed.get(k.address) ?? (typeof k.status === "object" ? k.status?.state : k.status);
  if (s === "error") return "blocked";
  if (s === "done" && k.parent) return "idle";
  return s ?? null;
}

function duration(ms: number) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

function icon(p: TerminalRecord["program"], size: number, color: Color) {
  if (!p?.icon) return null;
  return p.tint
    ? svg(p.icon).size(size).flex_none().text_color(color)
    : image(p.icon).w(size).h(size).flex_none();
}

// Each subtree gets the width of its children side by side; a parent sits centered above them.
function measure(node: AgentNode) {
  node.kids.forEach(measure);
  const kidsWidth =
    node.kids.reduce((w, k) => w + k.width, 0) + GAP_X * Math.max(0, node.kids.length - 1);
  node.kidsWidth = kidsWidth;
  node.width = Math.max(CARD_W, kidsWidth);
}

function place(node: AgentNode, left: number, depth: number) {
  node.x = left + (node.width - CARD_W) / 2;
  node.y = PAD + depth * (CARD_H + GAP_Y);
  node.w = CARD_W;
  let x = left + (node.width - node.kidsWidth) / 2;
  for (const kid of node.kids) {
    place(kid, x, depth + 1);
    x += kid.width + GAP_X;
  }
}

// Depth first, one card per row, each level indented; cards reach the right edge. Returns the next free y.
function placeOutline(node: AgentNode, depth: number, y: number, width: number): number {
  node.x = PAD + depth * INDENT;
  node.y = y;
  node.w = Math.max(OUTLINE_MIN_W, width - PAD - node.x);
  let next = y + CARD_H + OUTLINE_GAP;
  for (const kid of node.kids) next = placeOutline(kid, depth + 1, next, width);
  return next;
}

function flatten(root: AgentNode): AgentNode[] {
  const nodes: AgentNode[] = [];
  const pending = [root];
  while (pending.length) {
    const node = pending.pop();
    nodes.push(node);
    for (let index = node.kids.length - 1; index >= 0; index--) pending.push(node.kids[index]);
  }
  return nodes;
}

// The live agents in each scope, sub-agents included.
export function scopeCounts(
  live: TerminalRecord[],
  listed: Statuses,
  here: ReturnType<typeof focused>,
): Record<string, number> {
  const agentTerminals = live.filter((k) => k.state === "live" && listed.has(k.address));
  return Object.fromEntries(
    SCOPES.map((s) => [s.id, agentTerminals.filter(scopeTest(s.id, here)).length]),
  );
}

export default class AgentGraph extends View {
  declare folded: Set<string>;
  declare scope: string;
  declare size: { width: number; height: number };
  declare ended: Map<string, TerminalRecord>;
  declare expired: Set<string>;
  declare liveKey: string | null;
  declare syncing: boolean;
  declare stale: boolean;
  declare outline: boolean;
  declare ages: string;

  init(_props: unknown, cx: AsyncContext) {
    this.folded = new Set();
    this.scope = localStorage.getItem("scope") ?? "space";
    this.size = { width: 0, height: 0 };
    this.ended = new Map();
    this.expired = new Set();
    this.liveKey = null;
    this.syncing = false;
    this.syncFinished(cx);
    // terminals() lists live terminals only. hc runs when that list changes, and every 30 s
    // for finished ones removed with hc rm; the 30 s tick also redraws when a duration ages.
    cx.timer.every(2000, (cx) => this.syncFinished(cx));
    cx.timer.every(30000, (cx) => {
      if (!panelShown("agent-graph")) return;
      this.liveKey = null;
      this.syncFinished(cx);
      const ages = this.agesKey();
      if (ages === this.ages) return;
      this.ages = ages;
      cx.notify();
    });
  }

  // What time alone changes on the graph: the durations and the finished sub-agents kept.
  agesKey() {
    const now = Date.now();
    return [
      ...terminals().map((k: TerminalRecord) => (k.status_ms ? duration(now - k.status_ms) : "")),
      ...this.ended.keys(),
    ].join(" ");
  }

  syncFinished(cx: Context) {
    const now = Date.now();
    for (const [address, record] of this.ended) {
      if (now - (record.finished_ms ?? 0) < FINISHED_FOR_MS) continue;
      this.ended.delete(address);
      this.expired.add(address);
    }
    if (!panelShown("agent-graph")) {
      this.stale = true;
      return;
    }
    const key = terminals()
      .map((k) => k.address)
      .join(" ");
    if (this.syncing || key === this.liveKey) return;
    this.liveKey = key;
    this.syncing = true;
    cx.spawn(async (cx) => {
      let failed = false,
        changed = false;
      try {
        const result = await hc(["ls", "--all", "--json"]);
        if (result.code !== 0) {
          failed = true;
          return;
        }
        // hc ls gives short records without times; a finished sub-agent's full record never
        // changes, so hc get fetches it once.
        const ended = (JSON.parse(result.stdout).terminals as TerminalRecord[]).filter(
          (k) => k.state !== "live" && k.parent,
        );
        const missing = ended.filter(
          (k) => !this.ended.has(k.address) && !this.expired.has(k.address),
        );
        let next = 0;
        await Promise.all(
          Array.from({ length: Math.min(4, missing.length) }, async () => {
            for (;;) {
              const k = missing[next++];
              if (!k) return;
              try {
                const full = await hc(["get", k.address, "--json"]);
                if (full.code === 0) {
                  const record = JSON.parse(full.stdout) as TerminalRecord;
                  if (Date.now() - (record.finished_ms ?? 0) < FINISHED_FOR_MS) {
                    this.ended.set(k.address, record);
                    changed = true;
                  } else this.expired.add(k.address);
                } else failed = true;
              } catch {
                failed = true;
              }
            }
          }),
        );
        const listed = new Set(ended.map((k) => k.address));
        for (const address of this.ended.keys())
          if (!listed.has(address)) {
            this.ended.delete(address);
            changed = true;
          }
        for (const address of this.expired) if (!listed.has(address)) this.expired.delete(address);
        if (changed) cx.notify();
      } catch {
        failed = true;
      } finally {
        if (failed) this.liveKey = null;
        this.syncing = false;
      }
    });
  }

  setScope(scope: string) {
    this.scope = scope;
    localStorage.setItem("scope", scope);
  }

  // Live agents, and live terminals that started a sub-agent, are roots. Sub-agents stay
  // under their parent for a while after they finish, in the order they started.
  forest(all: TerminalRecord[], listed: Statuses, here: ReturnType<typeof focused>): AgentNode[] {
    const byAddress = new Map(all.map((k) => [k.address, k]));
    const inScope = scopeTest(this.scope, here);
    const children = new Map<string | undefined, TerminalRecord[]>();
    for (const k of all) {
      const parent = k.parent,
        siblings = children.get(parent);
      if (siblings) siblings.push(k);
      else children.set(parent, [k]);
    }
    for (const siblings of children.values()) siblings.sort((a, b) => a.created_ms - b.created_ms);
    const kidsOf = (address: string) => children.get(address) ?? [];
    const build = (k: TerminalRecord): AgentNode => {
      const allKids = kidsOf(k.address);
      return {
        k,
        status: statusOf(k, listed),
        allKids,
        kids: this.folded.has(k.address) ? [] : allKids.map(build),
      };
    };
    return all
      .filter((k) => k.state === "live" && !byAddress.has(k.parent ?? ""))
      .filter((k) => statusOf(k, listed) || kidsOf(k.address).length)
      .filter(inScope)
      .map(build);
  }

  open(k: TerminalRecord) {
    const pane = panes().find((p) => p.terminal === k.address);
    if (pane) run("pane.focus", { pane: pane.pane });
    else run("terminal.peek", { terminal: k.address });
  }

  status(t: Theme, s: AgentStatus | null) {
    if (s === "working")
      return svg("mods/workspace-chrome/spinner.svg")
        .size(12)
        .mx(1)
        .flex_none()
        .text_color(t.working)
        .spin(900);
    if (s === "blocked")
      return div()
        .flex_none()
        .px(5)
        .h(16)
        .rounded(3)
        .bg((t.blocked + "26") as Color)
        .text_size(10)
        .text_color(t.blocked)
        .flex()
        .items_center()
        .child("Needs you");
    if (s === "idle")
      return div()
        .size(7)
        .mx(3)
        .flex_none()
        .rounded(4)
        .border(1.5)
        .border_color(t.idle ?? t.dim);
    if (s === "done") return div().size(7).mx(3).flex_none().rounded(4).bg(t.done);
    return null;
  }

  // What a card says at its bottom right: how long it has had its status, or how it ended.
  detail(t: Theme, k: TerminalRecord, now: number) {
    if (k.state === "live")
      return div()
        .text_color(t.dim)
        .child(k.status_ms ? duration(now - k.status_ms) : "");
    if (k.exit_code == null)
      return div()
        .text_color(t.dim)
        .child(k.reason ?? "ended");
    return div()
      .text_color(k.exit_code === 0 ? t.dim : t.blocked)
      .child(`exit ${k.exit_code}`);
  }

  card(t: Theme, node: AgentNode, shown: string | null, now: number) {
    const { k, status } = node;
    const name = k.name || k.template || k.program?.name || k.address;
    const on = k.address === shown;
    const pic = icon(k.program, 14, t.foreground);
    return v_flex()
      .id(`card-${k.address}`)
      .absolute()
      .left(node.x)
      .top(node.y)
      .w(node.w)
      .h(CARD_H)
      .px(10)
      .gap(2)
      .justify_center()
      .rounded(3)
      .border_1()
      .border_color(status === "blocked" ? t.blocked : t.border)
      .when(status === "blocked", (el) => el.bg((t.blocked + "14") as Color))
      .when(on, (el) => el.bg(t.selected))
      .when(status === "finished", (el) => el.opacity(0.6))
      .cursor_pointer()
      .text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(`${k.address} · ${k.cwd ?? ""}`)
      .on_click(() => this.open(k))
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .when(Boolean(pic), (el) => el.child(pic))
          .child(div().flex_1().min_w(0).truncate().child(name))
          .child(this.status(t, status) ?? div()),
      )
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .text_size(11)
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_color(t.dim)
              .child(k.title || k.address),
          )
          .child(this.detail(t, k, now)),
      );
  }

  // Where lines leave a parent and reach a child: centered in a tree, at the left in an outline.
  exit(node: AgentNode) {
    return { x: node.x + (this.outline ? TRUNK : node.w / 2), y: node.y + CARD_H };
  }

  entry(node: AgentNode) {
    return this.outline
      ? { x: node.x, y: node.y + CARD_H / 2 }
      : { x: node.x + node.w / 2, y: node.y };
  }

  // The fold button where a parent's lines leave; folded, it counts the sub-agents it hides.
  foldButton(t: Theme, node: AgentNode) {
    const open = !this.folded.has(node.k.address);
    return h_flex()
      .id(`fold-${node.k.address}`)
      .absolute()
      .left(this.exit(node).x - 14)
      .top(node.y + CARD_H - 7)
      .w(28)
      .h(14)
      .gap(2)
      .items_center()
      .justify_center()
      .rounded(3)
      .bg(t.chrome)
      .border_1()
      .border_color(t.border)
      .text_size(10)
      .text_color(t.muted)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(open ? "Fold sub-agents" : "Show sub-agents")
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (open) this.folded.add(node.k.address);
        else this.folded.delete(node.k.address);
        cx.notify();
      })
      .child(
        svg(`mods/frantss-files/chevron-${open ? "down" : "right"}.svg`)
          .size(10)
          .flex_none(),
      )
      .when(!open, (el) => el.child(String(node.allKids.length)));
  }

  // Percentages follow zoom; one path per style keeps shared trunks in urgency order.
  edgeLayers(t: Theme, nodes: AgentNode[], width: number, height: number) {
    const px = (x: number): `${number}%` => `${(x / width) * 100}%`;
    const py = (y: number): `${number}%` => `${(y / height) * 100}%`;
    const paths = new Map<number, ReturnType<typeof PathBuilder.stroke>>();
    for (const parent of nodes)
      for (const kid of parent.kids) {
        const order = EDGE_ORDER[kid.status] ?? 1;
        let path = paths.get(order);
        if (!path) {
          path = PathBuilder.stroke(order === 3 ? 2 : 1.5);
          if (order === 0) path = path.dash_array([4, 4]);
        }
        const from = this.exit(parent),
          to = this.entry(kid),
          mid = (from.y + to.y) / 2;
        path = path.move_to(px(from.x), py(from.y));
        if (this.outline) path = path.line_to(px(from.x), py(to.y));
        else path = path.line_to(px(from.x), py(mid)).line_to(px(to.x), py(mid));
        paths.set(order, path.line_to(px(to.x), py(to.y)));
      }
    const colors = [t.border, t.input, t.working, t.blocked];
    return [...paths]
      .sort(([a], [b]) => a - b)
      .map(([order, path]) =>
        div()
          .absolute()
          .left(0)
          .top(0)
          .w(width)
          .h(height)
          .when(order === 2, (el) => el.loop("opacity", { from: 0.35, to: 1, period: 1400 }))
          .child(window.paint_path(path.build(), colors[order]).size_full()),
      );
  }

  header(t: Theme, roots: AgentNode[], counts: Record<string, number>) {
    const nodes = roots.flatMap(flatten);
    const working = nodes.filter((n) => n.status === "working").length;
    const blocked = nodes.filter((n) => n.status === "blocked").length;
    return h_flex()
      .h(28)
      .flex_none()
      .px(10)
      .gap(8)
      .items_center()
      .text_size(11)
      .border_b(1)
      .border_color(t.border)
      .child(div().child("Agents"))
      .when(blocked > 0, (el) =>
        el.child(div().text_size(10).text_color(t.blocked).child(`${blocked} need you`)),
      )
      .when(working > 0, (el) =>
        el.child(div().text_size(10).text_color(t.working).child(`${working} working`)),
      )
      .child(div().flex_1())
      .children(
        SCOPES.map((s) =>
          div()
            .id(`scope-${s.id}`)
            .h(20)
            .px(6)
            .flex()
            .gap(4)
            .items_center()
            .rounded(3)
            .text_color(this.scope === s.id ? t.foreground : t.muted)
            .when(this.scope === s.id, (el) => el.bg(t.selected))
            .cursor_pointer()
            .hover((el) => el.text_color(t.foreground))
            .tooltip(s.tooltip)
            .on_click((_e, cx) => {
              this.setScope(s.id);
              cx.notify();
            })
            .child(s.label)
            .when(counts[s.id] > 0, (el) =>
              el.child(div().text_size(10).text_color(t.dim).child(String(counts[s.id]))),
            ),
        ),
      );
  }

  render(cx: Context) {
    if (!panelShown("agent-graph")) return div();
    if (this.stale) {
      this.stale = false;
      this.liveKey = null;
      this.syncFinished(cx);
    }
    const t = theme() as Theme;
    const listed = new Map(agents().map((a) => [a.address, a.status]));
    const live: TerminalRecord[] = terminals();
    const liveAddresses = new Set(live.map((k) => k.address));
    const now = Date.now();
    const recent = [...this.ended.values()].filter(
      (k) => !liveAddresses.has(k.address) && now - (k.finished_ms ?? 0) < FINISHED_FOR_MS,
    );
    const all = [...live, ...recent];
    const here = focused(),
      roots = this.forest(all, listed, here),
      counts = scopeCounts(live, listed, here);
    this.outline = this.size.width < OUTLINE_BELOW;
    let total = 0;
    if (!this.outline) {
      roots.forEach(measure);
      total = roots.reduce((w, r) => w + r.width, 0) + TREE_GAP * Math.max(0, roots.length - 1);
      this.outline = total + 2 * PAD > this.size.width;
    }
    if (this.outline) {
      let y = PAD;
      for (const root of roots)
        y = placeOutline(root, 0, y, this.size.width) + OUTLINE_TREE_GAP - OUTLINE_GAP;
    } else {
      let x = (this.size.width - total) / 2;
      for (const root of roots) {
        place(root, x, 0);
        x += root.width + TREE_GAP;
      }
    }
    const nodes = roots.flatMap(flatten);
    const width = nodes.reduce((w, n) => Math.max(w, n.x + n.w + PAD), this.size.width);
    const height = nodes.reduce((h, n) => Math.max(h, n.y + CARD_H + PAD), 0);
    const shownTerminal = focused()?.terminal;

    const canvas = div()
      .relative()
      .w(width)
      .h(height)
      .children(this.edgeLayers(t, nodes, width, height))
      .children(nodes.map((n) => this.card(t, n, shownTerminal, now)))
      .children(nodes.filter((n) => n.allKids.length).map((n) => this.foldButton(t, n)));

    return (
      v_flex()
        .id("agent-graph")
        .size_full()
        .min_h(0)
        .rounded(3)
        .overflow_hidden()
        .border_1()
        .border_color(t.border)
        .text_color(t.foreground)
        .text_size(12)
        // The size comes zoomed, and the lengths this mod sets are zoomed again when drawn.
        .on_size_change((size, cx) => {
          const zoom = (settings().zoom as number | undefined) ?? 1;
          this.size = { width: size.width / zoom, height: size.height / zoom };
          cx.notify();
        })
        .child(this.header(t, roots, counts))
        .when(roots.length === 0, (el) =>
          el.child(
            div()
              .p(8)
              .text_color(t.dim)
              .child(
                "No agents here. Sub-agents started with hc run appear under the agent that started them.",
              ),
          ),
        )
        .child(div().id("graph").flex_1().min_h(0).overflow_scrollbar().child(canvas))
    );
  }
}
