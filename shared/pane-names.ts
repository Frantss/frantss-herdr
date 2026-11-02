import { machines, panes, shared, setShared } from "herdr";
import type { PaneInfo, SpaceInfo, TabInfo } from "herdr";
import {
  paneName as automaticPaneName,
  tabName as automaticTabName,
  type PaneNameSource,
} from "./tab-names.ts";
export { threadTitle } from "./tab-names.ts";

const PANE_NAMES = "frantss.paneNames";
const savedNames = () => (shared(PANE_NAMES) as Record<string, string> | null) ?? {};

export const paneName = (pane: PaneNameSource | undefined) => automaticPaneName(pane, savedNames());
export const tabName = (tab: TabInfo, tabPanes: PaneInfo[], space: SpaceInfo) =>
  automaticTabName(tab, tabPanes, space, savedNames());

export function setPaneName(pane: string, name: string) {
  if (!panes().some((p) => p.pane === pane)) return;
  const names = { ...savedNames() };
  const trimmed = name.trim();
  if (trimmed) names[pane] = trimmed;
  else delete names[pane];
  setShared(PANE_NAMES, names);
}

export function prunePaneNames(livePanes: PaneInfo[]) {
  const names = savedNames();
  if (!Object.keys(names).length) return;
  const ready = new Set(
    machines()
      .filter((m) => m.layout === "ready")
      .map((m) => m.name),
  );
  const live = new Set(livePanes.map((p) => p.pane));
  const kept = Object.fromEntries(
    Object.entries(names).filter(([pane]) => {
      // Remote ids keep their machine prefix; an offline layout cannot prove a pane closed.
      const machine = pane.includes("/") ? pane.split("/")[0] : null;
      return live.has(pane) || !ready.has(machine);
    }),
  );
  if (Object.keys(kept).length !== Object.keys(names).length) setShared(PANE_NAMES, kept);
}
