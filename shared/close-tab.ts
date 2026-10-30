// Asks before a tab closes. Mods can't import outside their own folder, so each mod that closes tabs
// links this file as ./close-tab.ts and the build copies it into each.
import { openOverlay, spaces } from "herdr";

// `name`: the tab's shown name. Closing a space's last tab closes the space too, so Herdr would ask
// again; the answer here covers both.
export function closeTab(id: string, name: string) {
  const last = spaces().find((space) => space.tabs.some((tab) => tab.id === id))?.tabs.length === 1;
  return openOverlay({
    mod: "confirm",
    kind: "dialog",
    width: 400,
    height: 170,
    props: {
      title: `Close ${name}?`,
      detail: last
        ? "Programs running in it stop. It is the last tab, so its space closes too."
        : "Programs running in it stop.",
      command: { name: "tab.close", args: { id, confirmed: true } },
    },
  });
}
