// Mods link this file into their own folders so the rail and toolbar use the same names.
import type { PaneInfo, Program, SpaceInfo, TabInfo } from "herdr";

export type PaneNameSource = Pick<PaneInfo, "pane" | "title" | "program"> & { cwd?: string };

// Spinner glyphs go; paths, user@host and the program's own name are not thread titles.
export function threadTitle(title: string, program: Program, cwd?: string) {
  let live = (title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
  if (program?.key === "pi" && live.startsWith("π - ")) {
    const rest = live.slice(4);
    const folder = cwd
      ?.replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop();
    const suffix = folder ? ` - ${folder}` : "";
    live =
      suffix && rest.endsWith(suffix)
        ? rest.slice(0, -suffix.length)
        : rest === folder
          ? ""
          : (/^(.*) - .+$/.exec(rest)?.[1] ?? "");
    return live || null;
  }
  if (program?.key === "omp") {
    live = live.replace(/^π(?:\s+[^\p{L}\p{N}\s]+|:)\s*/u, "");
    if (live === "π") return null;
  }
  const telling =
    live &&
    live !== program?.name &&
    live.toLowerCase() !== program?.key &&
    !/^[~/]|^[A-Za-z]:\\/.test(live) &&
    !live.includes("@");
  return telling ? live : null;
}

export const paneName = (pane: PaneNameSource | undefined, names: Record<string, string> = {}) =>
  names[pane?.pane] ||
  (
    threadTitle(pane?.title, pane?.program, pane?.cwd) ??
    pane?.program?.name ??
    "terminal"
  ).toLowerCase();

export function tabName(
  tab: TabInfo,
  tabPanes: PaneInfo[],
  space: SpaceInfo,
  names: Record<string, string> = {},
) {
  if (tab.named) return tab.name;
  if (tabPanes.length > 1) {
    const folder = space.folder
      ?.replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop();
    return space.branch || folder || space.name;
  }
  return paneName(tabPanes[0], names);
}
