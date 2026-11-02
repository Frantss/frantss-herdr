import type { Context, AsyncContext, FocusHandle } from "gpui-kit";
import type { VirtualListScrollHandle as ScrollHandle } from "gpui-base";
// Context menus (Herdr's items). Opened as a popup with
// props { tab: "pane" | "terminal" | "closed" | "tab" | "space" | "global", target }.
// Keys as in menu-list.ts. An item is [label, command, args];
// a command "worktree" opens the worktree dialog instead, and "rename" Herdr's rename prompt starting
// from the tab's or space's shown name (target.name, from the frantss mods that open this menu).
// "heading" and "note" items only show text.
// An agent's pane menu starts with its actions: "reply" opens frantss-reply, "interrupt" (working
// agents only) runs hc interrupt, "copy" copies args.text, "unread" marks an idle agent unread (see
// unread.ts), and "kill" asks first. A pane that the rail shows as its whole space (target.space,
// target.spaceName, target.checkout) also gets that space's actions, after its own.
// "terminal" is for a terminal without a pane (target { terminal, cwd }), e.g. a
// sub-agent in the agent graph: a live one can be kept as a tab, a finished one removed ("remove"
// runs hc rm). A closed agent resumes only in its saved folder.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, VirtualListScrollHandle } from "gpui-base";
import type { SpaceInfo, TabInfo } from "herdr";
import {
  run,
  props,
  agents,
  closeOverlay,
  openOverlay,
  theme,
  keys,
  terminals,
  spaces,
  panes,
  exec,
} from "herdr";
import { closeTab } from "./close-tab.ts";
import { hcOrToast } from "./agent-hc.ts";
import { confirmForgetHistory, openAgentTab } from "./closed-agent-actions.ts";
import { historyArgv, resumeArgv } from "./closed.ts";
import { markUnread } from "./unread.ts";
import { paneName, tabName, setPaneName } from "./pane-names.ts";
import { button } from "./button.ts";
import { rename, spaceName } from "./space-names.ts";
import {
  listCommand,
  menuList,
  menuRow,
  scrollToKey,
  selectedKey,
  separator,
  ROW_HEIGHT,
  SEPARATOR_HEIGHT,
  type ListEntry,
} from "./menu-list.ts";

// The popup's most (mod.json's overlay, and what the frantss mods open it with).
const MENU_HEIGHT = 440;
const HEADING_HEIGHT = 20;

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s: SpaceInfo) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

// A space's checkout: "main" (a repo's own), "linked" (a worktree), or null.
async function checkout(folder: string, on: string | null) {
  const git = (args: string[]) => exec("git", args, { cwd: folder, on });
  const [top, common] = await Promise.all([
    git(["rev-parse", "--show-toplevel"]),
    git(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  ]);
  if (top.code !== 0 || common.code !== 0) return null;
  return common.stdout.trim() === `${top.stdout.trim()}/.git` ? "main" : "linked";
}

type MenuTarget = {
  id?: string;
  name?: string;
  pane?: string;
  terminal?: string;
  cwd?: string;
  space?: string;
  spaceName?: string;
  checkout?: "main" | "linked" | null;
  app?: string | null;
};
type Checkout = "main" | "linked" | null;
type MenuProps = { tab?: string; target?: MenuTarget; overlay?: string };
type MenuArgs = Partial<
  Record<
    | "terminal"
    | "cwd"
    | "text"
    | "id"
    | "pane"
    | "space"
    | "direction"
    | "to"
    | "name"
    | "app"
    | "action"
    | "what",
    string
  >
> & { pinned?: boolean };
type MenuItem = [label: string, command: string, args: MenuArgs];

const copyItems = (terminal: string, cwd: string): MenuItem[] => [
  ["Copy address", "copy", { text: terminal }],
  ["Copy folder", "copy", { text: cwd }],
];

// What the menu does to an agent, before the pane items.
const agentItems = (terminal: string, cwd: string): MenuItem[] => {
  const agent = agents().find((a) => a.address === terminal);
  return [
    ["Peek", "terminal.peek", { terminal }],
    ...(agent?.status === "idle" ? [["Mark as unread", "unread", { terminal }] as MenuItem] : []),
    ...(agent
      ? [
          [
            agent.pinned ? "Unpin" : "Pin",
            "terminal.pin",
            { terminal, pinned: !agent.pinned },
          ] as MenuItem,
        ]
      : []),
    ["Reply…", "reply", { terminal }],
    // As the rail's hover actions: only a working agent has something to interrupt.
    ...(agent?.status === "working" ? [["Interrupt", "interrupt", { terminal }] as MenuItem] : []),
    ...copyItems(terminal, cwd),
    ["Kill…", "kill", { terminal }],
  ];
};

// Without a shown name (a menu not opened by the frantss mods), Herdr's own rename.
const renameItem = (
  what: string,
  id: string,
  name: string | undefined,
  label = "Rename",
): MenuItem =>
  name === undefined ? [label, `${what}.rename`, { id }] : [label, "rename", { what, id, name }];

const worktreeItems = (space: string, git: Checkout): MenuItem[] => [
  ...(git
    ? ([
        ["New worktree", "worktree", { space, action: "new" }],
        ["Open worktree", "worktree", { space, action: "open" }],
      ] as MenuItem[])
    : []),
  ...(git === "linked"
    ? [["Remove worktree", "worktree", { space, action: "remove" }] as MenuItem]
    : []),
];

// The actions of the space a pane stands for in the rail, named after it: never the focused space.
function parentSpaceItems(tg: MenuTarget, git: Checkout): MenuItem[] {
  const space = spaces().find((s) => s.id === tg.space);
  const name = tg.spaceName ?? (space ? spaceName(space) : undefined);
  return [
    [name ? `Space: ${name}` : "Space", "heading", {}],
    renameItem("space", tg.space, name, "Rename space"),
    ["New tab", "tab.new", { space: tg.space }],
    ...worktreeItems(tg.space, git),
    ["Close space", "space.close", { id: tg.space }],
  ];
}

// A settled tab is put away on this screen and keeps running; restoring shows it in lists again.
const settleItem = (tab: TabInfo): MenuItem =>
  tab.settled
    ? ["Restore tab", "tab.unsettle", { id: tab.id }]
    : ["Settle tab", "tab.settle", { id: tab.id }];

// Items that only show text; the keys and clicks pass over them.
const choosable = (it: MenuItem) => it[1] !== "heading" && it[1] !== "note";
const itemKey = (it: MenuItem) => `${it[1]}:${it[0]}`;

export function items(p: MenuProps, git: Checkout): MenuItem[] {
  p = p ?? {};
  const tg = p.target ?? {};
  switch (p.tab) {
    case "closed":
      return [
        // History reads the terminal by its address, so it needs no folder.
        ["View history", "history", { terminal: tg.terminal, cwd: tg.cwd, name: tg.name }],
        ...(resumeArgv(tg.app)
          ? tg.cwd
            ? [["Resume…", "resume", { cwd: tg.cwd, app: tg.app }]]
            : [["Resume unavailable: no saved folder", "note", {}]]
          : []),
        ["Forget history…", "forget-history", { terminal: tg.terminal, name: tg.name }],
      ] as MenuItem[];
    case "pane": {
      // An agent, and a kept sub-agent, can go back to running without a pane: a sub-agent under
      // its parent.
      const all = terminals();
      const term = all.find((t) => t.address === tg.terminal);
      const parent = term?.parent && all.find((t) => t.address === term.parent);
      const agent = term && agents().some((a) => a.address === term.address);
      // Once they go to the program, Shift+right-click still opens this menu.
      const toProgram = term?.labels?.["herdr.right-click"] === "program";
      const pane = panes().find((p) => p.pane === tg.pane);
      const space = pane && spaces().find((s) => s.tabs.some((tab) => tab.id === pane.tab));
      const tab = space?.tabs.find((tab) => tab.id === pane.tab);
      const tabPanes = tab ? panes().filter((p) => p.tab === tab.id) : [];
      return [
        ...(agent ? agentItems(term.address, term.cwd ?? "") : []),
        ...(pane ? [["Rename pane", "rename-pane", { pane: pane.pane }]] : []),
        ...(tab ? [renameItem("tab", tab.id, tabName(tab, tabPanes, space), "Rename tab")] : []),
        // A lone pane is its tab's row in the rail, so its menu settles or restores the tab.
        ...(tab && tabPanes.length === 1 ? [settleItem(tab)] : []),
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
          : agent
            ? [["Send back", "terminal.park", { terminal: term.address }]]
            : []),
        ["Close pane", "pane.close", { pane: tg.pane }],
        ...(tg.space ? parentSpaceItems(tg, git) : []),
      ] as MenuItem[];
    }
    case "terminal": {
      const term = terminals().find((t) => t.address === tg.terminal);
      return term
        ? [
            ...agentItems(term.address, term.cwd ?? ""),
            ["Keep as tab", "terminal.keep", { terminal: term.address }],
          ]
        : [
            ...copyItems(tg.terminal, tg.cwd ?? ""),
            ["Remove", "remove", { terminal: tg.terminal }],
          ];
    }
    case "tab": {
      const tab = spaces()
        .flatMap((s) => s.tabs)
        .find((tab) => tab.id === tg.id);
      return [
        renameItem("tab", tg.id, tg.name),
        ...(tab ? [settleItem(tab)] : []),
        ["New tab", "tab.new", { space: tg.space }],
        ["Close", "tab.close", { id: tg.id }],
      ] as MenuItem[];
    }
    case "space":
      return [
        renameItem("space", tg.id, tg.name),
        ["New tab", "tab.new", { space: tg.id }],
        ...worktreeItems(tg.id, git),
        ["Close", "space.close", { id: tg.id }],
      ] as MenuItem[];
    default:
      return [
        ["New space", "space.new", {}],
        ["Keybinds", "app.help", {}],
        ["Theme: graphite", "app.theme", { name: "graphite" }],
        ["Theme: ink", "app.theme", { name: "ink" }],
        ["Theme: moss", "app.theme", { name: "moss" }],
        ["Theme: atom one dark", "app.theme", { name: "atom-one-dark" }],
      ] as MenuItem[];
  }
}

const AGENT_ICONS: Record<string, string> = {
  "terminal.peek": "mods/github/eye.svg",
  reply: "mods/github/message.svg",
  interrupt: "mods/workspace-chrome/square.svg",
  copy: "mods/workspace-chrome/files.svg",
  kill: "mods/workspace-chrome/x.svg",
  "terminal.park": "mods/workspace-chrome/pin-off.svg",
  "terminal.keep": "mods/workspace-chrome/pin.svg",
  remove: "mods/frantss-files/trash.svg",
  history: "mods/github/eye.svg",
  resume: "mods/frantss/resume.svg",
  "tab.settle": "mods/workspace-chrome/pin-off.svg",
  "tab.unsettle": "mods/github/eye.svg",
  "forget-history": "mods/frantss-files/trash.svg",
};

function menuIcon(command: string, args: MenuArgs) {
  if (command === "terminal.pin")
    return `mods/workspace-chrome/${args.pinned ? "pin" : "pin-off"}.svg`;
  if (command === "pane.split" && args.direction === "down") return "mods/frantss/split-down.svg";
  if (AGENT_ICONS[command]) return AGENT_ICONS[command];
  const name = command.endsWith(".close")
    ? "x"
    : command.endsWith(".rename") || command === "rename" || command === "rename-pane"
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
function shortcut(name: string, args: MenuArgs) {
  // `pane.split:right` binds pane.split with { direction: "right" }.
  const value = args && Object.values(args)[0];
  const k = keys().find(
    (b) => b.section === "global" && (b.action === name || b.action === `${name}:${value}`),
  );
  return k ? k.keys : "";
}

const MENU_NAMES: Record<string, string> = {
  closed: "Closed agent",
  pane: "Pane",
  terminal: "Terminal",
  tab: "Tab",
  space: "Space",
};

export default class Menu extends View {
  // The selected item's key (itemKey), so a list that grows when git answers keeps it.
  declare selected: string | null;
  declare git: Checkout;
  declare handle: FocusHandle;
  declare input: InputState;
  declare scroll: ScrollHandle;
  init(_props: unknown, cx: AsyncContext) {
    this.selected = null;
    this.git = null;
    this.handle = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    const p = props();
    if (p?.tab === "rename-pane") {
      const value = paneName(panes().find((pane) => pane.pane === p.target?.pane));
      this.input = InputState.new({ value });
      this.input.set_selected_range({ start: 0, end: value.length });
      this.input.on("submit", () => this.savePaneName());
      this.input.focus();
      return;
    }
    this.handle.focus();
    // The frantss rail hands over what it already knows (target.checkout); else ask git.
    if (p?.target?.checkout !== undefined) {
      this.git = p.target.checkout;
      return;
    }
    // A space's menu, or a pane's that carries its space's actions.
    const id = p?.tab === "space" ? p.target?.id : p?.tab === "pane" ? p.target?.space : undefined;
    const space = id && spaces().find((s) => s.id === id);
    const folder = space && place(space);
    if (folder)
      cx.spawn(async (cx) => {
        this.git = await checkout(folder, space.machine).catch((): null => null);
        cx.notify();
      });
  }

  async close() {
    this.scroll?.release();
  }

  choose(i: number, cx: Context) {
    const it = items(props(), this.git)[i];
    if (!it || !choosable(it)) return;
    closeOverlay(props()?.overlay);
    if (it[1] === "copy") cx.write_to_clipboard(it[2].text);
    else if (it[1] === "history")
      openAgentTab(it[2].cwd, historyArgv(it[2].terminal), `${it[2].name} history`);
    else if (it[1] === "resume") openAgentTab(it[2].cwd, resumeArgv(it[2].app));
    else if (it[1] === "forget-history") confirmForgetHistory(it[2].terminal, it[2].name);
    else if (it[1] === "unread") cx.spawn(() => markUnread(it[2].terminal));
    else if (it[1] === "reply")
      openOverlay({ mod: "frantss-reply", kind: "dialog", width: 480, height: 300, props: it[2] });
    else if (it[1] === "interrupt")
      cx.spawn(() => hcOrToast(["interrupt", it[2].terminal], "Could not interrupt"));
    else if (it[1] === "remove")
      cx.spawn(() => hcOrToast(["rm", it[2].terminal], "Could not remove the terminal"));
    else if (it[1] === "kill")
      openOverlay({
        mod: "confirm",
        kind: "dialog",
        width: 400,
        height: 170,
        props: {
          title: `Kill ${it[2].terminal}?`,
          detail: "Its program stops, and what it was doing is lost.",
          command: { name: "terminal.kill", args: { terminal: it[2].terminal } },
        },
      });
    else if (it[1] === "worktree")
      openOverlay({
        mod: "worktree",
        kind: "dialog",
        ...(it[2].action === "open" ? { width: 560, height: 480 } : { width: 440, height: 260 }),
        props: it[2],
      });
    else if (it[1] === "rename") rename(it[2].what as "tab" | "space", it[2].id, it[2].name);
    else if (it[1] === "rename-pane")
      openOverlay({
        mod: "frantss-menu",
        kind: "dialog",
        width: 400,
        height: 210,
        props: { tab: "rename-pane", target: { pane: it[2].pane } },
      });
    else if (it[1] === "tab.close") closeTab(it[2].id, props().target.name ?? "tab");
    else run(it[1], it[2]);
  }

  savePaneName() {
    setPaneName(props().target.pane, this.input.value());
    closeOverlay(props().overlay);
  }

  renderPaneName() {
    const t = theme() as Record<string, `#${string}`>;
    return v_flex()
      .id("rename-pane")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(16)
      .gap(12)
      .bg(t.popover)
      .text_color(t.foreground)
      .text_size(12)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        closeOverlay(props().overlay);
        cx.stop_propagation();
      })
      .child(div().text_size(15).font_semibold().child("Rename pane"))
      .child(div().child("Name"))
      .child(
        Input.new(this.input)
          .id("pane-name-input")
          .accessibility_label("Pane name")
          .h(34)
          .px(10)
          .rounded(3)
          .border_1()
          .border_color(t.accent)
          .bg(t.background)
          .text_color(t.foreground)
          .text_size(12),
      )
      .child(div().text_size(11).text_color(t.muted).child("Leave empty to use the program title."))
      .child(
        h_flex()
          .gap(8)
          .justify_end()
          .child(button("rename-cancel", "Cancel", () => closeOverlay(props().overlay)))
          .child(button("rename-save", "Save", () => this.savePaneName(), { variant: "primary" })),
      );
  }

  render(_cx: Context) {
    if (props()?.tab === "rename-pane") return this.renderPaneName();
    const t = theme() as Record<string, `#${string}`>;
    const list = items(props(), this.git);
    const keys = list.filter(choosable).map(itemKey);
    const selected = selectedKey(keys, this.selected);
    // Fixed heights: the virtual list places its rows by them.
    const row = (it: MenuItem, i: number) =>
      it[1] === "heading"
        ? h_flex()
            .h(HEADING_HEIGHT)
            .px(6)
            .pb(2)
            .items_end()
            .text_size(10)
            .text_color(t.dim)
            .role("heading")
            .accessibility_label(it[0])
            .child(div().min_w(0).truncate().child(it[0]))
        : it[1] === "note"
          ? h_flex()
              .h(ROW_HEIGHT)
              .px(6)
              .gap(8)
              .items_center()
              .text_color(t.dim)
              .accessibility_label(it[0])
              .child(
                div()
                  .w(10 + 8 + 13)
                  .flex_none(),
              )
              .child(div().flex_1().min_w(0).truncate().child(it[0]))
          : menuRow(t, {
              id: `mi-${i}`,
              label: it[0],
              selected: itemKey(it) === selected,
              position: keys.indexOf(itemKey(it)) + 1,
              size: keys.length,
              icon: svg(menuIcon(it[1], it[2])).size(13).flex_none().text_color(t.dim),
              hint: shortcut(it[1], it[2]),
            });
    const separated = (it: MenuItem, i: number) =>
      i > 0 &&
      (it[1].endsWith(".close") ||
        it[1] === "heading" ||
        (it[1] === "pane.split" && list[i - 1][1] !== "pane.split") ||
        it[1] === "kill" ||
        it[1] === "remove" ||
        it[1] === "forget-history" ||
        it[1] === "terminal.keep" ||
        (it[1] === "copy" && list[i - 1][1] !== "copy") ||
        it[1] === "app.help" ||
        (it[1] === "app.theme" && list[i - 1][1] !== "app.theme"));
    const entries: ListEntry[] = list.map((it, i) => ({
      key: itemKey(it),
      height:
        (it[1] === "heading" ? HEADING_HEIGHT : ROW_HEIGHT) +
        (separated(it, i) ? SEPARATOR_HEIGHT : 0),
      draw: () =>
        v_flex()
          .when(separated(it, i), (el) => el.child(separator(t)))
          .child(row(it, i)),
    }));
    // A popup doesn't block presses: stop them before a click lands on what is behind the menu.
    return (
      v_flex()
        .id("menu")
        .role("menu")
        .accessibility_label(`${MENU_NAMES[props()?.tab] ?? "Herdr"} menu`)
        .track_focus(this.handle)
        .w_full()
        .min_h(0)
        .p(4)
        .bg(t.popover)
        .text_size(12)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
        .on_key_down((e, cx) => {
          const command = listCommand(e, keys, selected);
          if (!command) return;
          cx.stop_propagation();
          if ("close" in command) closeOverlay(props().overlay);
          else if ("choose" in command)
            this.choose(
              list.findIndex((it) => choosable(it) && itemKey(it) === command.choose),
              cx,
            );
          else {
            this.selected = command.select;
            scrollToKey(this.scroll, entries, command.select);
            cx.notify();
          }
        })
        // Taller than the popup (a pane's menu with its space's actions), the items scroll.
        .child(
          menuList("menu-items", entries, MENU_HEIGHT - 2 * 4, this.scroll, (key, cx) =>
            this.choose(
              list.findIndex((it) => itemKey(it) === key),
              cx,
            ),
          ),
        )
    );
  }
}
