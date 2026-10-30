import {
  View,
  div,
  svg,
  image,
  type Context,
  type AsyncContext,
  type Color,
  type FocusHandle,
} from "gpui-kit";
import {
  v_flex,
  h_flex,
  InputState,
  Input,
  Scrollbar,
  v_virtual_list,
  v_resizable,
  resizable_panel,
} from "gpui-base";
import {
  spaces,
  panes,
  focused,
  exec,
  readTextFile,
  watchFolder,
  theme,
  settings,
  layout,
  agents,
  type AgentInfo,
  hc,
} from "herdr";
import { LINE_LIMIT, trackedPreview, untrackedPreview } from "./preview.ts";
import { expandGaps, fileLines } from "./gaps.ts";
import { button } from "./button.ts";
import {
  DEFAULT_NOTE,
  lineSide,
  pickAgent,
  agentChoices,
  agentName,
  reviewMessage,
  withComments,
  withComposer,
  type ReviewComment,
  type Target,
} from "./review.ts";
import {
  colorRows,
  parseAnsi,
  NEW_SOURCE,
  OLD_SOURCE,
  type DiffRow,
  type Span,
} from "./highlight.ts";

interface LayoutNode {
  id?: string;
  children?: LayoutNode[];
  hidden?: boolean;
  active?: string;
}

function location() {
  const space = spaces().find((s) => s.active),
    f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on =
    f?.pane === null
      ? f.terminal?.includes("/")
        ? f.terminal.split("/")[0]
        : null
      : (space?.machine ?? null);
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
type Theme = Record<string, Color>;

interface FileStats {
  add: number;
  del: number;
  binary?: boolean;
}
interface ChangedFile extends FileStats {
  path: string;
  status: string;
  fresh: boolean;
}
type Snapshot = Pick<
  Changes,
  | "root"
  | "on"
  | "hasHead"
  | "files"
  | "limited"
  | "error"
  | "open"
  | "closed"
  | "rows"
  | "diffWidth"
  | "plainRows"
  | "fileLines"
  | "oldSpans"
  | "newSpans"
  | "expanded"
  | "comments"
  | "reviewNote"
  | "agentAddress"
>;

const key = () => JSON.stringify(location());
const TRASH = "mods/frantss-changes/trash.svg",
  CHEVRON = "mods/workspace-chrome/chevron-down.svg";
// Diff rows indent their text past the line number and the hover "+".
const GUTTER = 62,
  COMPOSER = 48;
const zoom = () => (settings().zoom as number | undefined) ?? 1;

function find(node: LayoutNode | null, id: string): LayoutNode | null {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
// A hidden copy keeps running, so it waits until the panel shows it.
function shown() {
  const tree = layout() as LayoutNode | null,
    panel = find(tree, "panel"),
    body = find(tree, "panel-body");
  return !panel || (!panel.hidden && body?.active === "changes");
}
// Git's lock files come and go with every git command; refreshing on them alone never ends.
const meaningful = (paths: string[]) =>
  paths.some((path) => !/\/\.git\/.*\.lock$|\/node_modules\//.test(path));
// What a place's changes looked like when it was last shown, so switching back shows them at once
// while git refreshes them; a few places are kept.
const SNAPSHOT = [
  "root",
  "on",
  "hasHead",
  "files",
  "limited",
  "error",
  "open",
  "closed",
  "rows",
  "diffWidth",
  "plainRows",
  "fileLines",
  "oldSpans",
  "newSpans",
  "expanded",
  "comments",
  "reviewNote",
  "agentAddress",
] as const;
const KEPT_PLACES = 20;
// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines: string[]): DiffRow[] {
  let old = 0,
    next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,(\d+))?/.exec(line);
    if (match) {
      old = +match[1];
      next = +match[2];
      // A hunk with no new lines names the line before it.
      return { kind: "@", number: next + Number(match[3] === "0"), text: line };
    }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
    if (kind === " ") {
      old++;
      return { kind, number: next++, text: line.slice(1) || " " };
    }
    return { kind: "", text: line };
  });
}

const sameFiles = (left: ChangedFile[], right: ChangedFile[]) =>
  left.length === right.length &&
  left.every((file, i) => {
    const other = right[i];
    return (
      file.path === other.path &&
      file.status === other.status &&
      file.fresh === other.fresh &&
      file.add === other.add &&
      file.del === other.del &&
      Boolean(file.binary) === Boolean(other.binary)
    );
  });
const sameRows = (left: DiffRow[], right: DiffRow[]) =>
  left.length === right.length &&
  left.every(
    (row, i) =>
      row.kind === right[i].kind && row.number === right[i].number && row.text === right[i].text,
  );

export default class Changes extends View {
  declare files: ChangedFile[];
  // Shown rows: the diff's plain rows with expanded gaps and colors.
  declare rows: DiffRow[];
  declare plainRows: DiffRow[];
  // The new file's lines, for expanding gaps; null where gaps cannot expand.
  declare fileLines: string[] | null;
  declare oldSpans: Span[][];
  declare newSpans: Span[][];
  declare expanded: ReadonlySet<number>;
  declare diffWidth: number;
  declare handle: FocusHandle;
  declare kept: Map<string, Snapshot>;
  declare commentInput: InputState;
  declare noteInput: InputState;
  // The input holding the keyboard.
  declare typing: "comment" | "note" | null;
  // The review: comments wait here until one send gives them all to the agent.
  declare comments: ReviewComment[];
  declare reviewNote: string;
  // The line being commented on, or the comment being edited (its index).
  declare target: Target | null;
  // Where the last press in the diff landed, since a row click reports only the row.
  declare pressX: number;
  declare sending: boolean;
  // The agent picked for the review; null sends to this space's latest one.
  declare agentAddress: string | null;
  declare choosingAgent: boolean;
  declare on: string | null;
  declare watched: string | null;
  declare root: string | null;
  declare context: string;
  declare limited: boolean;
  declare loading: boolean;
  declare loadingRendered: boolean;
  declare watchToken: object;
  declare stale: boolean;
  declare error: string | null;
  declare note: string | null;
  declare open: string | null;
  declare closed: boolean;
  declare hasHead: boolean;

  init(_props: unknown, cx: AsyncContext) {
    this.files = [];
    this.comments = [];
    this.reviewNote = DEFAULT_NOTE;
    this.target = null;
    this.agentAddress = null;
    this.setLines([]);
    this.handle = cx.focus_handle();
    this.kept = new Map();
    const field = (name: Changes["typing"], placeholder: string) => {
      const input = InputState.new({ placeholder });
      input.on("focus", (_e, cx) => {
        this.typing = name;
        cx.notify();
      });
      input.on("blur", (_e, cx) => {
        if (this.typing === name) this.typing = null;
        cx.notify();
      });
      return input;
    };
    this.commentInput = field("comment", "Comment");
    this.commentInput.on("submit", (_e, cx) => this.saveComment(cx));
    this.noteInput = field("note", "Overall note (optional)");
    this.noteInput.set_value(this.reviewNote);
    this.noteInput.on("change", (_e) => {
      this.reviewNote = this.noteInput.value();
    });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  watch(root: string, cx: Context) {
    if (this.on || this.watched === root) return;
    const token = {};
    this.watchToken = token;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watchToken === token && this.watched === root) {
          if (!meaningful(await watchFolder(root))) continue;
          // One refresh for a burst of saves.
          await cx.sleep(300);
          if (this.watchToken === token && this.watched === root) this.refresh(cx);
        }
      } catch {
        if (this.watchToken === token && this.watched === root) this.watched = null;
      }
    });
  }

  refresh(cx: Context) {
    const { cwd, on } = location(),
      context = key();
    // Switch places before waiting on any git still running for the last one: its results check the place.
    if (context !== this.context) this.switchTo(context);
    if (this.loading || !cwd) return;
    if (!shown()) {
      this.stale = true;
      return;
    }
    const previous = Object.fromEntries(SNAPSHOT.map((name) => [name, this[name]])) as Snapshot;
    this.loading = true;
    this.loadingRendered = false;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) {
          this.root = null;
          this.files = [];
          this.setLines([]);
          this.open = null;
          this.error = "Not a git repository";
          return;
        }
        const root = top.stdout.trim(),
          git = (args: string[]) => exec("git", args, { cwd: root, on });
        const [status, head] = await Promise.all([
          git([
            "--no-optional-locks",
            "status",
            "--porcelain=v1",
            "-z",
            "--no-renames",
            "--untracked-files=all",
          ]),
          git(["rev-parse", "--verify", "HEAD"]),
        ]);
        if (key() !== context) return;
        if (status.code !== 0) throw new Error(status.stderr);
        const stats: Record<string, FileStats> = {};
        const results =
          head.code === 0
            ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])]
            : await Promise.all([
                git(["diff", "--cached", "--numstat", "-z", "--no-renames"]),
                git(["diff", "--numstat", "-z", "--no-renames"]),
              ]);
        if (key() !== context) return;
        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"),
              old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = {
              add: old.add + (Number(a) || 0),
              del: old.del + (Number(d) || 0),
              binary: a === "-",
            };
          }
        }
        const files: ChangedFile[] = [];
        const entries = status.stdout.split("\0").filter(Boolean);
        for (const entry of entries.slice(0, 1000)) {
          const xy = entry.slice(0, 2),
            path = entry.slice(3),
            fresh = xy === "??";
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          const stat = stats[path] ?? { add: 0, del: 0 };
          files.push({ path, status: s, fresh, ...stat });
        }
        if (key() !== context) return;
        this.root = root;
        this.on = on;
        this.hasHead = head.code === 0;
        this.files = files;
        this.limited = entries.length > 1000;
        this.error = null;
        this.watch(root, cx);
        if (this.open && !files.some((f) => f.path === this.open)) {
          this.open = null;
          this.setLines([]);
        }
        // The first file's diff shows until you pick another.
        if (!this.open && !this.closed && files.length) this.open = files[0].path;
        if (this.open) {
          try {
            await this.load(this.open, context, cx);
          } catch {
            if (key() === context)
              this.setLines(["Cannot preview this diff (too large or unreadable)"]);
          }
        }
      } catch (e) {
        if (key() === context) this.error = String(e);
      } finally {
        const current = this.context === context && key() === context;
        let changed = !current;
        if (current) {
          const filesEqual = sameFiles(previous.files, this.files),
            rowsEqual = sameRows(previous.rows, this.rows);
          changed =
            !filesEqual ||
            !rowsEqual ||
            SNAPSHOT.some(
              (name) => name !== "files" && name !== "rows" && this[name] !== previous[name],
            );
          if (filesEqual) this.files = previous.files;
          if (rowsEqual) this.rows = previous.rows;
        }
        const notify = changed || this.loadingRendered;
        this.loading = false;
        // The place changed while git ran: refresh the one now shown.
        if (key() !== context) this.refresh(cx);
        if (notify) cx.notify();
      }
    });
  }

  // Keeps what this place shows and shows what the next one showed last, or nothing yet.
  switchTo(context: string) {
    this.closeComment();
    if (this.context) {
      this.kept.delete(this.context);
      this.kept.set(
        this.context,
        Object.fromEntries(SNAPSHOT.map((name) => [name, this[name]])) as Snapshot,
      );
      if (this.kept.size > KEPT_PLACES) this.kept.delete(this.kept.keys().next().value);
    }
    const kept = this.kept.get(context);
    this.context = context;
    this.note = null;
    this.watched = null;
    if (kept) Object.assign(this, kept);
    else {
      this.root = null;
      this.files = [];
      this.open = null;
      this.setLines([]);
      this.error = null;
      this.closed = false;
      this.limited = false;
      this.comments = [];
      this.reviewNote = DEFAULT_NOTE;
      this.agentAddress = null;
    }
    this.choosingAgent = false;
    this.noteInput.set_value(this.reviewNote);
  }

  async load(path: string, context: string, cx: Context) {
    const file = this.files.find((f) => f.path === path),
      root = this.root,
      on = this.on;
    if (!file) return;
    const fresh = file.fresh || (!this.hasHead && file.status === "A");
    let lines: string[],
      text: string | null = null;
    if (fresh) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch((): null => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else {
        const preview = untrackedPreview(text);
        if (preview.add !== null) file.add = preview.add;
        lines = preview.lines;
      }
    } else {
      const [r, current] = await Promise.all([
        exec(
          "git",
          [
            "diff",
            ...(this.hasHead ? ["HEAD"] : []),
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--",
            path,
          ],
          { cwd: root, on },
        ),
        file.status === "D" || file.binary
          ? null
          : readTextFile(`${root}/${path}`, { on }).catch((): null => null),
      ]);
      if (r.code !== 0) throw new Error(r.stderr);
      lines = trackedPreview(r.stdout, Boolean(file.binary));
      text = current;
    }
    if (key() !== context || this.open !== path) return;
    const rows = diffRows(lines);
    // An unchanged diff keeps its expanded gaps and colors without running bat again.
    if (sameRows(this.plainRows, rows)) return;
    this.plainRows = rows;
    // A diff cut short would show its missing changes as unchanged lines.
    this.fileLines = text === null || lines.length >= LINE_LIMIT ? null : fileLines(text);
    this.oldSpans = [];
    this.newSpans = [];
    this.show();
    if (!file.binary && rows.some((row) => row.number !== undefined))
      this.highlight(path, fresh, rows, cx);
  }

  // Shows the plain rows first and colors them when bat answers.
  highlight(path: string, fresh: boolean, rows: DiffRow[], cx: Context) {
    const context = this.context,
      source = (script: string, ...args: string[]) =>
        exec("sh", ["-c", script, "bat", path, ...args], { cwd: this.root, on: this.on }).catch(
          (): null => null,
        );
    cx.spawn(async (cx) => {
      const [old, next] = await Promise.all([
        fresh ? null : source(OLD_SOURCE, this.hasHead ? "HEAD:" : ":"),
        source(NEW_SOURCE),
      ]);
      if (key() !== context || this.open !== path || this.plainRows !== rows) return;
      if (old?.code === 127 || next?.code === 127) {
        if (!this.note) {
          this.note = "Install bat for syntax colors";
          cx.notify();
        }
        return;
      }
      const spans = (r: typeof old) => (r?.code === 0 ? parseAnsi(r.stdout) : []);
      this.oldSpans = spans(old);
      this.newSpans = spans(next);
      if (!this.oldSpans.length && !this.newSpans.length) return;
      this.show();
      cx.notify();
    });
  }

  setLines(lines: string[]) {
    this.plainRows = diffRows(lines);
    this.fileLines = null;
    this.oldSpans = [];
    this.newSpans = [];
    this.expanded = new Set();
    this.show();
  }

  show() {
    this.rows = withComposer(
      withComments(
        colorRows(
          expandGaps(this.plainRows, this.fileLines, this.expanded),
          this.oldSpans,
          this.newSpans,
        ),
        this.comments,
        this.open,
      ),
      this.target,
    );
    this.diffWidth = this.rows.reduce(
      (width, row) => Math.max(width, row.text.length * 7 + 57),
      300,
    );
  }

  // A gap row expands, a comment row opens for editing, a line opens a new comment, and the
  // comment box's trash deletes the comment it edits.
  clickRow(index: number, cx: Context) {
    const row = this.rows[index];
    if (!row || !this.open) return;
    if (row.kind === "compose") {
      if (this.target?.index !== null && this.pressX < GUTTER * zoom()) this.removeComment(cx);
      return;
    }
    if (row.kind === "@") {
      if (!row.gap) return;
      this.expanded = new Set(this.expanded).add(row.number);
    } else if (row.kind === "#") {
      const { text, ...line } = this.comments[row.comment];
      this.target = { ...line, index: row.comment };
      this.commentInput.set_value(text);
      this.commentInput.focus();
    } else {
      const side = lineSide(row);
      if (!side) return;
      this.target = { path: this.open, side, number: row.number, quote: row.text, index: null };
      this.commentInput.set_value("");
      this.commentInput.focus();
    }
    this.show();
    cx.notify();
  }

  closeComment() {
    this.target = null;
    this.commentInput.set_value("");
    this.show();
  }

  // An emptied comment is removed.
  saveComment(cx: Context) {
    if (!this.target) return;
    const { index, ...line } = this.target,
      text = this.commentInput.value().trim(),
      comments = [...this.comments];
    if (index === null) {
      if (text) comments.push({ ...line, text });
    } else if (text) comments[index] = { ...comments[index], text };
    else comments.splice(index, 1);
    this.comments = comments;
    this.closeComment();
    this.handle.focus();
    cx.notify();
  }

  removeComment(cx: Context) {
    this.commentInput.set_value("");
    this.saveComment(cx);
  }

  discardReview(cx: Context) {
    this.comments = [];
    this.reviewNote = DEFAULT_NOTE;
    this.noteInput.set_value(DEFAULT_NOTE);
    this.closeComment();
    cx.notify();
  }

  sendReview(cx: Context) {
    const agent = pickAgent(agents(), focused()?.space, this.agentAddress);
    if (!agent || !this.comments.length || this.sending) return;
    const message = reviewMessage(this.comments, this.reviewNote),
      context = this.context;
    this.sending = true;
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["send", agent.address, message]);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        if (key() === context) this.discardReview(cx);
        else {
          const kept = this.kept.get(context);
          if (kept) Object.assign(kept, { comments: [], reviewNote: DEFAULT_NOTE });
        }
      } catch (e) {
        if (key() === context) this.note = `Send failed: ${e}`;
      } finally {
        this.sending = false;
        cx.notify();
      }
    });
    cx.notify();
  }

  pick(path: string, cx: Context) {
    this.open = this.open === path ? null : path;
    this.closeComment();
    this.setLines([]);
    this.note = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open)
      cx.spawn(async (cx) => {
        try {
          await this.load(path, context, cx);
        } catch (e) {
          if (key() === context && this.open === path)
            this.note = `Cannot preview this diff (too large or unreadable): ${e}`;
        }
        cx.notify();
      });
    cx.notify();
  }

  targets(row: DiffRow) {
    const target = this.target;
    if (!target) return false;
    if (row.kind === "#") return row.comment === target.index;
    return (
      target.index === null &&
      target.path === this.open &&
      target.number === row.number &&
      target.side === lineSide(row)
    );
  }

  diffRow(row: DiffRow, index: number, t: Theme) {
    const { kind, number, text, spans, gap } = row;
    if (kind === "compose")
      return h_flex()
        .w_full()
        .h(COMPOSER)
        .flex_none()
        .items_center()
        .pr(12)
        .bg(t.raised)
        .child(
          div()
            .w(GUTTER)
            .h_full()
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .when(this.target?.index !== null, (e) =>
              e
                .cursor_pointer()
                .text_color(t.muted)
                .hover((s) => s.text_color(t.foreground))
                .child(svg(TRASH).size(14)),
            ),
        )
        .child(this.field("comment-text", this.commentInput, "comment", t));
    if (kind === "#") {
      const comment = this.comments[row.comment];
      return div()
        .w_full()
        .h(20)
        .flex_none()
        .pl(GUTTER)
        .pr(12)
        .truncate()
        .cursor_pointer()
        .bg(this.targets(row) ? t.selected : ((t.accent + "22") as Color))
        .text_color(row.outdated ? t.muted : t.foreground)
        .hover((s) => s.bg(t.hover))
        .child(row.outdated ? `Outdated · line ${comment.number} · ${text}` : `▸ ${text}`);
    }
    if (kind === "@")
      return div()
        .w_full()
        .px(12)
        .h(20)
        .flex_none()
        .truncate()
        .bg(t.raised)
        .text_color(t.dim)
        .when(Boolean(gap), (e) =>
          e.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)),
        )
        .child(
          gap
            ? [`↕ ${gap} unchanged ${gap === 1 ? "line" : "lines"}`, text]
                .filter(Boolean)
                .join(" · ")
            : text,
        );
    const commentable = lineSide(row) !== null;
    return (
      h_flex()
        .relative()
        .w_full()
        .h(20)
        .flex_none()
        .pl(22)
        .gap(10)
        .when(commentable, (e) => e.cursor_pointer())
        .when(kind === "+", (e) => e.bg((t.ansi2 + "18") as Color))
        .when(kind === "-", (e) => e.bg((t.ansi1 + "18") as Color))
        .when(this.targets(row), (e) => e.bg(t.selected))
        // The "+" shows on hover: an overlay over the row, since a row cannot style its children.
        .when(commentable, (e) =>
          e.child(
            div()
              .id(`diff-add-${index}`)
              .absolute()
              .inset_0()
              .opacity(0)
              .hover((s) => s.opacity(1))
              .child(
                div()
                  .absolute()
                  .left(3)
                  .top(2)
                  .size(16)
                  .flex()
                  .items_center()
                  .justify_center()
                  .rounded(3)
                  .bg(t.accent)
                  .text_color(t.accent_foreground)
                  .font_bold()
                  .child("+"),
              ),
          ),
        )
        .child(
          div()
            .w(30)
            .flex_none()
            .text_right()
            .text_color(t.dim)
            .child(number === undefined ? "" : String(number)),
        )
        .child(
          spans
            ? h_flex()
                .flex_1()
                .min_w(0)
                .overflow_hidden()
                .children(spans.map((span) => this.span(span, t)))
            : div().flex_1().min_w(0).truncate().child(text),
        )
    );
  }

  span({ text, color }: Span, t: Theme) {
    const tint = color === undefined ? undefined : t[`ansi${color}`];
    return div()
      .flex_none()
      .when(Boolean(tint), (e) => e.text_color(tint))
      .child(text);
  }

  fileRow(f: ChangedFile, t: Theme) {
    const parts = f.path.split("/"),
      name = parts.pop(),
      comments = this.comments.filter((comment) => comment.path === f.path).length;
    return h_flex()
      .id(`change-${f.path}`)
      .h(24)
      .flex_none()
      .px(8)
      .gap(8)
      .items_center()
      .rounded(3)
      .cursor_pointer()
      .text_color(this.open === f.path ? t.foreground : t.muted)
      .when(this.open === f.path, (e) => e.bg(t.selected))
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .child(
        div()
          .w(14)
          .text_size(11)
          .text_color(
            f.status === "A"
              ? t.ansi2
              : f.status === "D"
                ? t.ansi1
                : f.status === "U"
                  ? t.ansi1
                  : t.accent,
          )
          .child(f.status),
      )
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .child(
            div()
              .text_color(t.dim)
              .truncate()
              .child(parts.length ? parts.join("/") + "/" : ""),
          )
          .child(div().max_w(260).min_w(0).truncate().child(name)),
      )
      .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
      .when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)))
      .when(comments > 0, (e) =>
        e.child(div().text_size(11).text_color(t.accent).child(`✎ ${comments}`)),
      );
  }

  render(cx: Context) {
    if (!shown()) return div();
    if (this.stale) {
      this.stale = false;
      this.refresh(cx);
    }
    if (key() !== this.context) this.refresh(cx);
    if (this.loading) this.loadingRendered = true;
    const t = theme() as Theme,
      add = this.files.reduce((n, f) => n + f.add, 0),
      del = this.files.reduce((n, f) => n + f.del, 0);
    return v_flex()
      .id("changes")
      .size_full()
      .min_h(0)
      .rounded(3)
      .overflow_hidden()
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(12)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.choosingAgent) {
          this.choosingAgent = false;
          cx.stop_propagation();
          cx.notify();
        } else if (e.key === "escape" && this.typing) {
          if (this.typing === "comment") this.closeComment();
          this.typing = null;
          this.handle.focus();
          cx.stop_propagation();
          cx.notify();
        }
      })
      .child(
        h_flex()
          .h(28)
          .flex_none()
          .px(10)
          .gap(8)
          .items_center()
          .text_size(11)
          .border_b(1)
          .border_color(t.border)
          .child(div().child("Changes"))
          .child(div().text_size(10).text_color(t.muted).child(`${this.files.length} files`))
          .when(this.comments.length > 0, (e) =>
            e.child(
              div()
                .text_size(10)
                .text_color(t.accent)
                .child(
                  `${this.comments.length} ${this.comments.length === 1 ? "comment" : "comments"}`,
                ),
            ),
          )
          .child(div().flex_1())
          .child(div().text_size(11).text_color(t.ansi2).child(`+${add}`))
          .child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)),
      )
      .child(
        v_resizable("changes-split")
          .flex_1()
          .min_h(0)
          .child(
            resizable_panel()
              .size(200)
              .size_range(44)
              .child(
                v_flex()
                  .id("changes-list")
                  .size_full()
                  .p(4)
                  .when(this.files.length > 0, (el) =>
                    el.child(
                      div()
                        .relative()
                        .flex_1()
                        .min_h(0)
                        .child(
                          v_virtual_list(
                            "changes-files",
                            this.files.length,
                            26 * zoom(),
                            (i) => this.files[i].path,
                            (range) =>
                              this.files
                                .slice(range.start, range.end)
                                .map((file) => v_flex().h(26).child(this.fileRow(file, t))),
                          )
                            .size_full()
                            .on_item_click((path, cx) => this.pick(path, cx)),
                        )
                        .child(
                          Scrollbar.vertical("changes-files")
                            .viewport_from_layout()
                            .absolute()
                            .inset_0(),
                        ),
                    ),
                  )
                  .when(!this.files.length, (e) =>
                    e.child(
                      div()
                        .p(8)
                        .text_color(t.dim)
                        .child(
                          this.error ||
                            (this.loading
                              ? "Loading changes…"
                              : this.root
                                ? "No uncommitted changes"
                                : "No folder"),
                        ),
                    ),
                  )
                  .when(this.limited, (el) =>
                    el.child(
                      div()
                        .px(8)
                        .py(4)
                        .text_size(11)
                        .text_color(t.dim)
                        .child("Showing the first 1,000 changed files"),
                    ),
                  ),
              ),
          )
          .child(
            resizable_panel().child(
              div()
                .size_full()
                .relative()
                .font_family((settings().font_family as string | undefined) ?? "JetBrains Mono")
                .text_size(11)
                .child(
                  div()
                    .id("changes-diff-x")
                    .size_full()
                    .overflow_x_scrollbar()
                    .child(
                      div()
                        .w_full()
                        .min_w(this.diffWidth)
                        .h_full()
                        .when(this.rows.length > 0, (el) =>
                          el.child(
                            v_virtual_list(
                              "changes-diff",
                              this.rows.length,
                              this.target
                                ? this.rows.map(
                                    (row) => (row.kind === "compose" ? COMPOSER : 20) * zoom(),
                                  )
                                : 20 * zoom(),
                              (i) => String(i),
                              (range) =>
                                this.rows
                                  .slice(range.start, range.end)
                                  .map((row, i) => this.diffRow(row, range.start + i, t)),
                            )
                              .size_full()
                              .on_mouse_down("left", (e) => {
                                this.pressX = e.local_position?.x ?? Infinity;
                              })
                              .on_item_click((index, cx) => this.clickRow(Number(index), cx)),
                          ),
                        ),
                    ),
                )
                .child(
                  Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0(),
                )
                .when(!this.open && this.files.length > 0, (e) =>
                  e.child(
                    div()
                      .absolute()
                      .top(6)
                      .px(12)
                      .text_color(t.dim)
                      .child("Select a file to view its changes"),
                  ),
                ),
            ),
          ),
      )
      .when(Boolean(this.note), (e) =>
        e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)),
      )
      .when(this.comments.length > 0, (e) => e.child(this.reviewBar(t)));
  }

  field(id: string, input: InputState, name: Changes["typing"], t: Theme) {
    return div()
      .id(id)
      .flex_1()
      .min_w(0)
      .h(34)
      .px(10)
      .flex()
      .items_center()
      .rounded(3)
      .border_1()
      .border_color(this.typing === name ? t.accent : t.input)
      .bg(t.background)
      .cursor_text()
      .child(Input.new(input).h_full().text_size(12).text_color(t.foreground));
  }

  iconButton(id: string, label: string, enabled: boolean, action: (cx: Context) => void) {
    return button(id, svg(TRASH).size(14), action, {
      variant: "quiet",
      size: "regular",
      square: true,
      disabled: !enabled,
      tooltip: label,
    });
  }

  chooseAgent(address: string, cx: Context) {
    this.agentAddress = address;
    this.choosingAgent = false;
    cx.notify();
  }

  reviewBar(t: Theme) {
    const space = focused()?.space,
      live = agents(),
      agent = pickAgent(live, space, this.agentAddress),
      count = this.comments.length,
      enabled = Boolean(agent) && !this.sending;
    return h_flex()
      .relative()
      .flex_none()
      .p(10)
      .gap(8)
      .border_t(1)
      .border_color(t.border)
      .child(
        this.field("review-note", this.noteInput, "note", t).on_mouse_down("left", (_e, cx) =>
          cx.stop_propagation(),
        ),
      )
      .child(
        this.iconButton("review-discard", "Discard review", !this.sending, (cx) =>
          this.discardReview(cx),
        ),
      )
      .child(
        button(
          "review-agent",
          h_flex()
            .min_w(0)
            .gap(6)
            .items_center()
            .when(Boolean(agent), (e) => e.child(this.agentIcon(agent, t)))
            .child(
              div()
                .min_w(0)
                .truncate()
                .child(agent ? this.agentName(agent) : "No agent here"),
            )
            .child(svg(CHEVRON).size(12).flex_none().text_color(t.dim)),
          (cx) => {
            this.choosingAgent = true;
            cx.notify();
          },
          { size: "regular", disabled: !live.length, tooltip: "Agent to send the review to" },
        )
          .max_w(200)
          .when(this.choosingAgent, (e) => e.border_color(t.accent)),
      )
      .child(
        button(
          "review-send",
          this.sending ? "Sending…" : `Send ${count}`,
          (cx) => this.sendReview(cx),
          { variant: "primary", size: "regular", disabled: !enabled },
        ),
      )
      .when(this.choosingAgent, (e) => e.child(this.agentMenu(live, space, agent, t)));
  }

  // Agents go by their tab's name, as the tab bar shows it.
  agentName(agent: AgentInfo) {
    const tab = spaces()
      .find((space) => space.id === agent.space)
      ?.tabs.find((tab) => tab.id === agent.tab);
    return agentName(agent, tab);
  }

  agentIcon({ program }: AgentInfo, t: Theme) {
    const icon = program.icon;
    if (!icon) return div().size(14).flex_none();
    return (program.tint ? svg(icon).text_color(t.muted) : image(icon)).size(14).flex_none();
  }

  agentMenu(live: AgentInfo[], space: string | undefined, agent: AgentInfo | null, t: Theme) {
    return v_flex()
      .id("review-agents")
      .absolute()
      .bottom(54)
      .right(10)
      .w(300)
      .max_h(260)
      .overflow_y_scroll()
      .p(4)
      .rounded(3)
      .border_1()
      .border_color(t.border)
      .bg(t.raised)
      .on_mouse_down_out((_e, cx) => {
        this.choosingAgent = false;
        cx.notify();
      })
      .children(
        agentChoices(live, space).map((choice) =>
          h_flex()
            .id(`review-agent-${choice.address}`)
            .h(28)
            .flex_none()
            .px(8)
            .gap(8)
            .items_center()
            .rounded(3)
            .cursor_pointer()
            .when(choice.address === agent?.address, (e) => e.bg(t.selected))
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.chooseAgent(choice.address, cx))
            .child(this.agentIcon(choice, t))
            .child(div().min_w(0).truncate().child(this.agentName(choice)))
            .child(
              div()
                .flex_1()
                .min_w(0)
                .truncate()
                .text_right()
                .text_size(11)
                .text_color(t.dim)
                .child(
                  [choice.space === space ? null : choice.space_name, choice.status]
                    .filter(Boolean)
                    .join(" · "),
                ),
            ),
        ),
      );
  }
}
