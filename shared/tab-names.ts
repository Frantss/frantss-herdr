// Mods link this file into their own folders so the rail and toolbar use the same names.
import type { PaneInfo, Program, SpaceInfo, TabInfo } from "herdr";

// Spinner glyphs go; paths, user@host and the program's own name are not thread titles.
export function threadTitle(title: string, program: Program) {
  const live = (title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
  const telling =
    live &&
    live !== program?.name &&
    live.toLowerCase() !== program?.key &&
    !/^[~/]|^[A-Za-z]:\\/.test(live) &&
    !live.includes("@");
  return telling ? live : null;
}

export const paneName = (pane: PaneInfo | undefined) =>
  (threadTitle(pane?.title, pane?.program) ?? pane?.program?.name ?? "terminal").toLowerCase();

export function tabName(tab: TabInfo, tabPanes: PaneInfo[], space: SpaceInfo) {
  if (tab.named) return tab.name;
  if (tabPanes.length > 1) {
    const folder = space.folder
      ?.replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop();
    return space.branch || folder || space.name;
  }
  return paneName(tabPanes[0]);
}
