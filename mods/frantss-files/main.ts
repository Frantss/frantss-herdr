// A lazy file browser for the focused pane's folder. A click on a file previews it below the tree;
// the preview's pen opens it in Fresh (getfresh.dev).
import {
  View,
  div,
  svg,
  image,
  type Context,
  type AsyncContext,
  type Color,
  type Element,
  type FocusHandle,
} from "gpui-kit";
import {
  v_flex,
  h_flex,
  v_virtual_list,
  Scrollbar,
  v_resizable,
  resizable_panel,
  Button,
  Editor,
  EditorState,
  TextView,
  InputState,
  Input,
} from "gpui-base";
import {
  spaces,
  panes,
  focused,
  exec,
  readTextFile,
  writeTextFile,
  watchFolder,
  theme,
  settings,
  window,
  layout,
  appHome,
  home,
  run,
  notify,
  terminals,
} from "herdr";
import { iconFile, type IconManifest } from "./icons.ts";
import { statusMarks, type Mark } from "./status.ts";
import { daemonName, daemonRunning, freshConfig, freshTheme, FRESH_THEME } from "./fresh.ts";
import { editorLanguage, previewKind, previewText } from "./preview.ts";
import { checkName, menuItems, parentOf, type MenuItem } from "./menu.ts";

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
interface FileRow extends FileEntry {
  path: string;
  depth: number;
  open: boolean;
  mark?: Mark;
  ignored: boolean;
  // The row is the name input for a rename or a new entry.
  editing?: boolean;
}
type Theme = Record<string, Color>;
type FileSnapshot = Pick<Files, "entries" | "folders" | "marks" | "error" | "limited">;

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
const meaningful = (path: string) => !/\/\.git\/.*\.lock$|\/node_modules\//.test(path);

const isLight = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 128;
};
// Written when a daemon starts, so Fresh takes the Herdr theme active at that time.
async function writeFreshConfig(t: Theme): Promise<string> {
  const folder = `${appHome()}/frantss-files`,
    themes = `${home()}/.config/fresh/themes`,
    configPath = `${folder}/fresh-config.json`;
  await exec("mkdir", ["-p", folder, themes]);
  const replace = async (path: string, value: unknown) => {
    const text = JSON.stringify(value, null, 2) + "\n",
      old = await readTextFile(path);
    if (old !== text) await writeTextFile(path, text, old);
  };
  await replace(`${themes}/${FRESH_THEME}`, freshTheme(t, isLight(t.background)));
  await replace(configPath, freshConfig());
  return configPath;
}

const openEditorTab = (folder: string, argv: string[]) =>
  run("tab.new", { name: "editor", folder, argv });

const PEN = "mods/workspace-chrome/square-pen.svg",
  CLOSE = "mods/workspace-chrome/x.svg",
  MENU_WIDTH = 210,
  // An edit row's key: no file path holds a NUL.
  NEW_ROW = "\0new";
// macOS has trash; Linux desktops have gio. 127: neither.
const TRASH_SCRIPT =
  'if command -v trash >/dev/null; then trash "$1"; elif command -v gio >/dev/null; then gio trash -- "$1"; else exit 127; fi';
const zoom = () => (settings().zoom as number | undefined) ?? 1;

function codeView(text: string, path: string) {
  const t = theme() as Theme;
  return EditorState.new({
    language: editorLanguage(path),
    readonly: true,
    value: text,
    font_family: settings().font_family as string | undefined,
    font_size: 12,
    syntax: {
      keyword: t.ansi5,
      string: t.ansi2,
      comment: t.dim,
      function: t.ansi4,
      type: t.ansi3,
      number: t.ansi1,
      constant: t.ansi6,
    },
  });
}

const PER_FOLDER = 500,
  TOTAL = 5000,
  KEPT_PLACES = 20;

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
  declare entryCount: number;
  declare folders: Set<string>;
  declare folderChildren: Map<string, Set<string>>;
  declare rowCache: FileRow[] | null;
  declare pending: Set<string>;
  declare marks: Record<string, Mark>;
  declare on: string | null;
  declare watched: string | null;
  declare root: string | null;
  declare context: string;
  declare limited: boolean;
  declare loading: boolean;
  declare loadingRendered: boolean;
  declare stale: boolean;
  declare error: string | null;
  declare icons: IconManifest | null;
  declare generation: number;
  declare invalidated: Set<string>;
  declare fullRefresh: boolean;
  declare kept: Map<string, FileSnapshot>;
  // The previewed file: code, rendered markdown (or its source), or an image.
  declare file: string | null;
  declare fileText: string | null;
  declare fileError: string | null;
  declare code: EditorState | null;
  declare source: boolean;
  declare handle: FocusHandle;
  // The right-clicked row's menu, where it opens in the panel, and the keyboard's item.
  declare menu: { row: FileRow; x: number; y: number; at: number; confirm: boolean } | null;
  // The row a right press landed on, until the panel learns where it landed.
  declare pressed: FileRow | null;
  // A rename (path: the entry) or a new entry (path: its folder) waiting for a name.
  declare editing: { kind: "rename" | "new-file" | "new-folder"; path: string } | null;
  declare editError: string | null;
  declare nameInput: InputState;

  init(_props: unknown, cx: AsyncContext) {
    this.entries = new Map();
    this.entryCount = 0;
    this.folders = new Set();
    this.folderChildren = new Map();
    this.rowCache = null;
    this.pending = new Set();
    this.marks = {};
    this.generation = 0;
    this.invalidated = new Set();
    this.fullRefresh = false;
    this.kept = new Map();
    this.file = null;
    this.fileText = null;
    this.fileError = null;
    this.code = null;
    this.source = false;
    this.menu = null;
    this.pressed = null;
    this.editing = null;
    this.editError = null;
    this.handle = cx.focus_handle();
    this.nameInput = InputState.new({ placeholder: "Name" });
    this.nameInput.on("submit", (_e, cx) => this.applyEdit(cx));
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
    const generation = this.generation;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (generation === this.generation && this.watched === root) {
          const paths = (await watchFolder(root)).filter(meaningful);
          if (!paths.length) continue;
          await cx.sleep(300);
          if (generation !== this.generation || this.watched !== root) continue;
          this.refresh(cx, paths);
          if (this.file && paths.includes(`${root.replace(/\/+$/, "")}/${this.file}`))
            this.show(this.file, cx);
        }
      } catch {
        if (generation === this.generation && this.watched === root) this.watched = null;
      }
    });
  }

  affectedFolders(paths: string[]): Set<string> | null {
    const root = this.root.replace(/\/+$/, ""),
      prefix = root + "/",
      folders = new Set<string>();
    for (const absolute of paths) {
      if (!absolute.startsWith(prefix)) return null;
      const path = absolute.slice(prefix.length),
        parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (
        !path ||
        path.endsWith("/") ||
        path === ".git" ||
        path.startsWith(".git/") ||
        path.includes("\\") ||
        path.split("/").some((part) => part === ".." || part === ".")
      )
        return null;
      if (!this.entries.has(parent)) return null;
      folders.add(parent);
      if (this.folders.has(path)) folders.add(path);
    }
    return folders;
  }

  current(context: string, generation: number) {
    return generation === this.generation && context === this.context && key() === context;
  }

  async fetchFolder(
    path: string,
    context: string,
    generation: number,
    root: string,
    on: string | null,
  ) {
    if (!this.current(context, generation) || (path && !this.folders.has(path))) return;
    return directory(path ? `${root}/${path}` : root, on);
  }

  async loadFolder(
    path: string,
    context: string,
    generation: number,
    root: string,
    on: string | null,
  ) {
    const entries = await this.fetchFolder(path, context, generation, root, on);
    if (entries) return this.applyFolder(path, entries, context, generation);
  }

  applyFolder(path: string, entries: FileEntry[], context: string, generation: number) {
    if (!this.current(context, generation) || (path && !this.folders.has(path))) return;
    const previous = this.entries.get(path),
      used = this.entryCount - (previous?.length ?? 0),
      next = entries
        .slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used)))
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)),
      changed =
        !previous ||
        previous.length !== next.length ||
        previous.some((entry, i) => entry.name !== next[i].name || entry.dir !== next[i].dir);
    if (changed) {
      this.entries.set(path, next);
      this.entryCount = used + next.length;
      this.rowCache = null;
    }
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
    const directories = new Set(
      this.entries
        .get(path)
        .filter((entry) => entry.dir)
        .map((entry) => entry.name),
    );
    let pruned = false;
    for (const folder of (this.folderChildren ?? this.indexFolders()).get(path) ?? []) {
      const name = folder.slice(folder.lastIndexOf("/") + 1);
      if (!directories.has(name)) {
        this.closeFolder(folder);
        pruned = true;
      }
    }
    return changed || pruned;
  }

  refresh(cx: Context, changedPaths?: string[]) {
    const { cwd, on } = location(),
      context = JSON.stringify({ cwd, on });
    let changed = context !== this.context;
    if (changed) {
      const cached = this.kept.get(context);
      if (this.context && this.root) {
        this.kept.delete(this.context);
        this.kept.set(this.context, {
          entries: new Map(this.entries),
          folders: new Set(this.folders),
          marks: { ...this.marks },
          error: this.error,
          limited: this.limited,
        });
        if (this.kept.size > KEPT_PLACES) this.kept.delete(this.kept.keys().next().value);
      }
      this.generation = (this.generation ?? 0) + 1;
      this.closePreview();
      this.menu = null;
      this.editing = null;
      this.loading = false;
      this.invalidated = new Set();
      this.fullRefresh = true;
      this.context = context;
      this.root = cwd;
      this.on = on;
      this.entries = new Map(cached?.entries);
      this.entryCount = [...this.entries.values()].reduce(
        (total, entries) => total + entries.length,
        0,
      );
      this.folders = new Set(cached?.folders);
      this.indexFolders();
      this.rowCache = null;
      this.pending = new Set();
      this.marks = { ...cached?.marks };
      this.watched = null;
      this.error = cached?.error ?? null;
      this.limited = cached?.limited ?? false;
    }
    if (!cwd) return;
    const affected = changedPaths ? this.affectedFolders(changedPaths) : null;
    if (affected) for (const path of affected) this.invalidated.add(path);
    else this.fullRefresh = true;
    if (!shown()) {
      this.stale = true;
      return;
    }
    if (this.loading) return;
    const generation = this.generation,
      paths = ["", ...this.folders].filter(
        (path) => this.fullRefresh || this.invalidated.has(path),
      ),
      previousLimited = this.limited,
      previousError = this.error;
    if (this.fullRefresh) this.limited = false;
    this.fullRefresh = false;
    this.invalidated.clear();
    this.loading = true;
    this.loadingRendered = false;
    cx.spawn(async (cx) => {
      try {
        // Apply a parent before fetching descendants, so deleted folders are pruned first.
        if (paths.includes(""))
          changed = (await this.loadFolder("", context, generation, cwd, on)) || changed;
        const folders = paths.filter(Boolean);
        for (let i = 0; i < folders.length;) {
          if (!this.current(context, generation)) return;
          const first = folders[i],
            second = folders[i + 1],
            dependent =
              second && (second.startsWith(first + "/") || first.startsWith(second + "/")),
            batch = folders.slice(i, i + (dependent ? 1 : 2));
          i += batch.length;
          const results = await Promise.allSettled(
            batch.map((path) => this.fetchFolder(path, context, generation, cwd, on)),
          );
          if (!this.current(context, generation)) return;
          for (let j = 0; j < results.length; j++) {
            const result = results[j];
            if (result.status === "rejected") throw result.reason;
            if (result.value)
              changed = this.applyFolder(batch[j], result.value, context, generation) || changed;
          }
        }
        if (!this.current(context, generation)) return;
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(
          (): null => null,
        );
        if (!this.current(context, generation)) return;
        let marks: Record<string, Mark> = {};
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
              "--ignored",
            ],
            { cwd, on },
          ).catch((): null => null);
          if (status?.code === 0) marks = statusMarks(status.stdout, top.stdout.trim(), TOTAL);
        }
        if (!this.current(context, generation)) return;
        const names = Object.keys(marks);
        if (
          names.length !== Object.keys(this.marks).length ||
          names.some((name) => this.marks[name] !== marks[name])
        ) {
          this.marks = marks;
          this.rowCache = null;
          changed = true;
        }
        this.error = null;
        this.watch(cwd, cx);
      } catch (e) {
        if (this.current(context, generation)) this.error = String(e);
      } finally {
        if (generation === this.generation) {
          const notify =
            changed ||
            this.error !== previousError ||
            this.limited !== previousLimited ||
            this.loadingRendered;
          this.loading = false;
          if (key() !== context) this.refresh(cx);
          else if (this.fullRefresh || this.invalidated.size) this.refresh(cx, []);
          if (notify) cx.notify();
        }
      }
    });
  }

  indexFolders() {
    const children = new Map<string, Set<string>>();
    for (const folder of this.folders) {
      const slash = folder.lastIndexOf("/"),
        parent = slash < 0 ? "" : folder.slice(0, slash);
      if (!children.has(parent)) children.set(parent, new Set());
      children.get(parent).add(folder);
    }
    return (this.folderChildren = children);
  }

  closeFolder(path: string) {
    const children = this.folderChildren ?? this.indexFolders();
    for (const folder of this.folders)
      if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.rowCache = null;
        const slash = folder.lastIndexOf("/"),
          parent = slash < 0 ? "" : folder.slice(0, slash),
          siblings = children.get(parent);
        siblings?.delete(folder);
        if (!siblings?.size) children.delete(parent);
        children.delete(folder);
        this.entryCount -= this.entries.get(folder)?.length ?? 0;
        this.entries.delete(folder);
      }
  }

  toggle(path: string, cx: Context) {
    if (this.folders.has(path)) this.closeFolder(path);
    else {
      const children = this.folderChildren ?? this.indexFolders(),
        slash = path.lastIndexOf("/"),
        parent = slash < 0 ? "" : path.slice(0, slash);
      if (!children.has(parent)) children.set(parent, new Set());
      children.get(parent).add(path);
      this.folders.add(path);
      this.rowCache = null;
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context,
          generation = this.generation,
          root = this.root,
          on = this.on,
          pending = this.pending;
        pending.add(path);
        cx.spawn(async (cx) => {
          try {
            await this.loadFolder(path, context, generation, root, on);
          } catch (e) {
            if (this.current(context, generation)) this.error = String(e);
          } finally {
            pending.delete(path);
            if (this.current(context, generation)) cx.notify();
          }
        });
      }
    }
    cx.notify();
  }

  // Shows a file below the tree, or reloads the one shown; unchanged text keeps the view as it is.
  show(path: string, cx: Context) {
    if (path !== this.file) {
      this.closePreview();
      this.file = path;
    }
    cx.notify();
    if (previewKind(path) === "image") return;
    const context = this.context,
      generation = this.generation,
      root = this.root,
      on = this.on;
    cx.spawn(async (cx) => {
      const result = await readTextFile(`${root}/${path}`, { on }).then(previewText, () => ({
        error: "Cannot preview this file (binary, too large, or unreadable)",
      }));
      if (this.file !== path || !this.current(context, generation)) return;
      if ("error" in result) {
        if (result.error === this.fileError) return;
        this.setPreview(null, result.error);
      } else if (result.text !== this.fileText) this.setPreview(result.text, null);
      else return;
      cx.notify();
    });
  }

  setPreview(text: string | null, error: string | null) {
    this.code?.release();
    this.code = null;
    this.fileText = text;
    this.fileError = error;
    if (text !== null && (previewKind(this.file) !== "markdown" || this.source))
      this.code = codeView(text, this.file);
  }

  closePreview() {
    this.code?.release();
    this.code = null;
    this.file = null;
    this.fileText = null;
    this.fileError = null;
    this.source = false;
  }

  toggleSource(cx: Context) {
    this.source = !this.source;
    this.setPreview(this.fileText, this.fileError);
    cx.notify();
  }

  // The row handler names the row, then the panel's handler places the menu where the press landed.
  openMenu(event: import("gpui-kit").MouseButtonEvent, cx: Context) {
    const row = this.pressed;
    this.pressed = null;
    if (!row || !event.local_position || !event.bounds) {
      this.menu = null;
      cx.notify();
      return;
    }
    const scale = zoom(),
      height = menuItems(row, this.finder()).reduce((h, item) => h + (item ? 24 : 9), 8),
      x = event.local_position.x / scale,
      y = event.local_position.y / scale,
      width = event.bounds.width / scale,
      bottom = event.bounds.height / scale;
    this.menu = {
      row,
      x: Math.max(0, x + MENU_WIDTH > width ? x - MENU_WIDTH : x),
      y: Math.max(0, y + height > bottom ? y - height : y),
      at: -1,
      confirm: false,
    };
    this.handle.focus();
    cx.notify();
  }

  finder() {
    return !this.on && window()?.platform === "macos";
  }

  choose({ action }: MenuItem, cx: Context) {
    const { row } = this.menu,
      path = row.path,
      absolute = `${this.root}/${path}`;
    if (action === "trash" && !this.menu.confirm) {
      this.menu.confirm = true;
      cx.notify();
      return;
    }
    this.menu = null;
    if (action === "preview") this.show(path, cx);
    else if (action === "fresh") this.openInFresh(path, cx);
    else if (action === "toggle") this.toggle(path, cx);
    else if (action === "copy") cx.write_to_clipboard(absolute);
    else if (action === "copy-relative") cx.write_to_clipboard(path);
    else if (action === "reveal") void exec("open", ["-R", absolute]);
    else if (action === "trash") this.trash(path, cx);
    else if (action === "rename") this.startEdit("rename", path, row.name, cx);
    else this.startEdit(action, row.dir ? path : parentOf(path), "", cx);
    cx.notify();
  }

  startEdit(kind: Files["editing"]["kind"], path: string, name: string, cx: Context) {
    if (kind !== "rename" && path && !this.folders.has(path)) this.toggle(path, cx);
    this.editing = { kind, path };
    this.editError = null;
    this.nameInput.set_value(name);
    this.nameInput.focus();
    cx.notify();
  }

  cancelEdit(cx: Context) {
    this.editing = null;
    this.editError = null;
    this.handle.focus();
    cx.notify();
  }

  // Names are checked against the folder's entries first; the shell still refuses to overwrite.
  applyEdit(cx: Context) {
    if (!this.editing) return;
    const { kind, path } = this.editing,
      name = this.nameInput.value().trim(),
      folder = kind === "rename" ? parentOf(path) : path,
      old = kind === "rename" ? path.slice(path.lastIndexOf("/") + 1) : null;
    if (name === old) return this.cancelEdit(cx);
    const siblings = (this.entries.get(folder) ?? []).map((entry) => entry.name);
    this.editError = checkName(name, siblings);
    if (this.editError) return cx.notify();
    const relative = folder ? `${folder}/${name}` : name,
      target = `${this.root}/${relative}`,
      source = `${this.root}/${path}`,
      on = this.on;
    cx.spawn(async (cx) => {
      const r = await (
        kind === "new-folder"
          ? exec("mkdir", [target], { on })
          : kind === "new-file"
            ? exec("sh", ["-c", '[ -e "$1" ] && exit 17; : > "$1"', "new", target], { on })
            : exec("mv", ["-n", source, target], { on })
      ).catch((e): { code: number; stderr: string } => ({ code: 1, stderr: String(e) }));
      if (r.code !== 0) {
        this.editError = r.stderr.trim() || `Cannot create ${name}`;
        cx.notify();
        return;
      }
      if (kind === "rename") {
        this.closeFolder(path);
        if (this.file === path) this.show(relative, cx);
        else if (this.file?.startsWith(path + "/")) this.closePreview();
      } else if (kind === "new-file") this.show(relative, cx);
      this.editing = null;
      this.handle.focus();
      this.refresh(cx, kind === "rename" ? [source, target] : [target]);
      cx.notify();
    });
  }

  trash(path: string, cx: Context) {
    const absolute = `${this.root}/${path}`;
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", TRASH_SCRIPT, "trash", absolute], { on: this.on }).catch(
        (): null => null,
      );
      if (!r || r.code !== 0) {
        notify({
          title: `Cannot move ${path} to the Trash`,
          body: r?.code === 127 ? "This machine has no trash command." : r?.stderr.trim() || "",
          level: "error",
        });
        return;
      }
      if (this.file === path || this.file?.startsWith(path + "/")) this.closePreview();
      this.closeFolder(path);
      this.refresh(cx, [absolute]);
      cx.notify();
    });
  }

  // A rename shows its row as the name input; a new entry's input opens its folder's list.
  withEdit(rows: FileRow[]): FileRow[] {
    const editing = this.editing;
    if (!editing) return rows;
    if (editing.kind === "rename")
      return rows.map((row) => (row.path === editing.path ? { ...row, editing: true } : row));
    const at = editing.path ? rows.findIndex((row) => row.path === editing.path) : -1;
    if (editing.path && at < 0) return rows;
    const shown = [...rows];
    shown.splice(at + 1, 0, {
      name: "",
      dir: editing.kind === "new-folder",
      path: NEW_ROW,
      depth: at < 0 ? 0 : rows[at].depth + 1,
      open: false,
      ignored: false,
      editing: true,
    });
    return shown;
  }

  // A running daemon takes the file without a terminal; then its tab is shown, or a new tab attaches.
  // Without a daemon, open-file in a new tab starts one and stays attached.
  openInFresh(path: string, cx: Context) {
    const root = this.root,
      on = this.on,
      file = `${root}/${path}`,
      name = daemonName(root);
    cx.spawn(async () => {
      const fresh = (args: string[]) =>
        exec("fresh", ["--cmd", "daemon", ...args], { cwd: root, on }).catch((): null => null);
      const list = await fresh(["list"]);
      if (!list) {
        notify({
          title: "Fresh is not installed",
          body: "Install it with `brew install fresh-editor` to open files.",
          level: "error",
        });
        return;
      }
      if (!daemonRunning(list.stdout, name)) {
        const config = await writeFreshConfig(theme() as Theme).catch((): null => null);
        openEditorTab(root, [
          "fresh",
          ...(config ? ["--config", config] : []),
          "--cmd",
          "daemon",
          "open-file",
          name,
          file,
        ]);
        return;
      }
      await fresh(["open-file", name, file]);
      // The foreground program, because a shell wrapper's argv still names the daemon after Fresh quits.
      const client = terminals().find(
        (t) => t.state === "live" && (t.foreground?.argv ?? t.argv ?? []).includes(name),
      );
      if (client) run("pane.focus", { terminal: client.address });
      else openEditorTab(root, ["fresh", "-a", name]);
    });
  }

  // Ignored directories dim their descendants too, including rows outside the viewport.
  rows(): FileRow[] {
    return (this.rowCache ??= this.appendRows("", 0, [], false));
  }

  appendRows(prefix: string, depth: number, out: FileRow[], inIgnored: boolean): FileRow[] {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name,
        open = this.folders.has(path),
        mark = this.marks[`${this.root}/${path}`],
        ignored = inIgnored || mark === "I";
      out.push({ ...entry, path, depth, open, mark, ignored });
      if (entry.dir && open) this.appendRows(path, depth + 1, out, ignored);
    }
    return out;
  }

  row(
    { name, dir, path, depth, open, mark, ignored, editing }: FileRow,
    t: Theme,
    light: boolean,
  ): Element {
    return h_flex()
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
      .when(path === this.file, (e) => e.bg(t.selected).text_color(t.foreground))
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .child(
        dir
          ? svg(`mods/frantss-files/chevron-${open ? "down" : "right"}.svg`)
              .size(12)
              .flex_none()
              .text_color(t.dim)
          : div().w(12).flex_none(),
      )
      .when(Boolean(this.icons), (el) =>
        el.child(
          image(`mods/frantss-files/icons/${iconFile(this.icons, { name, dir, open }, light)}`)
            .size(14)
            .flex_none(),
        ),
      )
      .child(
        editing
          ? div()
              .flex_1()
              .min_w(0)
              .h(20)
              .px(4)
              .flex()
              .items_center()
              .rounded(3)
              .border_1()
              .border_color(this.editError ? t.ansi1 : t.accent)
              .bg(t.background)
              .cursor_text()
              .child(Input.new(this.nameInput).h_full().text_size(12).text_color(t.foreground))
          : div()
              .flex_1()
              .min_w(0)
              .truncate()
              .when(ignored, (el) => el.text_color(t.dim))
              .child(name),
      )
      .when(Boolean(mark) && mark !== "I", (el) =>
        el.child(
          div()
            .text_size(11)
            .text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.accent)
            .child(mark),
        ),
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
      rows = this.withEdit(this.rows()),
      light = isLight(t.background);
    const tree = v_flex()
      .id("files-tree")
      .flex_1()
      .min_h(0)
      .p(4)
      .when(rows.length > 0, (el) =>
        el.child(
          div()
            .relative()
            .flex_1()
            .min_h(0)
            .child(
              v_virtual_list(
                "files-rows",
                rows.length,
                24 * zoom(),
                (i) => rows[i].path,
                (range) => rows.slice(range.start, range.end).map((row) => this.row(row, t, light)),
              )
                .size_full()
                .on_item_click((path, cx) => {
                  const row = rows.find((row) => row.path === path);
                  if (!row || row.editing) return;
                  if (row.dir) this.toggle(path, cx);
                  else this.show(path, cx);
                })
                .on_item_secondary_click((path) => {
                  const row = rows.find((row) => row.path === path);
                  this.pressed = row && !row.editing ? row : null;
                }),
            )
            .child(Scrollbar.vertical("files-rows").viewport_from_layout().absolute().inset_0()),
        ),
      )
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
      )
      .when(Boolean(this.editing && this.editError), (el) =>
        el.child(div().px(8).py(4).text_size(11).text_color(t.ansi1).child(this.editError)),
      );
    return v_flex()
      .id("files")
      .relative()
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e.key, cx))
      .on_mouse_down("right", (e, cx) => this.openMenu(e, cx))
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
          .child(div().child("Files"))
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_right()
              .text_color(t.dim)
              .child(this.root?.split(/[\\/]/).pop() ?? ""),
          ),
      )
      .child(
        this.file
          ? v_resizable("files-split")
              .flex_1()
              .min_h(0)
              .child(
                resizable_panel().size(240).size_range(80).child(v_flex().size_full().child(tree)),
              )
              .child(resizable_panel().child(this.preview(t)))
          : tree,
      )
      .when(Boolean(this.menu), (e) => e.child(this.contextMenu(t)));
  }

  // The menu takes ↑/↓, Enter and Esc; Esc also leaves a name input.
  key(key: string, cx: Context) {
    const menu = this.menu;
    if (menu) {
      const items = menuItems(menu.row, this.finder()).filter(Boolean);
      if (key === "down") menu.at = (menu.at + 1) % items.length;
      else if (key === "up") menu.at = (menu.at + items.length - 1) % items.length;
      else if (key === "enter" && menu.at >= 0) return this.choose(items[menu.at], cx);
      else if (key === "escape") this.menu = null;
      else return;
      cx.notify();
    } else if (key === "escape" && this.editing) this.cancelEdit(cx);
  }

  contextMenu(t: Theme) {
    const { row, x, y, at, confirm } = this.menu;
    let index = -1;
    return (
      v_flex()
        .id("files-menu")
        .absolute()
        .left(x)
        .top(y)
        .w(MENU_WIDTH)
        .p(4)
        .rounded(3)
        .border_1()
        .border_color(t.border)
        .bg(t.popover ?? t.raised)
        .text_size(12)
        // A right press reopens or closes the menu through the panel's own handler.
        .on_mouse_down_out((e, cx) => {
          if (e.button === "right") return;
          this.menu = null;
          cx.notify();
        })
        .children(
          menuItems(row, this.finder()).map((item) => {
            if (!item) return div().mx(4).my(4).h(1).bg(t.border);
            const i = ++index,
              danger = item.action === "trash";
            return h_flex()
              .id(`files-menu-${item.action}`)
              .h(24)
              .px(6)
              .gap(8)
              .rounded(3)
              .items_center()
              .cursor_pointer()
              .text_color(danger && confirm ? t.ansi1 : i === at ? t.foreground : t.muted)
              .when(i === at, (e) => e.bg(t.selected))
              .hover((s) => s.bg(t.hover).text_color(danger && confirm ? t.ansi1 : t.foreground))
              .on_click((_e, cx) => this.choose(item, cx))
              .child(
                svg(item.icon)
                  .size(13)
                  .flex_none()
                  .text_color(danger ? t.ansi1 : t.dim),
              )
              .child(
                div()
                  .flex_1()
                  .min_w(0)
                  .truncate()
                  .child(danger && confirm ? "Click again to move to Trash" : item.label),
              );
          }),
        )
    );
  }

  iconButton(id: string, label: string, icon: string, action: (cx: Context) => void, t: Theme) {
    return Button.new(id)
      .size(22)
      .flex()
      .flex_none()
      .items_center()
      .justify_center()
      .rounded(3)
      .cursor_pointer()
      .text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(label)
      .accessibility_label(label)
      .on_click((_e, cx) => action(cx))
      .child(svg(icon).size(14));
  }

  preview(t: Theme) {
    const path = this.file,
      kind = previewKind(path),
      slash = path.lastIndexOf("/");
    return v_flex()
      .size_full()
      .border_t(1)
      .border_color(t.border)
      .child(
        h_flex()
          .h(30)
          .flex_none()
          .pl(10)
          .pr(4)
          .gap(4)
          .items_center()
          .text_size(11)
          .border_b(1)
          .border_color(t.border)
          .child(
            h_flex()
              .flex_1()
              .min_w(0)
              .overflow_hidden()
              .child(
                div()
                  .min_w(0)
                  .truncate()
                  .text_color(t.dim)
                  .child(path.slice(0, slash + 1)),
              )
              .child(
                div()
                  .flex_none()
                  .child(path.slice(slash + 1)),
              ),
          )
          .when(kind === "markdown" && this.fileText !== null, (e) =>
            e.child(
              Button.new("files-source")
                .h(22)
                .px(6)
                .flex()
                .flex_none()
                .items_center()
                .rounded(3)
                .cursor_pointer()
                .text_color(t.muted)
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .on_click((_e, cx) => this.toggleSource(cx))
                .child(this.source ? "Rendered" : "Source"),
            ),
          )
          .child(
            this.iconButton(
              "files-fresh",
              "Open in Fresh",
              PEN,
              (cx) => this.openInFresh(path, cx),
              t,
            ),
          )
          .child(
            this.iconButton(
              "files-close",
              "Close preview",
              CLOSE,
              (cx) => {
                this.closePreview();
                cx.notify();
              },
              t,
            ),
          ),
      )
      .child(this.previewBody(path, kind, t));
  }

  previewBody(path: string, kind: ReturnType<typeof previewKind>, t: Theme) {
    const message = (text: string) => div().p(12).text_size(12).text_color(t.dim).child(text);
    if (kind === "image")
      return this.on
        ? message("Images on another machine cannot be previewed")
        : div()
            .flex_1()
            .min_h(0)
            .p(12)
            .flex()
            .items_center()
            .justify_center()
            .child(image(`${this.root}/${path}`).max_w_full().max_h_full());
    if (this.fileError) return message(this.fileError);
    if (this.code) return Editor.new(this.code).flex_1().min_h(0);
    if (kind === "markdown" && this.fileText !== null)
      return TextView.markdown("files-markdown", this.fileText)
        .selectable(true)
        .scrollable(true)
        .flex_1()
        .min_h(0)
        .px(14)
        .py(10);
    return message("Loading file…");
  }
}
