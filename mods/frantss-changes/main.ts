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
  TextareaState,
  Textarea,
  Scrollbar,
  v_virtual_list,
  v_resizable,
  resizable_panel,
} from "gpui-base";
import {
  spaces,
  focused,
  exec,
  readTextFile,
  watchFolder,
  theme,
  settings,
  agents,
  type AgentInfo,
  hc,
} from "herdr";
import { LINE_LIMIT, trackedPreview, untrackedPreview } from "./preview.ts";
import { expandGaps, fileLines } from "./gaps.ts";
import { button } from "./button.ts";
import { TRASH_SCRIPT } from "./trash.ts";
import { followedPlace, panelShown } from "./panel.ts";
import { treeRows, type TreeRow } from "./tree.ts";
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
  REVISION_SOURCE,
  type DiffRow,
  type Span,
} from "./highlight.ts";
import {
  SECTIONS,
  changedFiles,
  entryKey,
  parseNumstat,
  parseStatus,
  type ChangedFile,
  type Section,
} from "./status.ts";

type Theme = Record<string, Color>;

// A section's header row leads its files in the list.
type ListRow = (TreeRow<ChangedFile> | { kind: "section"; count: number }) & { section: Section };
type Snapshot = Pick<
  Changes,
  | "root"
  | "gitDir"
  | "on"
  | "hasHead"
  | "branch"
  | "upstream"
  | "ahead"
  | "behind"
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
  | "commitMessage"
  | "amending"
  | "commitDraft"
>;

const key = () => JSON.stringify(followedPlace());
const TRASH = "mods/frantss-changes/trash.svg",
  CHEVRON = "mods/workspace-chrome/chevron-down.svg",
  FOLDED = "mods/workspace-chrome/chevron-right.svg",
  LIST = "mods/frantss-changes/list.svg",
  TREE = "mods/frantss-changes/tree.svg",
  PLUS = "mods/frantss-changes/plus.svg",
  MINUS = "mods/frantss-changes/minus.svg",
  UNDO = "mods/frantss-changes/undo.svg",
  STASH = "mods/frantss-changes/archive.svg",
  POP = "mods/frantss-changes/archive-restore.svg";
// A network command fails instead of waiting for a password it cannot be given, and a pull's
// merge takes Git's message instead of waiting for an editor.
const NETWORK_GIT = ["GIT_TERMINAL_PROMPT=0", "GIT_MERGE_AUTOEDIT=no", "git"];
const SECTION_TITLE: Record<Section, string> = { staged: "Staged Changes", unstaged: "Changes" };
const TREE_SETTING = "changes-tree",
  SPLIT_SETTING = "changes-split";
// Diff rows indent their text past the line number and the hover "+".
const GUTTER = 62,
  COMPOSER = 48;
// A list row's counts column; its buttons start left of it, past the row's padding and gap, and
// a button and the discard confirm are this wide.
const COUNTS = 76,
  ACTIONS_RIGHT = 8 + COUNTS + 4,
  INDEX_ACTION = 22,
  CONFIRM = 76;
const zoom = () => (settings().zoom as number | undefined) ?? 1;

// Git's lock files come and go with every git command; refreshing on them alone never ends.
const meaningful = (paths: string[]) =>
  paths.some((path) => !/\/\.git\/.*\.lock$|\/node_modules\//.test(path));
// What a place's changes looked like when it was last shown, so switching back shows them at once
// while git refreshes them; a few places are kept.
const SNAPSHOT = [
  "root",
  "gitDir",
  "on",
  "hasHead",
  "branch",
  "upstream",
  "ahead",
  "behind",
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
  "commitMessage",
  "amending",
  "commitDraft",
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
      file.section === other.section &&
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
  declare totals: { files: ChangedFile[]; count: number; add: number; del: number } | null;
  // Show the files as a folder tree instead of a flat list; folder rows hold the collapsed paths.
  declare tree: boolean;
  declare collapsed: ReadonlySet<string>;
  // The file list's height above the diff.
  declare listSize: number;
  declare shownFiles: {
    files: ChangedFile[];
    tree: boolean;
    collapsed: ReadonlySet<string>;
    rows: ListRow[];
  } | null;
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
  declare typing: "comment" | "note" | "commit" | null;
  declare commitInput: TextareaState;
  declare commitMessage: string;
  // Amend shows the last commit's message; the message written before waits here.
  declare amending: boolean;
  declare commitDraft: string;
  // The review: comments wait here until one send gives them all to the agent.
  declare comments: ReviewComment[];
  declare reviewNote: string;
  // The line being commented on, or the comment being edited (its index).
  declare target: Target | null;
  // Where the last press in the diff landed, since a row click reports only the row.
  declare pressX: number;
  // How far left of the file list's right edge its last press landed, and its click count.
  declare pressRight: number;
  declare pressCount: number;
  // The list row whose discard waits for a second press.
  declare armed: string | null;
  declare sending: boolean;
  // The agent picked for the review; null sends to this space's latest one.
  declare agentAddress: string | null;
  declare choosingAgent: boolean;
  declare on: string | null;
  declare watched: string | null;
  declare root: string | null;
  // The repository's Git folder; with the root, looked up once per place.
  declare gitDir: string | null;
  declare context: string;
  declare limited: boolean;
  declare loading: boolean;
  declare again: boolean;
  // The git action running, if any; one runs at a time.
  declare acting: "index" | "commit" | "sync" | null;
  declare loadingRendered: boolean;
  declare watchToken: object;
  declare stale: boolean;
  declare error: string | null;
  declare note: string | null;
  declare open: string | null;
  declare closed: boolean;
  declare hasHead: boolean;
  // The branch (null when detached or before the first commit), its upstream, and how far
  // apart they are as of the last fetch.
  declare branch: string | null;
  declare upstream: string | null;
  declare ahead: number;
  declare behind: number;

  init(_props: unknown, cx: AsyncContext) {
    this.files = [];
    this.tree = localStorage.getItem(TREE_SETTING) === "true";
    this.listSize = Number(localStorage.getItem(SPLIT_SETTING)) || 200;
    this.collapsed = new Set();
    this.comments = [];
    this.reviewNote = DEFAULT_NOTE;
    this.target = null;
    this.agentAddress = null;
    this.acting = null;
    this.again = false;
    this.commitMessage = "";
    this.amending = false;
    this.commitDraft = "";
    this.pressRight = Infinity;
    this.pressCount = 0;
    this.armed = null;
    this.setLines([]);
    this.handle = cx.focus_handle();
    this.kept = new Map();
    const field = <State extends InputState | TextareaState>(
      name: Changes["typing"],
      input: State,
    ) => {
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
    this.commentInput = field("comment", InputState.new({ placeholder: "Comment" }));
    this.commentInput.on("submit", (_e, cx) => this.saveComment(cx));
    this.noteInput = field("note", InputState.new({ placeholder: "Overall note (optional)" }));
    this.noteInput.set_value(this.reviewNote);
    this.noteInput.on("change", (_e) => {
      this.reviewNote = this.noteInput.value();
    });
    this.commitInput = field(
      "commit",
      TextareaState.new({ placeholder: "Message (⌘↵ to commit)" }),
    );
    this.commitInput.set_auto_grow(1, 6);
    this.commitInput.on("change", (_e) => {
      this.commitMessage = this.commitInput.value();
    });
    this.commitInput.on("submit", (e, cx) => {
      if (e.secondary) this.commit(cx);
    });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.poll(cx));
  }

  // The watcher reports changes in the repository. Without it (a remote place, a stopped watcher,
  // no repository yet) or with a Git folder outside it (a worktree), the timer looks again.
  poll(cx: Context) {
    if (this.watched !== this.root || !this.gitDir?.startsWith(this.root + "/")) this.refresh(cx);
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
    const { cwd, on } = followedPlace(),
      context = JSON.stringify({ cwd, on });
    // Switch places before waiting on any git still running for the last one: its results check the place.
    if (context !== this.context) this.switchTo(context);
    if (!cwd) return;
    // A refresh asked for while one runs follows it, so a stage or unstage always shows.
    if (this.loading) {
      this.again = true;
      return;
    }
    this.again = false;
    if (!panelShown("changes")) {
      this.stale = true;
      return;
    }
    const previous = Object.fromEntries(SNAPSHOT.map((name) => [name, this[name]])) as Snapshot;
    this.loading = true;
    this.loadingRendered = false;
    cx.spawn(async (cx) => {
      try {
        let root = this.root,
          gitDir = this.gitDir;
        if (!root || !gitDir) {
          const top = await exec("git", ["rev-parse", "--show-toplevel", "--absolute-git-dir"], {
            cwd,
            on,
          });
          if (key() !== context) return;
          if (top.code !== 0) {
            this.root = null;
            this.gitDir = null;
            this.files = [];
            this.setLines([]);
            this.open = null;
            this.error = "Not a git repository";
            return;
          }
          [root, gitDir] = top.stdout.trim().split(/\r?\n/);
        }
        const git = (args: string[]) => exec("git", args, { cwd: root, on }),
          numstat = (...args: string[]) =>
            git(["diff", ...args, "--numstat", "-z", "--no-renames"]);
        const results = await Promise.all([
          git([
            "--no-optional-locks",
            "status",
            "--porcelain=v1",
            "-z",
            "--branch",
            "--no-renames",
            "--untracked-files=all",
          ]),
          numstat("--cached"),
          numstat(),
        ]);
        if (key() !== context) return;
        for (const result of results) if (result.code !== 0) throw new Error(result.stderr);
        const [status, staged, unstaged] = results.map((result) => result.stdout),
          { hasHead, branch, upstream, ahead, behind, entries } = parseStatus(status),
          files = changedFiles(
            entries.slice(0, 1000),
            parseNumstat(staged),
            parseNumstat(unstaged),
          );
        this.root = root;
        this.gitDir = gitDir;
        this.on = on;
        this.hasHead = hasHead;
        Object.assign(this, { branch, upstream, ahead, behind });
        this.files = files;
        this.limited = entries.length > 1000;
        this.error = null;
        this.watch(root, cx);
        // A file staged or unstaged while shown stays shown in the section it moved to.
        if (this.open && !files.some((f) => entryKey(f) === this.open)) {
          const path = this.open.slice(this.open.indexOf(":") + 1),
            moved = files.find((f) => f.path === path);
          this.open = moved ? entryKey(moved) : null;
          this.setLines([]);
        }
        // The first file's diff shows until you pick another.
        if (!this.open && !this.closed && files.length) this.open = entryKey(files[0]);
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
        const currentKey = key(),
          current = this.context === context && currentKey === context;
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
          // A discard confirmed after the files changed could discard what its row did not show.
          else this.armed = null;
          if (rowsEqual) this.rows = previous.rows;
        }
        const notify = changed || this.loadingRendered;
        this.loading = false;
        // The place changed while git ran: refresh the one now shown.
        if (currentKey !== context || this.again) this.refresh(cx);
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
    this.armed = null;
    this.watched = null;
    if (kept) Object.assign(this, kept);
    else {
      this.root = null;
      this.gitDir = null;
      this.branch = null;
      this.files = [];
      this.open = null;
      this.setLines([]);
      this.error = null;
      this.closed = false;
      this.limited = false;
      this.comments = [];
      this.reviewNote = DEFAULT_NOTE;
      this.agentAddress = null;
      this.commitMessage = "";
      this.amending = false;
      this.commitDraft = "";
    }
    this.choosingAgent = false;
    this.noteInput.set_value(this.reviewNote);
    this.commitInput.set_value(this.commitMessage);
  }

  // The staged diff runs from HEAD to the index; the unstaged one from the index to the files.
  async load(open: string, context: string, cx: Context) {
    const file = this.files.find((f) => entryKey(f) === open),
      root = this.root,
      on = this.on;
    if (!file) return;
    const { path, fresh } = file,
      staged = file.section === "staged";
    let lines: string[],
      text: string | null = null;
    if (fresh) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch((): null => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else {
        const preview = untrackedPreview(text);
        if (preview.add !== null && file.add !== preview.add) {
          file.add = preview.add;
          this.totals = null;
        }
        lines = preview.lines;
      }
    } else {
      const [r, current] = await Promise.all([
        exec(
          "git",
          [
            "diff",
            ...(staged ? ["--cached"] : []),
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
          : staged
            ? exec("git", ["show", `:${path}`], { cwd: root, on }).then(
                (r) => (r.code === 0 ? r.stdout : null),
                (): null => null,
              )
            : readTextFile(`${root}/${path}`, { on }).catch((): null => null),
      ]);
      if (r.code !== 0) throw new Error(r.stderr);
      lines = trackedPreview(r.stdout, Boolean(file.binary));
      text = current;
    }
    if (key() !== context || this.open !== open) return;
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
      this.highlight(file, rows, cx);
  }

  // Shows the plain rows first and colors them when bat answers.
  highlight({ path, fresh, section }: ChangedFile, rows: DiffRow[], cx: Context) {
    const context = this.context,
      open = this.open,
      staged = section === "staged",
      source = (script: string, ...args: string[]) =>
        exec("sh", ["-c", script, "bat", path, ...args], { cwd: this.root, on: this.on }).catch(
          (): null => null,
        );
    cx.spawn(async (cx) => {
      const [old, next] = await Promise.all([
        fresh || (staged && !this.hasHead) ? null : source(REVISION_SOURCE, staged ? "HEAD:" : ":"),
        staged ? source(REVISION_SOURCE, ":") : source(NEW_SOURCE),
      ]);
      if (key() !== context || this.open !== open || this.plainRows !== rows) return;
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
      const side = lineSide(row),
        file = this.openFile();
      if (!side || !file) return;
      this.target = {
        section: file.section,
        path: file.path,
        side,
        number: row.number,
        quote: row.text,
        index: null,
      };
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

  openFile() {
    return this.files.find((file) => entryKey(file) === this.open);
  }

  pick(open: string, cx: Context) {
    this.open = this.open === open ? null : open;
    this.closeComment();
    this.setLines([]);
    this.note = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open)
      cx.spawn(async (cx) => {
        try {
          await this.load(open, context, cx);
        } catch (e) {
          if (key() === context && this.open === open)
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
      entryKey(target) === this.open &&
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

  // Depth is the file's level in the tree; without it the row names the file's folder.
  fileRow(f: ChangedFile, t: Theme, depth?: number) {
    const parts =
        depth === undefined ? f.path.split("/") : [f.path.slice(f.path.lastIndexOf("/") + 1)],
      name = parts.pop(),
      open = entryKey(f),
      comments = this.comments.filter((comment) => entryKey(comment) === open).length;
    return h_flex()
      .id(`change-${open}`)
      .relative()
      .h(24)
      .flex_none()
      .px(8)
      .when(depth !== undefined, (e) => e.pl(8 + depth! * 14))
      .gap(8)
      .items_center()
      .rounded(3)
      .cursor_pointer()
      .text_color(this.open === open ? t.foreground : t.muted)
      .when(this.open === open, (e) => e.bg(t.selected))
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
      .when(comments > 0, (e) =>
        e.child(div().text_size(11).text_color(t.accent).child(`✎ ${comments}`)),
      )
      .child(this.counts(f, t))
      .child(this.rowActions(open, f.section, t));
  }

  // Names the file the diff below shows.
  diffHeader(f: ChangedFile, t: Theme) {
    const slash = f.path.lastIndexOf("/");
    return h_flex()
      .h(28)
      .flex_none()
      .px(10)
      .gap(8)
      .items_center()
      .text_size(12)
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .child(
            div()
              .text_color(t.dim)
              .truncate()
              .child(f.path.slice(0, slash + 1)),
          )
          .child(
            div()
              .min_w(0)
              .truncate()
              .text_color(t.foreground)
              .child(f.path.slice(slash + 1)),
          ),
      )
      .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
      .when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
  }

  folderRow(row: Extract<ListRow, { kind: "folder" }>, t: Theme) {
    const { section } = row;
    return h_flex()
      .id(`change-folder-${section}:${row.path}`)
      .relative()
      .h(24)
      .flex_none()
      .pl(8 + row.depth * 14)
      .pr(8)
      .gap(8)
      .items_center()
      .rounded(3)
      .cursor_pointer()
      .text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .child(
        svg(row.open ? CHEVRON : FOLDED)
          .size(14)
          .flex_none()
          .text_color(t.dim),
      )
      .child(div().flex_1().min_w(0).truncate().child(row.name))
      .child(this.counts(row, t))
      .child(this.rowActions(`${section}:${row.path}/`, section, t));
  }

  sectionRow({ section, count }: Extract<ListRow, { kind: "section" }>, t: Theme) {
    return h_flex()
      .id(`change-section-${section}`)
      .relative()
      .h(24)
      .flex_none()
      .px(8)
      .gap(8)
      .items_center()
      .rounded(3)
      .text_size(11)
      .text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .child(div().flex_1().min_w(0).truncate().child(SECTION_TITLE[section]))
      .child(h_flex().w(COUNTS).flex_none().justify_end().text_size(10).child(String(count)))
      .child(this.rowActions(`${section}:`, section, t));
  }

  // What discard restores for a list row in the Changes section: a file row its own file, a
  // folder row those under it, the section's row all; a conflict needs more than a restore.
  discardable(key: string) {
    if (!key.startsWith("unstaged:")) return [];
    const path = key.slice("unstaged:".length).replace(/\/$/, "");
    return this.files.filter(
      (file) =>
        file.section === "unstaged" &&
        file.status !== "U" &&
        (!path || file.path === path || file.path.startsWith(`${path}/`)),
    );
  }

  // A list row's added and deleted lines, in a column of one width so the buttons left of it
  // sit at one place.
  counts({ add, del }: { add: number; del: number }, t: Theme) {
    return h_flex()
      .w(COUNTS)
      .flex_none()
      .justify_end()
      .gap(8)
      .text_size(11)
      .when(add > 0, (e) => e.child(div().text_color(t.ansi2).child(`+${add}`)))
      .when(del > 0, (e) => e.child(div().text_color(t.ansi1).child(`−${del}`)));
  }

  // The row's buttons left of its counts: stage or unstage, and discard left of it. A list row
  // cannot take handlers, so the list's click handler finds a press over them. They show on hover
  // over the end of the name: an overlay over the row, since a row cannot style its children. An
  // armed discard shows its confirm there until the next press.
  rowActions(key: string, section: Section, t: Theme) {
    const armed = this.armed === key,
      icon = (path: string) =>
        div()
          .w(INDEX_ACTION)
          .h_full()
          .flex()
          .items_center()
          .justify_center()
          .text_color(this.acting ? t.dim : t.foreground)
          .child(svg(path).size(14));
    return div()
      .id(`actions-${key}`)
      .absolute()
      .inset_0()
      .when(!armed, (e) => e.opacity(0).hover((s) => s.opacity(1)))
      .child(
        h_flex()
          .absolute()
          .right(ACTIONS_RIGHT)
          .top(2)
          .h(20)
          .rounded(3)
          .bg(armed ? t.ansi1 : t.hover)
          .when(armed, (e) =>
            e
              .w(CONFIRM)
              .justify_center()
              .items_center()
              .text_size(11)
              .font_bold()
              .text_color(t.background)
              .child(key.endsWith(":") ? "Discard all?" : "Discard?"),
          )
          .when(!armed && this.discardable(key).length > 0, (e) => e.child(icon(UNDO)))
          .when(!armed, (e) => e.child(icon(section === "staged" ? MINUS : PLUS))),
      );
  }

  // A press over a row's right button stages or unstages what the row holds. One over its discard
  // button arms it, and a second press there, not part of a double-click, discards. Elsewhere a
  // section's row does nothing, a folder's opens or closes it, and a file's shows its diff.
  clickListRow(key: string, cx: Context) {
    const armed = this.armed === key,
      // How far the press landed left of where the buttons start; the counts are right of it.
      right = this.pressRight / zoom() - ACTIONS_RIGHT,
      over = (width: number) => right >= 0 && right <= width,
      path = key.slice(key.indexOf(":") + 1);
    this.armed = null;
    if (armed && over(CONFIRM)) {
      if (this.pressCount === 1) this.discard(this.discardable(key), cx);
      else cx.notify();
    } else if (over(INDEX_ACTION)) {
      const paths = [path.replace(/\/$/, "") || "."];
      this.run(
        [
          [
            "git",
            key.startsWith("staged:")
              ? ["reset", "-q", "--", ...paths]
              : ["add", "-A", "--", ...paths],
          ],
        ],
        cx,
      );
    } else if (over(INDEX_ACTION * 2) && this.discardable(key).length) {
      this.armed = key;
      cx.notify();
    } else if (path.endsWith("/")) this.toggleFolder(key.slice(0, -1), cx);
    else if (path) this.pick(key, cx);
    else if (armed) cx.notify();
  }

  // Untracked files go to the trash first, so a place without one discards nothing; tracked ones
  // go back to what the index holds, which keeps their staged changes.
  discard(files: ChangedFile[], cx: Context) {
    const untracked = files.filter((file) => file.fresh).map((file) => `${this.root}/${file.path}`),
      tracked = files.filter((file) => !file.fresh).map((file) => file.path),
      commands: [string, string[]][] = [];
    if (untracked.length) commands.push(["sh", ["-c", TRASH_SCRIPT, "trash", ...untracked]]);
    if (tracked.length) commands.push(["git", ["restore", "--worktree", "--", ...tracked]]);
    this.run(commands, cx);
  }

  // Runs commands in the repository one after another until one fails, then shows what they
  // changed. `done` follows when all of them succeed.
  run(
    commands: [string, string[]][],
    cx: Context,
    action: NonNullable<Changes["acting"]> = "index",
    done?: () => void,
  ) {
    const { root, on, context } = this;
    if (this.acting || !root || !commands.length) return;
    this.acting = action;
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const [command, args] of commands) {
          const r = await exec(command, args, { cwd: root, on });
          if (r.code === 127 && command === "sh")
            throw new Error("This machine has no trash command, so nothing was discarded");
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        done?.();
      } catch (e) {
        if (key() === context) this.note = String(e);
      } finally {
        this.acting = null;
        this.refresh(cx);
        cx.notify();
      }
    });
    cx.notify();
  }

  // Staged files commit alone; with none staged, every change does. Amend can also change only
  // the message.
  canCommit() {
    return (
      !this.acting &&
      Boolean(this.commitMessage.trim()) &&
      (this.amending ? this.hasHead : this.files.length > 0)
    );
  }

  // With nothing staged, Commit stages every change first.
  commitsAll() {
    return this.files.length > 0 && !this.files.some((file) => file.section === "staged");
  }

  commit(cx: Context) {
    if (!this.canCommit()) return;
    const context = this.context,
      stageAll = this.commitsAll();
    this.run(
      [
        ...(stageAll ? [["git", ["add", "-A"]] as [string, string[]]] : []),
        [
          "git",
          [
            "commit",
            "--cleanup=strip",
            ...(this.amending ? ["--amend"] : []),
            "-m",
            this.commitMessage,
          ],
        ],
      ],
      cx,
      "commit",
      () => {
        const cleared = { commitMessage: "", amending: false, commitDraft: "" };
        if (key() !== context) {
          const kept = this.kept.get(context);
          if (kept) Object.assign(kept, cleared);
          return;
        }
        Object.assign(this, cleared);
        this.commitInput.set_value("");
      },
    );
  }

  // Amend shows the last commit's message to edit; turning it off brings back the draft.
  setAmending(amending: boolean, cx: Context) {
    this.amending = amending;
    if (amending) {
      this.commitDraft = this.commitMessage;
      const { root, on, context } = this;
      cx.spawn(async (cx) => {
        const r = await exec("git", ["log", "-1", "--format=%B"], { cwd: root, on }).catch(
          (): null => null,
        );
        if (key() !== context || !this.amending || r?.code !== 0) return;
        this.commitMessage = r.stdout.trim();
        this.commitInput.set_value(this.commitMessage);
        cx.notify();
      });
    } else {
      this.commitMessage = this.commitDraft;
      this.commitDraft = "";
      this.commitInput.set_value(this.commitMessage);
    }
    cx.notify();
  }

  commitBar(t: Theme) {
    const all = this.commitsAll(),
      label = this.amending ? "Amend" : all ? "Commit all" : "Commit";
    return v_flex()
      .flex_none()
      .p(8)
      .gap(6)
      .border_b(1)
      .border_color(t.border)
      .child(
        div()
          .id("commit-message")
          .w_full()
          .px(10)
          .py(6)
          .rounded(3)
          .border_1()
          .border_color(this.typing === "commit" ? t.accent : t.input)
          .bg(t.background)
          .cursor_text()
          .child(Textarea.new(this.commitInput).w_full().text_size(12).text_color(t.foreground)),
      )
      .child(
        h_flex()
          .gap(8)
          .child(
            button(
              "commit",
              this.acting === "commit" ? "Committing…" : label,
              (cx) => this.commit(cx),
              {
                variant: "primary",
                disabled: !this.canCommit(),
                tooltip: all ? "Stage every change and commit it" : undefined,
              },
            ).flex_1(),
          )
          .child(
            button("commit-amend", "Amend", (cx) => this.setAmending(!this.amending, cx), {
              variant: "quiet",
              disabled: !this.hasHead || Boolean(this.acting),
              tooltip: this.amending ? "Stop amending" : "Amend the last commit",
            }).when(this.amending, (e) => e.text_color(t.accent)),
          )
          .when(Boolean(this.branch), (e) => e.child(this.syncButton(t))),
      );
  }

  // Sync pulls then pushes, as of a fresh fetch; a branch without an upstream publishes instead.
  sync(cx: Context) {
    this.run(
      this.upstream
        ? [
            ["env", [...NETWORK_GIT, "pull"]],
            ["env", [...NETWORK_GIT, "push"]],
          ]
        : [["env", [...NETWORK_GIT, "push", "-u", "origin", "HEAD"]]],
      cx,
      "sync",
    );
  }

  syncButton(t: Theme) {
    const syncing = this.acting === "sync",
      counts = [this.behind && `↓${this.behind}`, this.ahead && `↑${this.ahead}`].filter(Boolean);
    return button(
      "changes-sync",
      this.upstream
        ? syncing
          ? "Syncing…"
          : counts.join(" ") || "Sync"
        : syncing
          ? "Publishing…"
          : "Publish",
      (cx) => this.sync(cx),
      {
        disabled: Boolean(this.acting),
        tooltip: this.upstream
          ? `Pull and push ${this.upstream}; counts are as of the last fetch`
          : `Push ${this.branch} to origin and track it`,
      },
    ).when(counts.length > 0, (e) => e.text_color(t.accent));
  }

  // Each section's header row, then its files.
  shownRows() {
    const { files, tree, collapsed } = this,
      shown = this.shownFiles;
    if (shown?.files !== files || shown.tree !== tree || shown.collapsed !== collapsed) {
      const rows: ListRow[] = [];
      for (const section of SECTIONS) {
        const own = files.filter((file) => file.section === section);
        if (!own.length) continue;
        rows.push({ kind: "section", section, count: own.length });
        if (tree)
          for (const row of treeRows(own, collapsed, `${section}:`)) rows.push({ ...row, section });
        else for (const file of own) rows.push({ kind: "file", file, depth: 0, section });
      }
      this.shownFiles = { files, tree, collapsed, rows };
    }
    return this.shownFiles!.rows;
  }

  // A file's key is its entry key; a folder's adds a "/", which no changed file's path ends in;
  // a section's has no path.
  rowKey(row: ListRow) {
    if (row.kind === "section") return `${row.section}:`;
    if (row.kind === "folder") return `${row.section}:${row.path}/`;
    return entryKey(row.file);
  }

  setTree(tree: boolean, cx: Context) {
    this.tree = tree;
    localStorage.setItem(TREE_SETTING, String(tree));
    cx.notify();
  }

  toggleFolder(path: string, cx: Context) {
    const collapsed = new Set(this.collapsed);
    if (!collapsed.delete(path)) collapsed.add(path);
    this.collapsed = collapsed;
    cx.notify();
  }

  fileTotals() {
    if (this.totals?.files !== this.files) {
      let add = 0,
        del = 0;
      for (const file of this.files) {
        add += file.add;
        del += file.del;
      }
      // A partly staged file is in both sections but counts once.
      const count = new Set(this.files.map((file) => file.path)).size;
      this.totals = { files: this.files, count, add, del };
    }
    return this.totals;
  }

  render(cx: Context) {
    if (!panelShown("changes")) return div();
    if (this.stale) {
      this.stale = false;
      this.refresh(cx);
    }
    if (key() !== this.context) this.refresh(cx);
    if (this.loading) this.loadingRendered = true;
    const t = theme() as Theme,
      { count, add, del } = this.fileTotals(),
      rows = this.shownRows(),
      openFile = this.openFile();
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
          .child(div().text_size(10).text_color(t.muted).child(`${count} files`))
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
          .when(Boolean(this.root), (e) =>
            e
              .child(
                button(
                  "changes-stash",
                  svg(STASH).size(14),
                  (cx) => this.run([["git", ["stash", "push"]]], cx),
                  {
                    variant: "quiet",
                    square: true,
                    disabled: Boolean(this.acting) || !this.files.some((file) => !file.fresh),
                    tooltip: "Stash changes",
                  },
                ),
              )
              .child(
                button(
                  "changes-pop",
                  svg(POP).size(14),
                  (cx) => this.run([["git", ["stash", "pop"]]], cx),
                  {
                    variant: "quiet",
                    square: true,
                    disabled: Boolean(this.acting) || !this.hasHead,
                    tooltip: "Pop latest stash",
                  },
                ),
              ),
          )
          .child(
            button(
              "changes-tree",
              svg(this.tree ? LIST : TREE).size(14),
              (cx) => this.setTree(!this.tree, cx),
              {
                variant: "quiet",
                square: true,
                tooltip: this.tree ? "Show as a list" : "Show as a tree",
              },
            ),
          )
          .child(div().text_size(11).text_color(t.ansi2).child(`+${add}`))
          .child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)),
      )
      .when(Boolean(this.root), (e) => e.child(this.commitBar(t)))
      .child(
        v_resizable("changes-split")
          .flex_1()
          .min_h(0)
          // Hiding the panel drops the split, so its size is kept to start from.
          .on_resize((sizes) => {
            this.listSize = sizes[0];
            localStorage.setItem(SPLIT_SETTING, String(sizes[0]));
          })
          .child(
            resizable_panel()
              .size(this.listSize)
              .size_range(44)
              .child(
                v_flex()
                  .id("changes-list")
                  .size_full()
                  .p(4)
                  .when(this.files.length > 0, (el) =>
                    el.child(
                      // A virtual list takes no pointer handlers, so its wrapper hears where a press lands.
                      div()
                        .id("changes-files-area")
                        .relative()
                        .flex_1()
                        .min_h(0)
                        .on_mouse_down("left", (e) => {
                          this.pressRight =
                            e.local_position && e.bounds
                              ? e.bounds.width - e.local_position.x
                              : Infinity;
                          this.pressCount = e.click_count;
                        })
                        .child(
                          v_virtual_list(
                            "changes-files",
                            rows.length,
                            26 * zoom(),
                            (i) => this.rowKey(rows[i]),
                            (range) =>
                              rows.slice(range.start, range.end).map((row) =>
                                v_flex()
                                  .h(26)
                                  .child(
                                    row.kind === "section"
                                      ? this.sectionRow(row, t)
                                      : row.kind === "folder"
                                        ? this.folderRow(row, t)
                                        : this.fileRow(
                                            row.file,
                                            t,
                                            this.tree ? row.depth : undefined,
                                          ),
                                  ),
                              ),
                          )
                            .size_full()
                            .on_item_click((key, cx) => this.clickListRow(key, cx)),
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
              // The border color is the inputs' one; the theme's border is too faint to divide the list from the diff.
              v_flex()
                .size_full()
                .border_t(1)
                .border_color(t.input)
                .when(Boolean(openFile), (e) => e.child(this.diffHeader(openFile!, t)))
                .child(
                  div()
                    .flex_1()
                    .min_h(0)
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
                            .id("changes-diff-rows")
                            .on_mouse_down("left", (e) => {
                              this.pressX = e.local_position?.x ?? Infinity;
                            })
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
                                  .on_item_click((index, cx) => this.clickRow(Number(index), cx)),
                              ),
                            ),
                        ),
                    )
                    .child(
                      Scrollbar.vertical("changes-diff")
                        .viewport_from_layout()
                        .absolute()
                        .inset_0(),
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

  // Agents go by their tab's name, as the rail shows it.
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
