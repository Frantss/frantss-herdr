import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appHome, outputRoot, packageRoot } from "./paths.ts";

const generated = (name: string) =>
  name.endsWith(".d.ts") || name === "jsconfig.json" || name === ".DS_Store";

function sameContents(source: string, target: string): boolean {
  if (lstatSync(source).isDirectory() !== lstatSync(target).isDirectory()) return false;
  if (!lstatSync(source).isDirectory()) return readFileSync(source).equals(readFileSync(target));
  const names = (path) =>
    readdirSync(path)
      .filter((name) => !generated(name))
      .sort();
  const left = names(source),
    right = names(target);
  return (
    JSON.stringify(left) === JSON.stringify(right) &&
    left.every((name) => sameContents(join(source, name), join(target, name)))
  );
}

export function linkPackage(packageRoot: string, appHome: string, previousRoot?: string) {
  const installed = existsSync(join(appHome, "installed.json"))
    ? JSON.parse(readFileSync(join(appHome, "installed.json"), "utf8"))
    : {};
  const entries = ["layouts", "mods", "themes"].flatMap((group) =>
    readdirSync(join(packageRoot, group))
      .filter((name) => group === "mods" || name.endsWith(".json"))
      .map((name) => ({
        relative: join(group, name),
        source: join(packageRoot, group, name),
        target: join(appHome, group, name),
      })),
  );
  const pending = entries.filter((entry) => {
    if (entry.relative.startsWith(`mods/`) && installed[entry.relative.slice(5)])
      throw new Error(`Refusing to replace a shipped mod: ${entry.relative}`);
    const stat = lstatSync(entry.target, { throwIfNoEntry: false });
    if (!stat) return true;
    if (stat.isSymbolicLink()) {
      if (resolve(dirname(entry.target), readlinkSync(entry.target)) === resolve(entry.source))
        return false;
      if (
        previousRoot &&
        resolve(dirname(entry.target), readlinkSync(entry.target)) ===
          resolve(previousRoot, entry.relative)
      )
        return true;
      throw new Error(`Already linked elsewhere: ${entry.target}`);
    }
    if (!sameContents(entry.source, entry.target))
      throw new Error(`Different files at ${entry.target}. Reconcile them before linking.`);
    return true;
  });
  if (!pending.length) return { linked: 0, backup: null };

  const backup = join(appHome, "backups", `frantss-herdr-${Date.now()}`);
  const changed: { target: string; original: string | null }[] = [];
  try {
    for (const entry of pending) {
      mkdirSync(dirname(entry.target), { recursive: true });
      const original = lstatSync(entry.target, { throwIfNoEntry: false })
        ? join(backup, entry.relative)
        : null;
      if (original) {
        mkdirSync(dirname(original), { recursive: true });
        renameSync(entry.target, original);
      }
      changed.push({ ...entry, original });
      symlinkSync(
        resolve(entry.source),
        entry.target,
        lstatSync(entry.source).isDirectory() ? "dir" : "file",
      );
    }
  } catch (error) {
    for (const entry of changed.reverse()) {
      if (lstatSync(entry.target, { throwIfNoEntry: false })?.isSymbolicLink())
        unlinkSync(entry.target);
      if (entry.original) renameSync(entry.original, entry.target);
    }
    throw error;
  }
  return { linked: pending.length, backup: existsSync(backup) ? backup : null };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const result = linkPackage(outputRoot, appHome, packageRoot);
    console.log(`Linked ${result.linked} entries to ${appHome}.`);
    if (result.backup) console.log(`Originals: ${result.backup}`);
    if (result.linked)
      console.log(
        "Restart Herdr once to load the new mod paths. Its core keeps terminals running.",
      );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
