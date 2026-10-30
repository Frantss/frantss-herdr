import type { AsyncContext, Context, FocusHandle, Color, Element } from "gpui-kit";
import type {
  Commit,
  CommitDetails,
  CommitDiff,
  GitExecutor,
  HistoryScope,
  HistorySnapshot,
} from "./git.ts";
import type { GraphLayout, GraphSegment } from "./graph.ts";

import { View, div, PathBuilder } from "gpui-kit";
import {
  v_flex,
  h_flex,
  Button,
  Scrollbar,
  v_virtual_list,
  VirtualListScrollHandle,
  Accordion,
  AccordionItem,
  AccordionHeader as NativeAccordionHeader,
  AccordionTrigger,
  AccordionPanel,
} from "gpui-base";
import { spaces, panes, focused, props, exec, theme, settings, layout } from "herdr";
import { loadHistory, loadDetails, loadDiff, PAGE_SIZE } from "./git.ts";
import { layoutGraph } from "./graph.ts";

interface LayoutNode {
  id?: string;
  children?: LayoutNode[];
  hidden?: boolean;
  active?: string;
}
interface Location {
  cwd: string | null;
  on: string | null;
}
type Theme = Record<string, Color>;

const AccordionHeader = NativeAccordionHeader as unknown as { new: (trigger: Element) => Element };

const CACHED_LIST = [
  "commits",
  "graph",
  "edges",
  "limit",
  "snapshot",
  "signature",
  "hasMore",
  "root",
  "branch",
  "head",
  "changed",
] as const;
type CachedList = Pick<GitHistory, (typeof CACHED_LIST)[number]>;
const listKey = (context: string, scope: HistoryScope) => JSON.stringify([context, scope]);
const KEPT_PLACES = 20;

const MAX_COMMITS = 2000;
const ROW_HEIGHT = 42;
const LANE_WIDTH = 14;

function find(node: LayoutNode | null, id: string): LayoutNode | null {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

function location(): Location {
  const explicit = props();
  if (explicit?.cwd) return { cwd: explicit.cwd, on: explicit.on ?? null };
  const space = spaces().find((s) => s.active),
    focus = focused();
  const pane = focus?.pane ? panes().find((p) => p.pane === focus.pane) : null;
  const on =
    focus?.pane === null && focus.terminal
      ? focus.terminal.includes("/")
        ? focus.terminal.split("/")[0]
        : null
      : (space?.machine ?? null);
  return { cwd: pane?.cwd || focus?.cwd || space?.folder || null, on };
}

const contextKey = (place) => JSON.stringify(place);
const shortDate = (seconds) => new Date(seconds * 1000).toISOString().slice(0, 10);
const errorText = (error: unknown) => {
  const message = (error as { message?: unknown })?.message ?? error;
  // oxlint-disable-next-line typescript/no-base-to-string -- Host rejections may contain arbitrary values.
  return String(message).slice(0, 500);
};

// Clip edges once per load so scrolling only builds the visible row geometry.
function rowSegments(graph: GraphLayout, count: number): GraphSegment[][] {
  const rows: GraphSegment[][] = Array.from({ length: count }, () => []);
  for (const edge of graph.segments) {
    for (
      let row = Math.max(0, Math.ceil(edge.y1 - 0.5));
      row < Math.min(count, Math.ceil(edge.y2 + 0.5));
      row++
    ) {
      const y1 = Math.max(edge.y1, row - 0.5),
        y2 = Math.min(edge.y2, row + 0.5);
      if (y2 <= y1) continue;
      const x = (y) => edge.x1 + (edge.x2 - edge.x1) * ((y - edge.y1) / (edge.y2 - edge.y1));
      rows[row].push({
        x1: x(y1),
        y1: y1 - row + 0.5,
        x2: x(y2),
        y2: y2 - row + 0.5,
        color: edge.color,
      });
    }
  }
  return rows;
}

export default class GitHistory extends View {
  declare scope: HistoryScope;
  declare historyOpen: boolean;
  declare detailsOpen: boolean;
  declare commits: Commit[];
  declare graph: GraphLayout;
  declare edges: GraphSegment[][];
  declare limit: number;
  declare generation: number;
  declare detailGeneration: number;
  declare diffGeneration: number;
  declare size: { width: number; height: number };
  declare listFocus: FocusHandle;
  declare fileFocus: FocusHandle;
  declare scroll: ReturnType<typeof VirtualListScrollHandle.new>;
  declare fileScroll: ReturnType<typeof VirtualListScrollHandle.new>;
  declare diffScroll: ReturnType<typeof VirtualListScrollHandle.new>;
  declare diffLines: string[];
  declare diffWidth: number;
  declare context: string;
  declare place: Location;
  declare snapshot: HistorySnapshot | null;
  declare details: CommitDetails | null;
  declare selected: string | null;
  declare error: string | null;
  declare detailError: string | null;
  declare diffError: string | null;
  declare diff: CommitDiff | null;
  declare file: string | null;
  declare fileIndex: number;
  declare loading: boolean;
  declare detailsLoading: boolean;
  declare diffLoading: boolean;
  declare polling: boolean;
  declare changed: boolean;
  declare signature: string | null;
  declare hasMore: boolean;
  declare root: string | null;
  declare branch: string | null;
  declare head: string | null;
  declare kept: Map<string, CachedList>;
  declare restoreLimit: boolean;

  init(_props, cx: AsyncContext) {
    this.scope = "current";
    this.kept = new Map();
    this.restoreLimit = false;
    this.historyOpen = true;
    this.detailsOpen = false;
    this.commits = [];
    this.graph = layoutGraph([]);
    this.edges = [];
    this.limit = PAGE_SIZE;
    this.generation = 0;
    this.detailGeneration = 0;
    this.diffGeneration = 0;
    this.size = { width: 366, height: 600 };
    this.listFocus = cx.focus_handle();
    this.fileFocus = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    this.fileScroll = VirtualListScrollHandle.new();
    this.diffScroll = VirtualListScrollHandle.new();
    this.diffLines = [];
    this.diffWidth = 0;
    cx.timer.every(15000, (cx) => this.poll(cx));
  }

  visible() {
    if (props()?.cwd) return true;
    const tree = layout() as LayoutNode | null,
      panel = find(tree, "panel"),
      body = find(tree, "panel-body");
    return !panel || (!panel.hidden && body?.active === "git-history");
  }

  gitAt(place: Location): GitExecutor {
    return (args) => exec("git", args, { cwd: place.cwd, on: place.on });
  }

  async signatureAt(git: GitExecutor) {
    const [refs, branch] = await Promise.all([
      git(["show-ref", "--head"]),
      git(["symbolic-ref", "-q", "--short", "HEAD"]),
    ]);
    if (refs.code > 1 || branch.code > 1)
      throw new Error(refs.stderr || branch.stderr || "Cannot read Git references.");
    return JSON.stringify([refs.stdout, branch.stdout]);
  }

  reset(place: Location, scope = this.scope) {
    const context = contextKey(place),
      cached =
        context === this.context && scope === this.scope
          ? null
          : this.kept.get(listKey(context, scope));
    if (this.context && this.snapshot) {
      const key = listKey(this.context, this.scope);
      this.kept.delete(key);
      this.kept.set(
        key,
        Object.fromEntries(CACHED_LIST.map((name) => [name, this[name]])) as CachedList,
      );
      if (this.kept.size > KEPT_PLACES) this.kept.delete(this.kept.keys().next().value);
    }
    this.scope = scope;
    this.generation++;
    this.detailGeneration++;
    this.diffGeneration++;
    this.context = context;
    this.place = place;
    this.historyOpen = true;
    this.detailsOpen = false;
    this.commits = [];
    this.snapshot = null;
    this.details = null;
    this.selected = null;
    this.graph = layoutGraph([]);
    this.edges = [];
    this.limit = PAGE_SIZE;
    this.error = null;
    this.detailError = null;
    this.diffError = null;
    this.diff = null;
    this.file = null;
    this.fileIndex = -1;
    this.diffLines = [];
    this.diffWidth = 0;
    this.loading = false;
    this.polling = false;
    this.detailsLoading = false;
    this.diffLoading = false;
    this.changed = false;
    this.signature = null;
    this.hasMore = false;
    this.root = null;
    this.branch = null;
    this.head = null;
    this.restoreLimit = Boolean(cached);
    if (cached) Object.assign(this, cached);
    this.scroll.scroll_to_item(0);
  }

  refresh(cx: Context, append = false, notify = true) {
    const place = location();
    if (contextKey(place) !== this.context) this.reset(place);
    if (!place.cwd || this.loading) return;
    const generation = ++this.generation,
      key = this.context;
    const limit = append
      ? Math.min(MAX_COMMITS, this.limit + PAGE_SIZE)
      : this.restoreLimit
        ? this.limit
        : PAGE_SIZE;
    this.restoreLimit = false;
    const snapshot = append ? this.snapshot : null;
    const git = this.gitAt(place),
      scope = this.scope;
    this.loading = true;
    this.polling = false;
    this.error = null;
    cx.spawn(async (cx) => {
      try {
        const signature = append ? null : await this.signatureAt(git);
        const history = await loadHistory(git, { scope, limit, snapshot });
        if (generation !== this.generation || contextKey(location()) !== key) return;
        this.commits = history.commits;
        this.snapshot = history.snapshot;
        this.root = history.root;
        this.branch = history.branch;
        this.head = history.head;
        this.hasMore = history.hasMore;
        this.limit = limit;
        this.graph = layoutGraph(this.commits);
        this.edges = rowSegments(this.graph, this.commits.length);
        if (!append) {
          this.signature = signature;
          this.changed = false;
          this.scroll.scroll_to_item(0);
        }
        if (!this.commits.some((c) => c.hash === this.selected)) {
          this.selected = null;
          this.details = null;
          this.file = null;
          this.diff = null;
          this.detailGeneration++;
          this.diffGeneration++;
          this.detailsLoading = false;
          this.diffLoading = false;
        }
      } catch (error) {
        if (generation === this.generation) this.error = errorText(error);
      } finally {
        if (generation === this.generation) {
          this.loading = false;
          cx.notify();
        }
      }
    });
    if (notify) cx.notify();
  }

  poll(cx: Context) {
    if (!this.visible() || this.loading || this.polling || !this.snapshot || this.changed) return;
    const place = location(),
      key = contextKey(place),
      generation = this.generation;
    if (key !== this.context) {
      this.refresh(cx);
      return;
    }
    this.polling = true;
    cx.spawn(async (cx) => {
      try {
        const signature = await this.signatureAt(this.gitAt(place));
        if (generation === this.generation && key === contextKey(location())) {
          this.changed = signature !== this.signature;
          if (this.changed) cx.notify();
        }
      } catch {
        /* Explicit Refresh reports connection and Git errors. */
      } finally {
        if (generation === this.generation) this.polling = false;
      }
    });
  }

  setScope(scope: HistoryScope, cx: Context) {
    if (scope === this.scope) return;
    this.reset(location(), scope);
    this.refresh(cx);
  }

  pick(hash: string, cx: Context) {
    if (!this.commits.some((c) => c.hash === hash)) return;
    const generation = ++this.detailGeneration,
      key = this.context,
      git = this.gitAt(this.place);
    this.diffGeneration++;
    this.selected = hash;
    this.details = null;
    this.file = null;
    this.diff = null;
    this.fileIndex = -1;
    this.detailError = null;
    this.diffError = null;
    this.detailsLoading = true;
    this.diffLoading = false;
    cx.spawn(async (cx) => {
      try {
        const details = await loadDetails(git, hash);
        if (generation === this.detailGeneration && key === contextKey(location())) {
          this.details = details;
          this.fileScroll.scroll_to_item(0);
        }
      } catch (error) {
        if (generation === this.detailGeneration) this.detailError = errorText(error);
      } finally {
        if (generation === this.detailGeneration) {
          this.detailsLoading = false;
          cx.notify();
        }
      }
    });
    cx.notify();
  }

  pickFile(path: string, cx: Context) {
    const details = this.details;
    if (!details?.files.some((file) => file.path === path)) return;
    const generation = ++this.diffGeneration,
      key = this.context,
      git = this.gitAt(this.place);
    this.file = path;
    this.diff = null;
    this.diffError = null;
    this.diffLines = [];
    this.diffLoading = true;
    this.listFocus.focus();
    this.diffScroll.scroll_to_item(0);
    cx.spawn(async (cx) => {
      try {
        const diff = await loadDiff(git, details.hash, details.parents, path);
        if (generation !== this.diffGeneration || key !== contextKey(location())) return;
        this.diff = diff;
        this.diffLines = diff.text.split("\n");
        this.diffWidth = Math.min(
          12000,
          Math.max(300, ...this.diffLines.map((line) => line.length * 7 + 24)),
        );
      } catch (error) {
        if (generation === this.diffGeneration) this.diffError = errorText(error);
      } finally {
        if (generation === this.diffGeneration) {
          this.diffLoading = false;
          cx.notify();
        }
      }
    });
    cx.notify();
  }

  button(id, label, action, { active = false, disabled = false, tooltip = label } = {}) {
    const t = theme() as Theme;
    return Button.new(id)
      .tab_stop(true)
      .h(26)
      .px(8)
      .flex_none()
      .rounded(3)
      .border_1()
      .border_color("#00000000")
      .text_size(11)
      .text_color(t.foreground)
      .bg(active ? t.selected : "#00000000")
      .disabled(disabled)
      .when(disabled, (el) => el.text_color(t.muted))
      .when(!disabled, (el) => el.cursor_pointer())
      .hover((el) => el.bg(t.hover))
      .focus((el) => el.border_color(t.accent))
      .tooltip(tooltip)
      .accessibility_label(tooltip)
      .on_click((_e, cx) => action(cx))
      .child(label);
  }

  graphCell(index, t) {
    const width = Math.max(30, this.graph.lanes * LANE_WIDTH + 16);
    const palette = [t.accent, t.working, t.muted];
    const paths = new Map();
    for (const edge of this.edges[index] ?? []) {
      let path = paths.get(edge.color) ?? PathBuilder.stroke(1.5);
      path = path
        .move_to(`${((8 + edge.x1 * LANE_WIDTH) / width) * 100}%`, `${edge.y1 * 100}%`)
        .line_to(`${((8 + edge.x2 * LANE_WIDTH) / width) * 100}%`, `${edge.y2 * 100}%`);
      paths.set(edge.color, path);
    }
    const isHead = this.commits[index].hash === this.head;
    return div()
      .relative()
      .w(width)
      .h(ROW_HEIGHT)
      .flex_none()
      .children(
        [...paths].map(([color, path]) =>
          window
            .paint_path(path.build(), palette[color % palette.length])
            .absolute()
            .inset_0()
            .size_full(),
        ),
      )
      .child(
        div()
          .absolute()
          .left(8 + this.graph.cols[index] * LANE_WIDTH - (isHead ? 5 : 3))
          .top(ROW_HEIGHT / 2 - (isHead ? 5 : 3))
          .size(isHead ? 10 : 6)
          .rounded(6)
          .bg(palette[this.graph.colors[index] % palette.length])
          .when(isHead, (el) => el.border_2().border_color(t.foreground)),
      );
  }

  commitRow(commit: Commit, index: number, t: Theme) {
    const selected = commit.hash === this.selected;
    const refNames = commit.refs
      .map((ref) => (ref.kind === "tag" ? `tag: ${ref.name}` : ref.name))
      .join(", ");
    return h_flex()
      .h(ROW_HEIGHT)
      .w_full()
      .items_center()
      .gap(4)
      .pr(10)
      .cursor_pointer()
      .bg(selected ? t.selected : "#00000000")
      .hover((el) => el.bg(t.hover))
      .role("list_item")
      .accessibility_label(
        `${commit.subject}, ${commit.author}, ${commit.hash.slice(0, 8)}${refNames ? `, ${refNames}` : ""}`,
      )
      .child(this.graphCell(index, t))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .min_w(0)
              .when(Boolean(refNames), (el) =>
                el.child(
                  div()
                    .max_w(125)
                    .flex_none()
                    .text_size(10)
                    .text_color(t.accent)
                    .truncate()
                    .child(refNames),
                ),
              )
              .child(
                div()
                  .flex_1()
                  .min_w(0)
                  .truncate()
                  .text_color(t.foreground)
                  .child(commit.subject || "(no subject)"),
              ),
          )
          .child(
            div()
              .truncate()
              .text_size(10)
              .text_color(t.muted)
              .child(`${commit.hash.slice(0, 8)}  ${commit.author}  ${shortDate(commit.date)}`),
          ),
      );
  }

  moveSelection(delta, cx: Context) {
    if (!this.commits.length) return;
    const previous = this.commits.findIndex((commit) => commit.hash === this.selected);
    const index = Math.max(
      0,
      Math.min(this.commits.length - 1, previous < 0 ? 0 : previous + delta),
    );
    this.scroll.scroll_to_item(index, "center");
    this.pick(this.commits[index].hash, cx);
  }

  filesList(details: CommitDetails, t: Theme) {
    return div()
      .id("history-files-focus")
      .relative()
      .flex_1()
      .min_h(0)
      .border_1()
      .border_color("#00000000")
      .track_focus(this.fileFocus)
      .tab_stop(true)
      .accessibility_label(
        "Changed files. Use arrow keys to select a file, then Enter to open its diff.",
      )
      .focus((el) => el.border_color(t.accent))
      .on_key_down((event, cx) => {
        if (["up", "down", "enter"].includes(event.key) && details.files.length) {
          this.fileIndex = Math.max(
            0,
            Math.min(
              details.files.length - 1,
              (this.fileIndex ?? -1) + (event.key === "down" ? 1 : event.key === "up" ? -1 : 0),
            ),
          );
          this.fileScroll.scroll_to_item(this.fileIndex, "center");
          if (event.key === "enter") this.pickFile(details.files[this.fileIndex].path, cx);
          cx.stop_propagation();
          cx.notify();
        }
      })
      .when(details.files.length > 0, (el) =>
        el.child(
          v_virtual_list(
            "history-files",
            details.files.length,
            26 * ((settings().zoom as number | undefined) ?? 1),
            (i) => details.files[i].path,
            (range) =>
              details.files.slice(range.start, range.end).map((file, offset) =>
                h_flex()
                  .h(26)
                  .px(10)
                  .gap(8)
                  .items_center()
                  .cursor_pointer()
                  .hover((el) => el.bg(t.hover))
                  .when(range.start + offset === this.fileIndex, (row) => row.bg(t.selected))
                  .child(div().w(12).flex_none().text_color(t.accent).child(file.status))
                  .child(
                    div()
                      .flex_1()
                      .min_w(0)
                      .truncate()
                      .child(file.oldPath ? `${file.oldPath} → ${file.path}` : file.path),
                  )
                  .child(
                    div()
                      .flex_none()
                      .text_size(10)
                      .text_color(t.muted)
                      .child(file.added === null ? "binary" : `+${file.added} −${file.removed}`),
                  ),
              ),
          )
            .size_full()
            .track_scroll(this.fileScroll)
            .on_item_click((path, cx) => {
              this.fileIndex = details.files.findIndex((file) => file.path === path);
              this.pickFile(path, cx);
            }),
        ),
      )
      .when(details.files.length > 0, (el) =>
        el.child(Scrollbar.vertical("history-files").viewport_from_layout().absolute().inset_0()),
      )
      .when(details.files.length === 0, (el) =>
        el.child(div().p(10).text_color(t.muted).child("No files changed.")),
      );
  }

  disclosure(id, label, open, action, t) {
    return AccordionTrigger.new(id)
      .tab_stop(true)
      .h(30)
      .w_full()
      .flex()
      .items_center()
      .px(10)
      .gap(6)
      .text_size(11)
      .text_color(t.muted)
      .cursor_pointer()
      .on_change((expanded, cx) => {
        action(expanded);
        cx.notify();
      })
      .child(
        div()
          .w(10)
          .flex_none()
          .child(open ? "▾" : "▸"),
      )
      .child(div().child(label));
  }

  detailsContent(t, height) {
    const details = this.details;
    let content = v_flex()
      .flex_1()
      .min_h(0)
      .p(10)
      .child(
        this.detailsLoading
          ? "Loading commit…"
          : this.detailError || "Select a commit. Use ↑ and ↓ to move through history.",
      );
    if (details && !this.file) {
      content = v_flex()
        .flex_1()
        .min_h(0)
        .child(
          v_flex()
            .id("history-message")
            .h(Math.min(130, height * 0.46))
            .flex_none()
            .overflow_y_scrollbar()
            .p(10)
            .gap(5)
            .child(
              div()
                .text_color(t.muted)
                .text_size(10)
                .child(`${details.hash.slice(0, 12)}  ${shortDate(details.date)}`),
            )
            .child(
              div().text_color(t.muted).text_size(11).child(`${details.author} <${details.email}>`),
            )
            .child(div().child(details.body || "(no commit message)")),
        )
        .child(
          h_flex()
            .px(10)
            .h(24)
            .flex_none()
            .items_center()
            .border_y(1)
            .border_color(t.border)
            .text_size(10)
            .text_color(t.muted)
            .child(
              `${details.files.length}${details.filesLimited ? "+" : ""} files${details.parents.length > 1 ? " · Compared with first parent" : ""}`,
            ),
        )
        .child(this.filesList(details, t));
    }
    if (this.file) {
      content = v_flex()
        .flex_1()
        .min_h(0)
        .child(
          h_flex()
            .h(28)
            .px(4)
            .gap(6)
            .items_center()
            .flex_none()
            .child(
              this.button(
                "history-back",
                "Back",
                (cx) => {
                  this.diffGeneration++;
                  this.file = null;
                  this.diff = null;
                  this.diffLoading = false;
                  this.fileFocus.focus();
                  cx.notify();
                },
                { tooltip: "Back to commit details" },
              ),
            )
            .child(div().flex_1().min_w(0).truncate().text_size(11).child(this.file)),
        )
        .when(Boolean(this.diffError || this.diffLoading), (el) =>
          el.child(
            div()
              .p(10)
              .child(this.diffLoading ? "Loading diff…" : `Diff unavailable: ${this.diffError}`),
          ),
        )
        .child(
          div()
            .relative()
            .flex_1()
            .min_h(0)
            .when(this.diffLines.length > 0, (el) =>
              el.child(
                div()
                  .id("history-diff-x")
                  .size_full()
                  .overflow_x_scrollbar()
                  .child(
                    div()
                      .w_full()
                      .min_w(this.diffWidth)
                      .h_full()
                      .child(
                        v_virtual_list(
                          "history-diff",
                          this.diffLines.length,
                          19 * ((settings().zoom as number | undefined) ?? 1),
                          (i) => String(i),
                          (range) =>
                            this.diffLines.slice(range.start, range.end).map((line) =>
                              div()
                                .h(19)
                                .px(10)
                                .text_size(11)
                                .truncate()
                                .text_color(
                                  line.startsWith("+") && !line.startsWith("+++")
                                    ? t.working
                                    : t.foreground,
                                )
                                .when(line.startsWith("-") && !line.startsWith("---"), (el) =>
                                  el.bg(t.selected),
                                )
                                .child(line || " "),
                            ),
                        )
                          .track_scroll(this.diffScroll)
                          .size_full(),
                      ),
                  ),
              ),
            )
            .when(this.diffLines.length > 0, (el) =>
              el.child(
                Scrollbar.vertical("history-diff").viewport_from_layout().absolute().inset_0(),
              ),
            ),
        )
        .when(Boolean(this.diff?.truncated), (el) =>
          el.child(
            div()
              .px(10)
              .py(3)
              .text_size(10)
              .text_color(t.muted)
              .child("Preview limited to 30,000 characters."),
          ),
        );
    }
    return content;
  }

  detailsView(t) {
    const height = Math.max(110, Math.min(320, this.size.height * 0.43));
    return AccordionItem.new()
      .open(this.detailsOpen)
      .h(this.detailsOpen ? height : 30)
      .flex()
      .flex_col()
      .flex_none()
      .min_h(0)
      .border_t(1)
      .border_color(t.border)
      .header(
        AccordionHeader.new(
          this.disclosure(
            "history-details-toggle",
            "Commit details",
            this.detailsOpen,
            (open) => {
              this.detailsOpen = open;
            },
            t,
          ),
        ),
      )
      .panel(
        AccordionPanel.new()
          .flex()
          .flex_col()
          .flex_1()
          .min_h(0)
          .when(this.detailsOpen, (el) => el.child(this.detailsContent(t, height))),
      );
  }

  historyContent(t) {
    const graphWidth = Math.max(30, this.graph.lanes * LANE_WIDTH + 16);
    const listWidth = Math.max(this.size.width - 4, graphWidth + 180);
    return v_flex()
      .id("history-content")
      .size_full()
      .min_h(0)
      .child(
        h_flex()
          .h(34)
          .px(4)
          .gap(2)
          .items_center()
          .flex_none()
          .child(
            this.button("history-current", "Current branch", (cx) => this.setScope("current", cx), {
              active: this.scope === "current",
            }),
          )
          .child(
            this.button("history-all", "All branches", (cx) => this.setScope("all", cx), {
              active: this.scope === "all",
            }),
          )
          .child(div().flex_1())
          .child(
            this.button(
              "history-refresh",
              this.loading ? "Loading…" : "Refresh",
              (cx) => this.refresh(cx),
              { disabled: this.loading, tooltip: "Refresh history (R)" },
            ),
          ),
      )
      .when(this.changed, (el) =>
        el.child(
          div()
            .px(10)
            .py(5)
            .text_size(11)
            .text_color(t.accent)
            .child("History changed. Refresh to show new commits."),
        ),
      )
      .when(Boolean(this.error), (el) =>
        el.child(div().px(10).py(6).text_color(t.foreground).child(this.error)),
      )
      .when(!this.commits.length, (el) =>
        el.child(
          div()
            .p(10)
            .text_color(t.muted)
            .child(
              this.loading
                ? "Loading history…"
                : this.error
                  ? "Use Refresh to try again."
                  : this.root
                    ? "This repository has no commits in this view."
                    : "Open a terminal in a Git repository.",
            ),
        ),
      )
      .child(
        div()
          .id("history-list-focus")
          .relative()
          .flex_1()
          .min_h(50)
          .border_1()
          .border_color("#00000000")
          .track_focus(this.listFocus)
          .tab_stop(true)
          .role("list")
          .accessibility_label("Git history. Arrow keys select commits. R refreshes history.")
          .on_key_down((event, cx) => {
            if (["up", "down", "r", "home", "end"].includes(event.key)) {
              if (event.key === "r") this.refresh(cx);
              else if (event.key === "home") {
                if (this.commits.length) {
                  this.pick(this.commits[0].hash, cx);
                  this.scroll.scroll_to_item(0);
                }
              } else if (event.key === "end") {
                if (this.commits.length) {
                  this.pick(this.commits[this.commits.length - 1].hash, cx);
                  this.scroll.scroll_to_bottom();
                }
              } else this.moveSelection(event.key === "down" ? 1 : -1, cx);
              cx.stop_propagation();
            }
          })
          .when(this.commits.length > 0, (el) =>
            el.child(
              div()
                .id("history-list-x")
                .size_full()
                .overflow_x_scrollbar()
                .child(
                  div()
                    .w(listWidth)
                    .h_full()
                    .child(
                      v_virtual_list(
                        "history-commits",
                        this.commits.length,
                        ROW_HEIGHT * ((settings().zoom as number | undefined) ?? 1),
                        (i) => this.commits[i].hash,
                        (range) =>
                          this.commits
                            .slice(range.start, range.end)
                            .map((commit, offset) =>
                              this.commitRow(commit, range.start + offset, t),
                            ),
                      )
                        .size_full()
                        .track_scroll(this.scroll)
                        .on_item_click((hash, cx) => {
                          this.listFocus.focus();
                          this.pick(hash, cx);
                        }),
                    ),
                ),
            ),
          )
          .when(this.commits.length > 0, (el) =>
            el.child(
              Scrollbar.vertical("history-commits").viewport_from_layout().absolute().inset_0(),
            ),
          ),
      )
      .child(
        h_flex()
          .h(32)
          .px(6)
          .items_center()
          .gap(6)
          .flex_none()
          .border_t(1)
          .border_color(t.border)
          .child(
            div()
              .flex_1()
              .text_size(10)
              .text_color(t.muted)
              .child(
                `${this.commits.length} commits${this.hasMore && this.limit >= MAX_COMMITS ? " · Limit reached" : ""}`,
              ),
          )
          .when(this.hasMore && this.limit < MAX_COMMITS, (el) =>
            el.child(
              this.button(
                "history-more",
                `Load ${PAGE_SIZE} more`,
                (cx) => this.refresh(cx, true),
                { disabled: this.loading },
              ),
            ),
          ),
      );
  }

  render(cx: Context) {
    if (!this.visible()) return div();
    if (contextKey(location()) !== this.context) this.refresh(cx, false, false);
    const t = theme() as Theme;
    return v_flex()
      .id("git-history")
      .size_full()
      .min_h(0)
      .rounded(3)
      .overflow_hidden()
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(12)
      .on_key_down((event, cx) => {
        if (event.key === "tab") {
          if (event.modifiers.shift) window.focus_prev();
          else window.focus_next();
          cx.stop_propagation();
        } else if (event.key === "escape" && this.file) {
          this.diffGeneration++;
          this.file = null;
          this.diff = null;
          this.diffLoading = false;
          this.listFocus.focus();
          cx.stop_propagation();
          cx.notify();
        }
      })
      .on_size_change((size, cx) => {
        const zoom = (settings().zoom as number | undefined) ?? 1;
        const next = { width: size.width / zoom, height: size.height / zoom };
        if (
          Math.abs(next.width - this.size.width) > 1 ||
          Math.abs(next.height - this.size.height) > 1
        ) {
          this.size = next;
          cx.notify();
        }
      })
      .child(
        Accordion.new("history-accordion")
          .flex()
          .flex_col()
          .size_full()
          .min_h(0)
          .child(
            AccordionItem.new()
              .open(this.historyOpen)
              .flex()
              .flex_col()
              .min_h(0)
              .when(this.historyOpen, (el) => el.flex_1())
              .when(!this.historyOpen, (el) => el.flex_none())
              .header(
                AccordionHeader.new(
                  this.disclosure(
                    "history-toggle",
                    "History",
                    this.historyOpen,
                    (open) => {
                      this.historyOpen = open;
                    },
                    t,
                  ).child(
                    div()
                      .flex_1()
                      .min_w(0)
                      .truncate()
                      .text_size(10)
                      .child(this.branch || (this.head ? "Detached HEAD" : "")),
                  ),
                ),
              )
              .panel(
                AccordionPanel.new()
                  .flex()
                  .flex_col()
                  .flex_1()
                  .min_h(0)
                  .when(this.historyOpen, (el) => el.child(this.historyContent(t))),
              ),
          )
          .child(this.detailsView(t)),
      );
  }
}
