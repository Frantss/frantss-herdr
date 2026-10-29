import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appHome, outputRoot, packageRoot } from "./paths.ts";

// Herdr 0.1.7 loads mod images only from real files, so mods are copied and layouts and themes linked.
const OWNER_FILE = ".frantss-herdr";

const generated = (name: string) =>
  name.endsWith(".d.ts") || name === "jsconfig.json" || name.startsWith(".");

export function sameContents(source: string, target: string): boolean {
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

export function ownsMod(packageRoot: string, target: string): boolean {
  const owner = join(target, OWNER_FILE);
  return (
    lstatSync(target, { throwIfNoEntry: false })?.isDirectory() === true &&
    existsSync(owner) &&
    resolve(readFileSync(owner, "utf8").trim()) === resolve(packageRoot)
  );
}

export function installMod(packageRoot: string, source: string, target: string) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(target, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isDirectory() || generated(entry.name)) continue;
    if (!existsSync(join(source, relative(target, path)))) rmSync(path);
  }
  cpSync(source, target, { recursive: true, filter: (path) => !generated(basename(path)) });
  writeFileSync(join(target, OWNER_FILE), resolve(packageRoot));
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
        copied: group === "mods",
      })),
  );
  const pending = entries.filter((entry) => {
    if (entry.copied && installed[entry.relative.slice(5)])
      throw new Error(`Refusing to replace a shipped mod: ${entry.relative}`);
    const stat = lstatSync(entry.target, { throwIfNoEntry: false });
    if (!stat) return true;
    if (stat.isSymbolicLink()) {
      const linked = resolve(dirname(entry.target), readlinkSync(entry.target));
      if (linked === resolve(entry.source)) return entry.copied;
      if (previousRoot && linked === resolve(previousRoot, entry.relative)) return true;
      throw new Error(`Already linked elsewhere: ${entry.target}`);
    }
    if (entry.copied && ownsMod(packageRoot, entry.target))
      return !sameContents(entry.source, entry.target);
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
      if (entry.copied && ownsMod(packageRoot, entry.target)) {
        installMod(packageRoot, entry.source, entry.target);
        continue;
      }
      const original = lstatSync(entry.target, { throwIfNoEntry: false })
        ? join(backup, entry.relative)
        : null;
      if (original) {
        mkdirSync(dirname(original), { recursive: true });
        renameSync(entry.target, original);
      }
      changed.push({ ...entry, original });
      if (entry.copied) installMod(packageRoot, entry.source, entry.target);
      else symlinkSync(resolve(entry.source), entry.target, "file");
    }
  } catch (error) {
    for (const entry of changed.reverse()) {
      const stat = lstatSync(entry.target, { throwIfNoEntry: false });
      if (stat?.isSymbolicLink()) unlinkSync(entry.target);
      else if (stat) rmSync(entry.target, { recursive: true });
      if (entry.original) renameSync(entry.original, entry.target);
    }
    throw error;
  }
  return { linked: pending.length, backup: existsSync(backup) ? backup : null };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const result = linkPackage(outputRoot, appHome, packageRoot);
    console.log(`Installed ${result.linked} entries to ${appHome}.`);
    if (result.backup) {
      console.log(`Originals: ${result.backup}`);
      console.log(
        "Restart Herdr once to load the replaced entries. Its core keeps terminals running.",
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
