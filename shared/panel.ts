// The side panel's children, opened in the layout's panel stack or as panes in a tab. Mods can't
// import outside their own folder, so each panel mod links this file as ./panel.ts and the build
// copies it into each.
import { focused, layout, panes, props, spaces } from "herdr";

export interface LayoutNode {
  id?: string;
  children?: LayoutNode[];
  hidden?: boolean;
  active?: string;
}

// The panel stack's children and the mods they show.
export const PANEL_MODS = {
  files: "frantss-files",
  changes: "frantss-changes",
  "agent-graph": "agent-graph",
  "git-history": "git-history",
  github: "github",
} as const;
export type PanelId = keyof typeof PANEL_MODS;

export function findNode(node: LayoutNode | null, id: string): LayoutNode | null {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

// A hidden copy keeps running, so it waits until it shows: a pane copy (`props.pane`) while its
// tab is the shown one, the panel copy while the panel shows its child. A copy can't tell its own
// pane, so a pane copy also refreshes while another copy of it shows.
export function panelShown(id: PanelId) {
  if (props()?.pane) {
    const tab = spaces()
      .find((space) => space.active)
      ?.tabs.find((each) => each.active)?.id;
    return panes().some((pane) => pane.tab === tab && pane.mod === PANEL_MODS[id]);
  }
  const panel = findNode(layout() as LayoutNode | null, "panel");
  return !panel || (!panel.hidden && panel.active === id);
}

let followed: string | null = null;
// The pane the panels describe: the focused one, or while a mod pane has focus (a panel opened as a
// pane), the terminal pane focused before it in that tab.
export function followedPane(focus = focused()) {
  if (!focus?.pane) return null;
  const all = panes(),
    pane = all.find((each) => each.pane === focus.pane);
  if (!pane?.mod) {
    followed = pane?.pane ?? null;
    return pane ?? null;
  }
  return (
    all.find((each) => each.pane === followed && each.tab === pane.tab) ??
    all.find((each) => each.tab === pane.tab && !each.mod && each.cwd) ??
    null
  );
}

// The folder the panels describe and the machine it is on (null: this one).
export function followedPlace() {
  const space = spaces().find((s) => s.active),
    focus = focused();
  const pane = followedPane(focus);
  const on =
    focus?.pane === null
      ? focus.terminal?.includes("/")
        ? focus.terminal.split("/")[0]
        : null
      : (space?.machine ?? null);
  return { cwd: pane?.cwd || focus?.cwd || space?.folder, on };
}
