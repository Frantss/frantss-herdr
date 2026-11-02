// Space names as the frantss mods show them, and the rename prompt that starts from them.
// Mods link this file as ./space-names.ts.
import { openOverlay } from "herdr";
import type { SpaceInfo } from "herdr";

// The name you gave it, else its branch, else Herdr's.
export function spaceName(space: SpaceInfo): string {
  return space.named ? space.name : (space.branch ?? space.name);
}

// Herdr's own rename prompt starts from the stored name (a number for an unnamed tab, the repo for an
// unnamed space); this one starts from the shown name.
export function rename(what: "tab" | "space", id: string, name: string): unknown {
  return openOverlay({
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
}
