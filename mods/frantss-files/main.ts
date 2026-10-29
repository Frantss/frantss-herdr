// A lazy file browser for the focused pane's folder, with bounded read-only previews.
import {
  View,
  div,
  svg,
  image,
  type Context,
  type AsyncContext,
  type Color,
  type Element,
} from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import {
  spaces,
  panes,
  focused,
  exec,
  readTextFile,
  watchFolder,
  theme,
  settings,
  window,
  layout,
  appHome,
} from "herdr";
import { iconFile, type IconManifest } from "./icons.ts";

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
interface FileEntry {
  name: string;
  dir: boolean;
}
type Theme = Record<string, Color>;

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
  return !panel || (!panel.hidden && body?.active === "files");
}
// Git's lock files come and go with every git command; refreshing on them alone never ends.
const meaningful = (paths: string[]) =>
  paths.some((path) => !/\/\.git\/.*\.lock$|\/node_modules\//.test(path));

// Code colors from the Veist VS Code theme (its tokenColors); the rest follow the theme's text color.
// Its mint and white only read on dark, so a light theme keeps colors from its terminal palette.
const VEIST = {
  keyword: "#d32d6c",
  string: "#7ce0c3",
  comment: "#888888",
  function: "#54a6f8",
  number: "#54a6f8",
  constant: "#54a6f8",
};
const isLight = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 128;
};
const syntaxColors = (t: Theme) =>
  isLight(t.background)
    ? {
        keyword: t.ansi5,
        string: t.ansi2,
        comment: t.dim,
        function: t.ansi4,
        type: t.ansi3,
        number: t.ansi1,
        constant: t.ansi6,
      }
    : VEIST;
const LANG: Record<string, string> = {
  ts: "js",
  tsx: "js",
  mts: "js",
  cts: "js",
  jsx: "js",
  mjs: "js",
  toml: "yaml",
  jsonc: "json",
  svelte: "html",
  vue: "html",
};
const PER_FOLDER = 500,
  TOTAL = 5000;

async function directory(path: string, on: string | null): Promise<FileEntry[]> {
  if (!on && window()?.platform === "windows") {
    const r = await exec("powershell", [
      "-NoProfile",
      "-Command",
      "& { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)) } }) | ConvertTo-Json -Compress }",
      path,
    ]);
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  }
  const script =
    'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ] && [ ! -L "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  const r = await exec("sh", ["-c", script, "files", path], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"),
    out = [];
  for (let i = 0; i + 1 < fields.length; i += 2)
    out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  declare entries: Map<string, FileEntry[]>;
  declare folders: Set<string>;
  declare pending: Set<string>;
  declare marks: Record<string, string>;
  declare on: string | null;
  declare watched: string | null;
  declare root: string | null;
  declare context: string;
  declare limited: boolean;
  declare loading: boolean;
  declare stale: boolean;
  declare error: string | null;
  declare code: EditorState | null;
  declare file: string | null;
  declare fileError: string | null;
  declare icons: IconManifest | null;

  init(_props: unknown, cx: AsyncContext) {
    this.entries = new Map();
    this.folders = new Set();
    this.pending = new Set();
    this.marks = {};
    cx.spawn(async (cx) => {
      const text = await readTextFile(`${appHome()}/mods/frantss-files/material-icons.json`).catch(
        (): null => null,
      );
      this.icons = text ? JSON.parse(text) : null;
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
        if (this.watched === root) this.watched = null;
      }
    });
  }

  async loadFolder(path: string, context: string) {
    const on = this.on,
      root = this.root;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (key() !== context || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()]
      .filter(([p]) => p !== path)
      .reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(
      path,
      entries
        .slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used)))
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)),
    );
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx: Context) {
    if (this.loading) return;
    const { cwd, on } = location(),
      context = key();
    if (context !== this.context) {
      this.context = context;
      this.root = cwd;
      this.on = on;
      this.entries = new Map();
      this.folders = new Set();
      this.pending = new Set();
      this.marks = {};
      this.show(null);
      this.watched = null;
      this.error = null;
      this.limited = false;
    }
    if (!cwd) return;
    if (!shown()) {
      this.stale = true;
      return;
    }
    this.loading = true;
    this.limited = false;
    cx.spawn(async (cx) => {
      try {
        for (const path of ["", ...this.folders]) await this.loadFolder(path, context);
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(
          (): null => null,
        );
        const marks: Record<string, string> = {};
        if (top?.code === 0) {
          const status = await exec(
            "git",
            [
              "--no-optional-locks",
              "status",
              "--porcelain=v1",
              "-z",
              "--no-renames",
              "--untracked-files=normal",
            ],
            { cwd, on },
          ).catch((): null => null);
          if (status?.code === 0)
            for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
              const xy = entry.slice(0, 2);
              marks[`${top.stdout.trim()}/${entry.slice(3)}`] =
                xy === "??" || xy.includes("A")
                  ? "A"
                  : xy.includes("U")
                    ? "U"
                    : xy.includes("D")
                      ? "D"
                      : "M";
            }
        }
        if (key() !== context) return;
        this.marks = marks;
        this.error = null;
        this.watch(cwd, cx);
      } catch (e) {
        if (key() === context) this.error = String(e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  toggle(path: string, cx: Context) {
    if (this.folders.has(path)) {
      for (const folder of this.folders)
        if (folder === path || folder.startsWith(path + "/")) {
          this.folders.delete(folder);
          this.entries.delete(folder);
        }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async (cx) => {
          try {
            await this.loadFolder(path, context);
          } catch (e) {
            if (key() === context) this.error = String(e);
          } finally {
            this.pending.delete(path);
            cx.notify();
          }
        });
      }
    }
    cx.notify();
  }

  show(path: string | null, cx?: Context) {
    this.code?.release();
    this.code = null;
    this.file = path;
    this.fileError = null;
    if (!path || !cx) return;
    const context = this.context,
      root = this.root,
      on = this.on;
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || key() !== context) return;
        if (text === null) {
          this.fileError = "This file is no longer available";
          return;
        }
        if (text.includes("\0")) {
          this.fileError = "Binary file · no text preview";
          return;
        }
        const t = theme() as Theme,
          ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.code = EditorState.new({
          language: LANG[ext] ?? ext,
          readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: settings().font_family as string | undefined,
          font_size: 12,
          syntax: syntaxColors(t),
        });
      } catch {
        if (this.file === path && key() === context)
          this.fileError = "Cannot preview this file (binary, too large, or unreadable)";
      } finally {
        cx.notify();
      }
    });
  }

  rows(prefix: string, depth: number, out: Element[], t: Theme): Element[] {
    if (out.length >= TOTAL || depth > 40) return out;
    const light = isLight(t.background);
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name,
        open = this.folders.has(path),
        mark = this.marks[`${this.root}/${path}`];
      out.push(
        h_flex()
          .id(`file-${path}`)
          .h(24)
          .flex_none()
          .pl(8 + depth * 14)
          .pr(8)
          .gap(6)
          .items_center()
          .rounded(3)
          .cursor_pointer()
          .text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => (entry.dir ? this.toggle(path, cx) : this.show(path, cx)))
          .child(
            entry.dir
              ? svg(`mods/frantss-files/chevron-${open ? "down" : "right"}.svg`)
                  .size(12)
                  .flex_none()
                  .text_color(t.dim)
              : div().w(12).flex_none(),
          )
          .when(Boolean(this.icons), (el) =>
            el.child(
              image(`mods/frantss-files/icons/${iconFile(this.icons, { ...entry, open }, light)}`)
                .size(14)
                .flex_none(),
            ),
          )
          .child(div().flex_1().min_w(0).truncate().child(entry.name))
          .when(Boolean(mark), (el) =>
            el.child(
              div()
                .text_size(11)
                .text_color(
                  mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.accent,
                )
                .child(mark),
            ),
          ),
      );
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  render(cx: Context) {
    if (this.stale && shown()) {
      this.stale = false;
      this.refresh(cx);
    }
    if (key() !== this.context) this.refresh(cx);
    const t = theme() as Theme;
    return v_flex()
      .id("files")
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
          .h(28)
          .flex_none()
          .px(10)
          .gap(8)
          .items_center()
          .text_size(11)
          .border_b(1)
          .border_color(t.border)
          .when(Boolean(this.file), (el) =>
            el.child(
              div()
                .id("files-back")
                .tooltip("Back to files")
                .w(20)
                .cursor_pointer()
                .text_color(t.muted)
                .on_click((_e, cx) => {
                  this.show(null);
                  cx.notify();
                })
                .child("←"),
            ),
          )
          .child(div().child("Files"))
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_right()
              .text_color(t.dim)
              .child(this.file ?? this.root?.split(/[\\/]/).pop() ?? ""),
          ),
      )
      .when(!this.file, (el) =>
        el.child(
          v_flex()
            .id("files-tree")
            .flex_1()
            .min_h(0)
            .overflow_y_scrollbar()
            .p(4)
            .children(this.rows("", 0, [], t))
            .when(Boolean(this.error) || !this.entries.get("")?.length, (el) =>
              el.child(
                div()
                  .p(8)
                  .text_size(12)
                  .text_color(t.dim)
                  .child(
                    this.error ||
                      (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"),
                  ),
              ),
            )
            .when(this.limited, (el) =>
              el.child(
                div()
                  .p(8)
                  .text_size(11)
                  .text_color(t.dim)
                  .child("File list limited to 500 entries per folder and 5,000 total"),
              ),
            ),
        ),
      )
      .when(Boolean(this.file), (el) =>
        el.child(
          this.code
            ? Editor.new(this.code).flex_1().min_h(0)
            : div()
                .p(12)
                .text_color(t.dim)
                .child(this.fileError || "Loading file…"),
        ),
      );
  }
}
