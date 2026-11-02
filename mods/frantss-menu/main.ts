import type { Context, AsyncContext, FocusHandle } from "gpui-kit";
// Context menus (Herdr's items). Opened as a popup with
// props { tab: "pane" | "terminal" | "closed" | "tab" | "space" | "global", target }.
// ↑/↓ move, Enter runs, Esc closes. An item is [label, command, args];
// a command "worktree" opens the worktree dialog instead, and "rename" Herdr's rename prompt starting
// from the tab's or space's shown name (target.name, from the frantss mods that open this menu).
// An agent's pane menu starts with its actions: "reply" opens frantss-reply, "interrupt" runs
// hc interrupt, "copy" copies args.text, "unread" marks an idle agent unread (see unread.ts), and
// "kill" asks first. "terminal" is for a terminal without a pane (target { terminal, cwd }), e.g. a
// sub-agent in the agent graph: a live one can be kept as a tab, a finished one removed ("remove"
// runs hc rm).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
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

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s: import("herdr").SpaceInfo) {
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

// Without a shown name (a menu not opened by the frantss mods), Herdr's own rename.
type MenuTarget = {
  id?: string;
  name?: string;
  pane?: string;
  terminal?: string;
  cwd?: string;
  space?: string;
  checkout?: "main" | "linked" | null;
  app?: string | null;
};
type MenuProps = { tab?: string; target?: MenuTarget; overlay?: string };
type MenuItem = [label: string, command: string, args: Record<string, string>];

const copyItems = (terminal: string, cwd: string): MenuItem[] => [
  ["Copy address", "copy", { text: terminal }],
  ["Copy folder", "copy", { text: cwd }],
];

// What the menu does to an agent, before the pane items.
const agentItems = (terminal: string, cwd: string): MenuItem[] => [
  ["Peek", "terminal.peek", { terminal }],
  ...(agents().find((a) => a.address === terminal)?.status === "idle"
    ? [["Mark as unread", "unread", { terminal }] as MenuItem]
    : []),
  ["Reply…", "reply", { terminal }],
  ["Interrupt", "interrupt", { terminal }],
  ...copyItems(terminal, cwd),
  ["Kill…", "kill", { terminal }],
];

const renameItem = (what: string, tg: MenuTarget): MenuItem =>
  tg.name === undefined
    ? ["Rename", `${what}.rename`, { id: tg.id }]
    : ["Rename", "rename", { what, id: tg.id, name: tg.name }];

export function items(p: MenuProps, git: "main" | "linked" | null): MenuItem[] {
  p = p ?? {};
  const tg = p.target ?? {};
  switch (p.tab) {
    case "closed":
      return [
        ["View history", "history", { terminal: tg.terminal, cwd: tg.cwd, name: tg.name }],
        ...(resumeArgv(tg.app) ? [["Resume…", "resume", { cwd: tg.cwd, app: tg.app }]] : []),
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
      return [
        ...(agent ? agentItems(term.address, term.cwd ?? "") : []),
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
    case "tab":
      return [
        renameItem("tab", tg),
        ["New tab", "tab.new", { space: tg.space }],
        ["Close", "tab.close", { id: tg.id }],
      ] as MenuItem[];
    case "space":
      return [
        renameItem("space", tg),
        ["New tab", "tab.new", { space: tg.id }],
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
  "forget-history": "mods/frantss-files/trash.svg",
};

function menuIcon(command: string, args: Record<string, string>) {
  if (command === "pane.split" && args.direction === "down") return "mods/frantss/split-down.svg";
  if (AGENT_ICONS[command]) return AGENT_ICONS[command];
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
function shortcut(name: string, args: Record<string, string>) {
  // `pane.split:right` binds pane.split with { direction: "right" }.
  const value = args && Object.values(args)[0];
  const k = keys().find(
    (b) => b.section === "global" && (b.action === name || b.action === `${name}:${value}`),
  );
  return k ? k.keys : "";
}

export default class Menu extends View {
  declare at: number;
  declare git: "main" | "linked" | null;
  declare handle: FocusHandle;
  init(_props: unknown, cx: AsyncContext) {
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
        this.git = await checkout(folder, space.machine).catch((): null => null);
        cx.notify();
      });
  }

  choose(i: number, cx: Context) {
    const it = items(props(), this.git)[i];
    if (!it) return;
    closeOverlay(props()?.overlay);
    if (it[1] === "copy") cx.write_to_clipboard(it[2].text);
    else if (it[1] === "history")
      openAgentTab(it[2].cwd, historyArgv(it[2].terminal), `${it[2].name} history`);
    else if (it[1] === "resume") openAgentTab(it[2].cwd, resumeArgv(it[2].app));
    else if (it[1] === "forget-history") confirmForgetHistory(it[2].terminal, it[2].name);
    else if (it[1] === "unread") markUnread(it[2].terminal);
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
    else if (it[1] === "tab.close") closeTab(it[2].id, props().target.name ?? "tab");
    else run(it[1], it[2]);
  }

  render(_cx: Context) {
    const t = theme() as Record<string, `#${string}`>;
    const list = items(props(), this.git);
    // A popup doesn't block presses: stop them before a click lands on what is behind the menu.
    return v_flex()
      .id("menu")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(4)
      .bg(t.popover)
      .text_size(12)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
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
                  (it[1] === "pane.split" && list[i - 1][1] !== "pane.split") ||
                  it[1] === "kill" ||
                  it[1] === "remove" ||
                  it[1] === "forget-history" ||
                  it[1] === "terminal.keep" ||
                  (it[1] === "copy" && list[i - 1][1] !== "copy") ||
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
                .child(svg(menuIcon(it[1], it[2])).size(13).flex_none().text_color(t.dim))
                .child(div().flex_1().min_w(0).truncate().child(it[0]))
                .child(
                  div().flex_none().text_size(11).text_color(t.dim).child(shortcut(it[1], it[2])),
                ),
            ),
        ),
      );
  }
}
