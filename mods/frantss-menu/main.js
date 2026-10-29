// Context menus (Herdr's items). Opened as a popup with
// props { tab: "pane" | "tab" | "space" | "global", target }.
// ↑/↓ move, Enter runs, Esc closes. An item is [label, command, args];
// a command "worktree" opens the worktree dialog instead, and "rename" Herdr's rename prompt starting
// from the tab's or space's shown name (target.name, from the frantss mods that open this menu).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  run,
  props,
  closeOverlay,
  openOverlay,
  theme,
  keys,
  terminals,
  spaces,
  panes,
  exec,
} from "herdr";

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

// A space's checkout: "main" (a repo's own), "linked" (a worktree), or null.
async function checkout(folder, on) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, on });
  const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: folder,
    on,
  });
  if (top.code !== 0 || common.code !== 0) return null;
  return common.stdout.trim() === `${top.stdout.trim()}/.git` ? "main" : "linked";
}

// Without a shown name (a menu not opened by the frantss mods), Herdr's own rename.
const renameItem = (what, tg) =>
  tg.name === undefined
    ? ["Rename", `${what}.rename`, { id: tg.id }]
    : ["Rename", "rename", { what, id: tg.id, name: tg.name }];

function items(p, git) {
  p = p ?? {};
  const tg = p.target ?? {};
  switch (p.tab) {
    case "pane": {
      // A kept sub-agent can go back under its parent, still running.
      const all = terminals();
      const term = all.find((t) => t.address === tg.terminal);
      const parent = term?.parent && all.find((t) => t.address === term.parent);
      // Once they go to the program, Shift+right-click still opens this menu.
      const toProgram = term?.labels?.["herdr.right-click"] === "program";
      return [
        ["Split right", "pane.split", { direction: "right", pane: tg.pane }],
        ["Split down", "pane.split", { direction: "down", pane: tg.pane }],
        ["Zoom", "pane.zoom", { pane: tg.pane }],
        ...(term
          ? [
              toProgram
                ? [
                    "Use Herdr right-click menu",
                    "terminal.right_click",
                    { terminal: term.address, to: "menu" },
                  ]
                : [
                    "Send right-clicks to pane",
                    "terminal.right_click",
                    { terminal: term.address, to: "program" },
                  ],
            ]
          : []),
        ...(parent
          ? [
              [
                `Send back to ${parent.name || parent.address}`,
                "terminal.park",
                { terminal: term.address },
              ],
            ]
          : []),
        ["Close pane", "pane.close", { pane: tg.pane }],
      ];
    }
    case "tab":
      return [
        renameItem("tab", tg),
        ["New tab", "tab.new", { space: tg.space }],
        ["Close", "tab.close", { id: tg.id }],
      ];
    case "space":
      return [
        renameItem("space", tg),
        ...(git
          ? [
              ["New worktree", "worktree", { space: tg.id, action: "new" }],
              ["Open worktree", "worktree", { space: tg.id, action: "open" }],
            ]
          : []),
        ...(git === "linked"
          ? [["Remove worktree", "worktree", { space: tg.id, action: "remove" }]]
          : []),
        ["Close", "space.close", { id: tg.id }],
      ];
    default:
      return [
        ["New space", "space.new", {}],
        ["Keybinds", "app.help", {}],
        ["Theme: graphite", "app.theme", { name: "graphite" }],
        ["Theme: ink", "app.theme", { name: "ink" }],
        ["Theme: moss", "app.theme", { name: "moss" }],
        ["Theme: atom one dark", "app.theme", { name: "atom-one-dark" }],
      ];
  }
}

function menuIcon(command) {
  const name = command.endsWith(".close")
    ? "x"
    : command.endsWith(".rename") || command === "rename"
      ? "square-pen"
      : command.endsWith(".new")
        ? "plus"
        : command === "worktree"
          ? "git-branch"
          : command === "app.help"
            ? "terminal"
            : command === "app.theme"
              ? "settings"
              : command === "pane.split"
                ? "panel-right"
                : command === "pane.zoom"
                  ? "square"
                  : "terminal";
  return `mods/workspace-chrome/${name}.svg`;
}

// The key bound to a command, for the hint on the right.
function shortcut(name, args) {
  // `pane.split:right` binds pane.split with { direction: "right" }.
  const value = args && Object.values(args)[0];
  const k = keys().find(
    (b) => b.section === "global" && (b.action === name || b.action === `${name}:${value}`),
  );
  return k ? k.keys : "";
}

export default class Menu extends View {
  init(_props, cx) {
    this.at = 0;
    this.git = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
    const p = props();
    // The frantss rail hands over what it already knows (target.checkout); else ask git.
    if (p?.target?.checkout !== undefined) {
      this.git = p.target.checkout;
      return;
    }
    const space = p?.tab === "space" && spaces().find((s) => s.id === p.target?.id);
    const folder = space && place(space);
    if (folder)
      cx.spawn(async (cx) => {
        this.git = await checkout(folder, space.machine).catch(() => null);
        cx.notify();
      });
  }

  choose(i, _cx) {
    const it = items(props(), this.git)[i];
    if (!it) return;
    closeOverlay(props()?.overlay);
    if (it[1] === "worktree")
      openOverlay({
        mod: "worktree",
        kind: "dialog",
        ...(it[2].action === "open" ? { width: 560, height: 480 } : { width: 440, height: 260 }),
        props: it[2],
      });
    else if (it[1] === "rename")
      openOverlay({
        mod: "prompt",
        kind: "dialog",
        width: 400,
        height: 190,
        props: {
          title: `rename ${it[2].what}`,
          value: it[2].name,
          command: { name: `${it[2].what}.rename`, args: { id: it[2].id } },
        },
      });
    else run(it[1], it[2]);
  }

  render(_cx) {
    const t = theme();
    const list = items(props(), this.git);
    return v_flex()
      .id("menu")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(4)
      .bg(t.popover)
      .text_size(12)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(this.at, cx);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .children(
        list.map((it, i) =>
          v_flex()
            .when(
              i > 0 &&
                (it[1].endsWith(".close") ||
                  it[1] === "app.help" ||
                  (it[1] === "app.theme" && list[i - 1][1] !== "app.theme")),
              (el) => el.child(div().mx(4).my(4).h(1).bg(t.border)),
            )
            .child(
              h_flex()
                .id(`mi-${i}`)
                .h(24)
                .px(6)
                .gap(8)
                .rounded(3)
                .items_center()
                .justify_between()
                .text_color(i === this.at ? t.foreground : t.muted)
                .when(i === this.at, (el) => el.bg(t.selected))
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .cursor_pointer()
                .on_click((_e, cx) => this.choose(i, cx))
                .child(
                  div()
                    .w(10)
                    .flex_none()
                    .text_color(t.accent)
                    .child(i === this.at ? "❯" : ""),
                )
                .child(svg(menuIcon(it[1])).size(13).flex_none().text_color(t.dim))
                .child(div().flex_1().min_w(0).truncate().child(it[0]))
                .child(
                  div().flex_none().text_size(11).text_color(t.dim).child(shortcut(it[1], it[2])),
                ),
            ),
        ),
      );
  }
}
