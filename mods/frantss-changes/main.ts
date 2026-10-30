import { View, div, type Context, type AsyncContext, type Color, type FocusHandle } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
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
} from "herdr";
import { trackedPreview, untrackedPreview } from "./preview.ts";

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
interface DiffRow {
  kind: string;
  number?: number;
  text: string;
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
>;

const key = () => JSON.stringify(location());

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
] as const;
const KEPT_PLACES = 20;
// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines: string[]): DiffRow[] {
  let old = 0,
    next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) {
      old = +match[1];
      next = +match[2];
      return { kind: "@", text: line };
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

export default class Changes extends View {
  declare files: ChangedFile[];
  declare rows: DiffRow[];
  declare diffWidth: number;
  declare message: string;
  declare handle: FocusHandle;
  declare kept: Map<string, Snapshot>;
  declare input: InputState;
  declare typing: boolean;
  declare on: string | null;
  declare watched: string | null;
  declare root: string | null;
  declare context: string;
  declare limited: boolean;
  declare loading: boolean;
  declare busy: boolean;
  declare stale: boolean;
  declare error: string | null;
  declare note: string | null;
  declare open: string | null;
  declare closed: boolean;
  declare hasHead: boolean;

  init(_props: unknown, cx: AsyncContext) {
    this.files = [];
    this.rows = [];
    this.diffWidth = 0;
    this.message = "";
    this.handle = cx.focus_handle();
    this.kept = new Map();
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      this.message = this.input.value();
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => {
      this.typing = true;
      cx.notify();
    });
    this.input.on("blur", (_e, cx) => {
      this.typing = false;
      cx.notify();
    });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  watch(root: string, cx: Context) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          if (!meaningful(await watchFolder(root))) continue;
          // One refresh for a burst of saves.
          await cx.sleep(300);
          if (this.watched === root) this.refresh(cx);
        }
      } catch {
        this.watched = null;
      }
    });
  }

  refresh(cx: Context) {
    const { cwd, on } = location(),
      context = key();
    // Switch places before waiting on any git still running for the last one: its results check the place.
    if (context !== this.context) this.switchTo(context);
    if (this.loading || this.busy || !cwd) return;
    if (!shown()) {
      this.stale = true;
      return;
    }
    this.loading = true;
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
        const status = await git([
          "--no-optional-locks",
          "status",
          "--porcelain=v1",
          "-z",
          "--no-renames",
          "--untracked-files=all",
        ]);
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const stats: Record<string, FileStats> = {};
        const results =
          head.code === 0
            ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])]
            : [
                await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]),
                await git(["diff", "--numstat", "-z", "--no-renames"]),
              ];
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
            await this.load(this.open, context);
          } catch {
            if (key() === context)
              this.setLines(["Cannot preview this diff (too large or unreadable)"]);
          }
        }
      } catch (e) {
        if (key() === context) this.error = String(e);
      } finally {
        this.loading = false;
        // The place changed while git ran: refresh the one now shown.
        if (key() !== context) this.refresh(cx);
        cx.notify();
      }
    });
  }

  // Keeps what this place shows and shows what the next one showed last, or nothing yet.
  switchTo(context: string) {
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
    this.message = "";
    this.input.set_value("");
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
    }
  }

  async load(path: string, context: string) {
    const file = this.files.find((f) => f.path === path),
      root = this.root,
      on = this.on;
    if (!file) return;
    let lines: string[];
    if (file.fresh || (!this.hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch((): null => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else {
        const preview = untrackedPreview(text);
        if (preview.add !== null) file.add = preview.add;
        lines = preview.lines;
      }
    } else {
      const r = await exec(
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
      );
      if (r.code !== 0) throw new Error(r.stderr);
      lines = trackedPreview(r.stdout, Boolean(file.binary));
    }
    if (key() === context && this.open === path) this.setLines(lines);
  }

  setLines(lines: string[]) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...lines.map((line) => line.length * 7 + 50));
  }

  pick(path: string, cx: Context) {
    this.open = this.open === path ? null : path;
    this.setLines([]);
    this.note = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open)
      cx.spawn(async (cx) => {
        try {
          await this.load(path, context);
        } catch (e) {
          if (key() === context && this.open === path)
            this.note = `Cannot preview this diff (too large or unreadable): ${e}`;
        }
        cx.notify();
      });
    cx.notify();
  }

  commit(cx: Context) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== key())
      return;
    const root = this.root,
      on = this.on,
      context = this.context,
      message = this.message.trim();
    this.busy = true;
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [
          ["add", "-A"],
          ["commit", "-m", message],
        ]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context) {
          this.message = "";
          this.input.set_value("");
        }
      } catch (e) {
        if (key() === context) this.note = `Commit failed: ${e}`;
      } finally {
        this.busy = false;
        this.refresh(cx);
        cx.notify();
      }
    });
    cx.notify();
  }

  diffRow({ kind, number, text }: DiffRow, t: Theme) {
    if (kind === "@")
      return div()
        .w_full()
        .px(12)
        .h(20)
        .flex_none()
        .truncate()
        .bg(t.raised)
        .text_color(t.dim)
        .child(text);
    return h_flex()
      .w_full()
      .h(20)
      .flex_none()
      .gap(10)
      .when(kind === "+", (e) => e.bg((t.ansi2 + "18") as Color))
      .when(kind === "-", (e) => e.bg((t.ansi1 + "18") as Color))
      .child(
        div()
          .w(30)
          .flex_none()
          .text_right()
          .text_color(t.dim)
          .child(number === undefined ? "" : String(number)),
      )
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  fileRow(f: ChangedFile, t: Theme) {
    const parts = f.path.split("/"),
      name = parts.pop();
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
      .when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
  }

  render(cx: Context) {
    if (this.stale && shown()) {
      this.stale = false;
      this.refresh(cx);
    }
    if (key() !== this.context) this.refresh(cx);
    const t = theme() as Theme,
      add = this.files.reduce((n, f) => n + f.add, 0),
      del = this.files.reduce((n, f) => n + f.del, 0);
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
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
        if (e.key === "escape" && this.typing) {
          this.typing = false;
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
          .child(div().flex_1())
          .child(div().text_size(11).text_color(t.ansi2).child(`+${add}`))
          .child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)),
      )
      .child(
        v_flex()
          .id("changes-list")
          .flex_none()
          .h(Math.min(200, Math.max(44, this.files.length * 26 + 8)))
          .p(4)
          .border_b(1)
          .border_color(t.border)
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
                    26 * ((settings().zoom as number | undefined) ?? 1),
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
                  Scrollbar.vertical("changes-files").viewport_from_layout().absolute().inset_0(),
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
          ),
      )
      .when(this.limited, (el) =>
        el.child(
          div()
            .px(12)
            .py(4)
            .text_size(11)
            .text_color(t.dim)
            .child("Showing the first 1,000 changed files"),
        ),
      )
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
                  .when(this.rows.length > 0, (el) =>
                    el.child(
                      v_virtual_list(
                        "changes-diff",
                        this.rows.length,
                        20,
                        (i) => String(i),
                        (range) =>
                          this.rows
                            .slice(range.start, range.end)
                            .map((row) => this.diffRow(row, t)),
                      ).size_full(),
                    ),
                  ),
              ),
          )
          .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
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
      )
      .when(Boolean(this.note), (e) =>
        e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)),
      )
      .child(
        h_flex()
          .flex_none()
          .p(10)
          .gap(8)
          .border_t(1)
          .border_color(t.border)
          .child(
            div()
              .id("commit-message")
              .flex_1()
              .min_w(0)
              .h(34)
              .px(10)
              .flex()
              .items_center()
              .rounded(3)
              .border_1()
              .border_color(this.typing ? t.accent : t.input)
              .cursor_text()
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)),
          )
          .child(
            div()
              .id("commit")
              .h(34)
              .px(12)
              .flex()
              .items_center()
              .rounded(3)
              .bg(enabled ? t.accent : t.border)
              .text_color(enabled ? t.accent_foreground : t.muted)
              .text_size(12)
              .when(enabled, (e) => e.font_bold())
              .when(enabled, (e) => e.cursor_pointer())
              .on_click((_e, cx) => this.commit(cx))
              .child(this.busy ? "Committing…" : "Commit"),
          ),
      );
  }
}
