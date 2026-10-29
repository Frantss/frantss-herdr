import { lstatSync, lutimesSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { installMod, ownsMod, sameContents } from "./link.ts";

export function forwardChange(root: string, appHome: string, filename: string): boolean {
  const parts = filename.split(sep);
  const [group, name] = parts;
  if (!["layouts", "themes"].includes(group) || parts.length !== 2) return false;
  if (!name.endsWith(".json")) return false;
  const target = join(appHome, filename);
  if (!lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) return false;
  if (resolve(dirname(target), readlinkSync(target)) !== resolve(root, filename)) return false;
  const now = new Date();
  lutimesSync(target, now, now);
  return true;
}

export function refreshInstall(root: string, appHome: string): number {
  let refreshed = 0;
  for (const group of ["layouts", "themes"])
    for (const name of readdirSync(join(root, group)))
      if (forwardChange(root, appHome, join(group, name))) refreshed++;
  for (const name of readdirSync(join(root, "mods"))) {
    const source = join(root, "mods", name),
      target = join(appHome, "mods", name);
    if (!ownsMod(root, target) || sameContents(source, target)) continue;
    installMod(root, source, target);
    refreshed++;
  }
  return refreshed;
}
