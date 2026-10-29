import { lstatSync, lutimesSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export function forwardChange(root: string, appHome: string, filename: string): boolean {
  const parts = filename.split(sep);
  if (parts.some((part) => part.startsWith(".") || part === "node_modules")) return false;
  if (/\.d\.ts$|\.test\.mjs$|(^|\/)jsconfig\.json$/.test(filename)) return false;
  const [group, name] = parts;
  if (!["mods", "layouts", "themes"].includes(group) || !name) return false;
  if (group !== "mods" && (parts.length !== 2 || !name.endsWith(".json"))) return false;
  const relative = join(group, name),
    target = join(appHome, relative);
  if (!lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) return false;
  if (resolve(dirname(target), readlinkSync(target)) !== resolve(root, relative)) return false;
  const now = new Date();
  lutimesSync(target, now, now);
  return true;
}

export function refreshLinks(root: string, appHome: string): number {
  let refreshed = 0;
  for (const group of ["layouts", "mods", "themes"])
    for (const name of readdirSync(join(root, group)))
      if (forwardChange(root, appHome, join(group, name))) refreshed++;
  return refreshed;
}
