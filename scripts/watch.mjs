import { lstatSync, lutimesSync, readlinkSync, watch } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function forwardChange(root, appHome, filename) {
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const appHome = process.env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app");
  watch(root, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    try {
      if (forwardChange(root, appHome, filename)) console.log(`Reload: ${filename}`);
    } catch (error) {
      console.error(`Could not forward ${filename}: ${error.message}`);
    }
  });
  console.log(`Watching ${root} for Herdr edits. Run npm run link first; Ctrl+C stops watching.`);
}
