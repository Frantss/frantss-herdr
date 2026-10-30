import type { Context, AsyncContext, Element, ClickEvent, MouseButtonEvent } from "gpui-kit";
import { View, div, svg, image } from "gpui-kit";
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

// The frantss rail's status dot: working pulses like the site's live dot, blocked faster.
const dot = (t: Record<string, `#${string}`>, status: string) =>
  div()
    .size(6)
    .rounded(3)
    .flex_none()
    .bg(t[status] ?? t.dim)
    .when(status === "working", (e) => e.loop("opacity", { from: 0.35, to: 1, period: 2400 }))
    .when(status === "blocked", (e) => e.loop("opacity", { from: 0.35, to: 1, period: 900 }));

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

export default class Tabs extends View {
  declare pressed: number | null;
  declare panels: Record<string, string | null>;
  declare space: string;
  declare pending: { want: string | null; until: number } | null;
  // The Changes button's count: the changed files where the Changes panel looks (null: not a repository).
  declare changeCount: number | null;
  declare countedPlace: string | null;
  declare counting: boolean;
  declare watchedRoot: string | null;
  init(_props: unknown, cx: AsyncContext) {
    this.pressed = null;
    this.changeCount = null;
    cx.timer.every(10000, (cx) => this.countChanges(cx));
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
        const [top, status] = await Promise.all([
          git(["rev-parse", "--show-toplevel"]),
          git([
            "--no-optional-locks",
            "status",
            "--porcelain=v1",
            "-z",
            "--no-renames",
            "--untracked-files=all",
          ]),
        ]);
        if (JSON.stringify(followedPlace()) !== placeKey) return;
        const count = status.code === 0 ? status.stdout.split("\0").filter(Boolean).length : null;
        if (count !== this.changeCount) {
          this.changeCount = count;
          cx.notify();
        }
        if (top.code === 0 && !place.on) this.watch(top.stdout.trim(), cx);
      } catch {
        // The count stays as it was; the next refresh tries again.
      } finally {
        this.counting = false;
        // The place changed while git ran: count the one now followed.
        if (JSON.stringify(followedPlace()) !== placeKey) this.countChanges(cx);
      }
    });
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
    const ps = panes();
    const t = theme() as Record<string, `#${string}`>;
    const space = spaces().find((p) => p.active);
    const shown = space?.tabs ?? [];
    const stop = (_e: ClickEvent | MouseButtonEvent, cx: Context) => cx.stop_propagation();
    const button = (
      id: string,
      label: Element | string,
      tooltip: string,
      action: (cx: Context) => unknown,
    ) =>
      sharedButton(id, label, action, { variant: "quiet", square: true, tooltip }).on_mouse_down(
        "left",
        stop,
      );
    const item = (c: TabInfo, i: number) => {
      const program = (
        ps.find((p) => p.tab === c.id && p.program?.agent) ?? ps.find((p) => p.tab === c.id)
      )?.program;
      const name = tabName(c, ps);
      // Like a rail row: the current tab is marked with ❯ and bright text rather than a raised box.
      return (
        h_flex()
          .id(`tab-${c.id}`)
          .h(24)
          .px(8)
          .gap(6)
          .rounded(3)
          .items_center()
          .flex_none()
          .text_size(12)
          .cursor_pointer()
          .text_color(c.active ? t.foreground : t.muted)
          .hover((s) => s.text_color(t.foreground))
          .child(
            div()
              .w(10)
              .flex_none()
              .text_color(t.accent)
              .child(c.active ? "❯" : ""),
          )
          .on_mouse_down("left", (e, cx) => {
            cx.stop_propagation();
            this.pressed = i;
            if (e.click_count === 2) rename("tab", c.id, name);
          })
          .on_mouse_up("left", () => {
            const from = this.pressed;
            this.pressed = null;
            if (from !== null && from !== i)
              run("tab.move", {
                id: shown[from].id,
                index: space.tabs.findIndex((x) => x.id === c.id) + 1,
              });
            else run("tab.select", { id: c.id });
          })
          .on_mouse_down("right", () =>
            openOverlay({
              mod: "frantss-menu",
              kind: "popup",
              width: 320,
              props: { tab: "tab", target: { id: c.id, space: space.id, name } },
            }),
          )
          .when(Boolean(program?.icon), (el) =>
            el.child(
              program.tint
                ? svg(program.icon).size(14).text_color(t.muted)
                : image(program.icon).size(14),
            ),
          )
          .child(div().max_w(170).truncate().child(name))
          .when(Boolean(c.zoomed), (el) =>
            el.child(
              div()
                .id(`zoomed-${c.id}`)
                .tooltip("Zoomed")
                .flex_none()
                .text_color(t.dim)
                .child(svg("mods/frantss-tabs/zoom.svg").size(12)),
            ),
          )
          // Every agent tab shows its status, idle (grey) too; a tab with no agent has none.
          .when(Boolean(c.status), (el) => el.child(dot(t, c.status)))
          // Every tab keeps room for the close button, so selecting one doesn't change its width.
          .child(
            c.active
              ? div()
                  .id(`close-${c.id}`)
                  .tooltip("Close tab")
                  .size(12)
                  .flex_none()
                  .cursor_pointer()
                  .text_color(t.dim)
                  .on_mouse_down("left", stop)
                  .on_click((_e, cx) => {
                    cx.stop_propagation();
                    closeTab(c.id, name);
                  })
                  .child(svg("mods/pane/close.svg").size(12))
              : div().size(12).flex_none(),
          )
      );
    };
    const panel = findNode(layout() as LayoutNode, "panel");
    // The welcome screen picks Files and Changes; custom panels stay available.
    const enabled = [
      ...((shared("workspace.panels") as string[] | null) ?? ["files", "changes"]),
      "agent-graph",
      "git-history",
      "github",
    ];
    this.syncPanel(space, panel, enabled);
    if (enabled.includes("changes") && JSON.stringify(followedPlace()) !== this.countedPlace)
      this.countChanges(cx);
    const panelButton = (id: PanelId, label: string, icon: string, count = 0) => {
      const on = panel && !panel.hidden && panel.active === id;
      return h_flex()
        .id(`panel-${id}`)
        .h(24)
        .px(8)
        .gap(6)
        .flex_none()
        .items_center()
        .rounded(3)
        .text_size(12)
        .cursor_pointer()
        .when(on, (el) => el.bg(t.selected))
        .text_color(on ? t.foreground : t.muted)
        .hover((s) => s.text_color(t.foreground))
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
        .child(svg(icon).size(14))
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
        );
    };
    // No fill: the layout's dot texture shows through, as behind the rail and top bar.
    return (
      h_flex()
        .size_full()
        .min_w(0)
        .px(10)
        .gap(3)
        .items_center()
        .border_b(1)
        .border_color(t.border)
        .on_mouse_up("left", () => {
          this.pressed = null;
        })
        .on_scroll_wheel((e) => {
          if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next");
        })
        // + sits in the scrolling strip, right after the last tab. A 1px rule divides one tab from the next.
        .child(
          h_flex()
            .id("tab-scroll")
            .flex_1()
            .min_w(0)
            .h_full()
            .items_center()
            .gap(3)
            .overflow_x_scrollbar()
            .children(
              shown.flatMap((c, i) =>
                i === 0 ? [item(c, i)] : [div().w(1).h(14).flex_none().bg(t.border), item(c, i)],
              ),
            )
            .child(
              button("tab-new", "+", "New tab", () =>
                openOverlay({ mod: "frantss-new-menu", kind: "popup", width: 250, height: 512 }),
              ),
            ),
        )
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
            .child(button("minimize", "−", "Minimize", () => run("window.minimize")))
            .child(button("maximize", "□", "Maximize", () => run("window.maximize")))
            .child(
              button("close-window", svg("mods/pane/close.svg").size(13), "Close window", () =>
                run("window.close"),
              ),
            ),
        )
    );
  }
}
