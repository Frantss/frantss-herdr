import { openOverlay, panes, run, spaces } from "herdr";

export function openAgentTab(folder: string, argv: string[], name?: string) {
  const allPanes = panes();
  const space = spaces().find(
    (space) =>
      !space.machine &&
      (allPanes.find((pane) => space.tabs.some((tab) => tab.id === pane.tab) && pane.cwd)?.cwd ||
        space.folder) === folder,
  );
  if (!space) return run("space.new", { folder, argv, ...(name ? { tab: name } : {}) });
  run("space.select", { id: space.id });
  run("tab.new", { space: space.id, folder, argv, ...(name ? { name } : {}) });
}

export function confirmForgetHistory(address: string, name: string) {
  return openOverlay({
    mod: "confirm",
    kind: "dialog",
    width: 400,
    height: 170,
    props: {
      title: `Forget ${name} history?`,
      detail: "This removes the retained terminal history. It cannot be undone.",
      command: { name: `frantss.forget-history:${encodeURIComponent(address)}` },
    },
  });
}
