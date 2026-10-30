import type { Context, AsyncContext, Element, ClickEvent, MouseButtonEvent } from "gpui-kit";
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { button as sharedButton } from "./button.ts";
import { findNode, followedPlace, PANEL_MODS, type LayoutNode, type PanelId } from "./panel.ts";
import { closeTab } from "./close-tab.ts";
import {
  spaces,
  panes,
  run,
  openOverlay,
  theme,
  window,
  shared,
  layout,
  nextCommand,
  exec,
  watchFolder,
} from "herdr";

import type { SpaceInfo, TabInfo, Program } from "herdr";

// The frantss rail's thread title (a mod can't import another's code): what a program says it is
// doing in its terminal title, spinner glyphs gone; null for paths, user@host or its own name.
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

// An unnamed tab is called after its agent's thread, else its program, in lower case.
function tabName(c: TabInfo, ps = panes()) {
  if (c.named) return c.name;
  const lead = ps.find((p) => p.tab === c.id && p.program?.agent) ?? ps.find((p) => p.tab === c.id);
  return (
    threadTitle(lead?.title, lead?.program) ??
    lead?.program?.name ??
    "terminal"
  ).toLowerCase();
}

// Git's lock files come and go with every git command; counting on them alone never ends.
const meaningful = (paths: string[]) =>
  paths.some((path) => !/\/\.git\/.*\.lock$|\/node_modules\//.test(path));

// The welcome screen picks Files and Changes; custom panels stay available.
const enabledPanels = () => [
  ...((shared("workspace.panels") as string[] | null) ?? ["files", "changes"]),
  "agent-graph",
  "git-history",
  "github",
];

// The frantss rail's space name: the name you gave it, else its branch, else Herdr's.
const spaceName = (s: SpaceInfo) => (s.named ? s.name : (s.branch ?? s.name));

// Herdr's own rename prompt starts from the stored name (a number for an unnamed tab, the repo for an
// unnamed space); this one starts from the name shown. `what`: "tab" or "space".
const rename = (what: string, id: string, name: string) =>
  openOverlay({
    mod: "prompt",
    kind: "dialog",
    width: 400,
    height: 190,
    props: {
      title: `rename ${what}`,
      value: name,
      command: { name: `${what}.rename`, args: { id } },
    },
  });

export default class Toolbar extends View {
  declare panels: Record<string, string | null>;
  declare space: string;
  declare pending: { want: string | null; until: number } | null;
  // The Changes button's count: the changed files where the Changes panel looks (null: not a repository).
  declare changeCount: number | null;
  declare countedPlace: string | null;
  declare counting: boolean;
  declare watchedRoot: string | null;
  // Each local place's work tree, asked of git once (null: none). `whole`: its git folder is inside
  // it, so the watcher also sees commits and staging.
  declare trees: Map<string, { root: string; whole: boolean } | null>;
  init(_props: unknown, cx: AsyncContext) {
    this.changeCount = null;
    this.trees = new Map();
    // The watcher counts a whole local work tree when it changes; other places are counted on a timer.
    cx.timer.every(10000, (cx) => {
      if (enabledPanels().includes("changes") && !this.watchesFollowedPlace())
        this.countChanges(cx);
    });
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
    // "rename" (F2 in this layout, keys.json): rename the current tab; "rename-space" (shift-F2): its space.
    cx.spawn(async () => {
      for (;;) {
        const command = await nextCommand();
        const space = spaces().find((s) => s.active),
          tab = space?.tabs.find((c) => c.active);
        if (command === "rename" && tab) rename("tab", tab.id, tabName(tab));
        if (command === "rename-space" && space) rename("space", space.id, spaceName(space));
        if (command === "close-tab" && tab) closeTab(tab.id, tabName(tab));
      }
    });
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space: SpaceInfo, panel: LayoutNode, enabled: string[]) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : (panel.active ?? null);
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id;
      this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null,
          want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) {
            run("layout.select", { stack: "panel", child: want });
            run("layout.show", { id: "panel" });
          } else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  countChanges(cx: Context) {
    if (this.counting) return;
    const place = followedPlace(),
      placeKey = JSON.stringify(place);
    this.countedPlace = placeKey;
    if (!place.cwd) {
      this.changeCount = null;
      return;
    }
    this.counting = true;
    cx.spawn(async (cx) => {
      try {
        const git = (args: string[]) => exec("git", args, { cwd: place.cwd, on: place.on });
        // Only a local place is watched, so only its work tree is asked for.
        const known = place.on || this.trees.has(placeKey);
        const [top, status] = await Promise.all([
          known ? null : git(["rev-parse", "--show-toplevel", "--absolute-git-dir"]),
          git([
            "--no-optional-locks",
            "status",
            "--porcelain=v1",
            "-z",
            "--no-renames",
            "--untracked-files=all",
          ]),
        ]);
        if (top) {
          const [root, gitDir] = top.stdout.trim().split("\n");
          this.trees.set(
            placeKey,
            top.code === 0 ? { root, whole: gitDir.startsWith(`${root}/`) } : null,
          );
        }
        if (JSON.stringify(followedPlace()) !== placeKey) return;
        const count = status.code === 0 ? status.stdout.split("\0").filter(Boolean).length : null;
        if (count !== this.changeCount) {
          this.changeCount = count;
          cx.notify();
        }
        const tree = this.trees.get(placeKey);
        if (tree) this.watch(tree.root, cx);
      } catch {
        // The count stays as it was; the next refresh tries again.
      } finally {
        this.counting = false;
        // The place changed while git ran: count the one now followed.
        if (JSON.stringify(followedPlace()) !== placeKey) this.countChanges(cx);
      }
    });
  }

  watchesFollowedPlace() {
    const tree = this.trees.get(JSON.stringify(followedPlace()));
    return Boolean(tree?.whole) && this.watchedRoot === tree.root;
  }

  watch(root: string, cx: Context) {
    if (this.watchedRoot === root) return;
    this.watchedRoot = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watchedRoot === root) {
          if (!meaningful(await watchFolder(root))) continue;
          // One count for a burst of saves.
          await cx.sleep(300);
          if (this.watchedRoot === root) this.countChanges(cx);
        }
      } catch {
        if (this.watchedRoot === root) this.watchedRoot = null;
      }
    });
  }

  render(cx: Context) {
    const t = theme() as Record<string, `#${string}`>;
    const space = spaces().find((p) => p.active);
    const stop = (_e: ClickEvent | MouseButtonEvent, cx: Context) => cx.stop_propagation();
    const button = (
      id: string,
      label: Element | string,
      tooltip: string,
      action: (cx: Context) => unknown,
    ) => sharedButton(id, label, action, { variant: "quiet", square: true, tooltip });
    const panel = findNode(layout() as LayoutNode, "panel");
    const enabled = enabledPanels();
    this.syncPanel(space, panel, enabled);
    // Uncounted while the button is off, so turning it on counts again.
    if (!enabled.includes("changes")) this.countedPlace = null;
    else if (JSON.stringify(followedPlace()) !== this.countedPlace) this.countChanges(cx);
    const panelButton = (id: PanelId, label: string, icon: string, count = 0) => {
      const on = panel && !panel.hidden && panel.active === id;
      return (
        h_flex()
          .id(`panel-${id}`)
          .h_full()
          .px(8)
          .gap(6)
          .flex_none()
          .items_center()
          .text_size(12)
          .cursor_pointer()
          .text_color(on ? t.foreground : t.muted)
          .hover((s) => s.bg(t.hover))
          .on_mouse_down("left", stop)
          .tooltip(`⌥-click opens ${label} beside the pane`)
          .on_click((event: ClickEvent) => {
            if (event.modifiers.alt)
              run("pane.split", { direction: "right", mod: PANEL_MODS[id], props: { pane: true } });
            else if (on) run("layout.hide", { id: "panel" });
            else {
              run("layout.select", { stack: "panel", child: id });
              run("layout.show", { id: "panel" });
            }
          })
          // Herdr draws its bundled fonts at one weight, so the open panel's icon takes the accent instead.
          .child(
            svg(icon)
              .size(14)
              .when(on, (el) => el.text_color(t.accent)),
          )
          .child(label)
          .when(count > 0, (el) =>
            el.child(
              div()
                .h(14)
                .min_w(14)
                .px(3)
                .flex()
                .items_center()
                .justify_center()
                .rounded(3)
                .text_size(9)
                .bg(t.accent)
                .text_color(t.accent_foreground)
                .child(String(count)),
            ),
          )
      );
    };
    // No fill: the layout's dot texture shows through, as behind the rail. Empty space drags the window.
    return h_flex()
      .size_full()
      .min_w(0)
      .pr(10)
      .items_center()
      .justify_end()
      .when(enabled.includes("files"), (el) =>
        el.child(panelButton("files", "Files", "mods/files/file.svg")),
      )
      .when(enabled.includes("changes"), (el) =>
        el.child(
          panelButton("changes", "Changes", "mods/changes/changes.svg", this.changeCount ?? 0),
        ),
      )
      .child(panelButton("agent-graph", "Agents", "mods/agent-graph/graph.svg"))
      .child(panelButton("git-history", "History", "mods/git-history/history.svg"))
      .child(
        panelButton(
          "github",
          "GitHub",
          "mods/github/github.svg",
          // The GitHub mod publishes it.
          (shared("github-inbox-count") as number | null) ?? 0,
        ),
      )
      .when(window()?.buttons, (el) =>
        el
          .child(button("minimize", "−", "Minimize", () => run("window.minimize")).ml(3))
          .child(button("maximize", "□", "Maximize", () => run("window.maximize")))
          .child(
            button("close-window", svg("mods/pane/close.svg").size(13), "Close window", () =>
              run("window.close"),
            ),
          ),
      );
  }
}
