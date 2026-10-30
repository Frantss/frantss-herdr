// Apps a folder or file opens in, for frantss-open and the files panel. Mods can't import outside
// their own folder, so each mod links this file as ./apps.ts and the build copies it into each.
import type { exec as Exec } from "herdr";

// `app`: the name `open -a` takes. `takes`: what a file opens as: the file itself, its folder, or a
// reveal of the file in Finder.
export const APPS = [
  { key: "finder", name: "Finder", app: "Finder", takes: "reveal" },
  { key: "terminal", name: "Terminal", app: "Terminal", takes: "folder" },
  { key: "ghostty", name: "Ghostty", app: "Ghostty", takes: "folder" },
  { key: "vscode", name: "VS Code", app: "Visual Studio Code", takes: "file" },
  { key: "zed", name: "Zed", app: "Zed", takes: "file" },
] as const;
export type App = (typeof APPS)[number];

export const appIcon = (app: App) => `mods/frantss-open/icons/${app.key}.png`;

// The keys of the apps found last time, kept in shared state (persisted) so a menu lists them at once
// while it looks again.
export const INSTALLED = "frantss.apps";
export const knownApps = (keys: unknown) =>
  APPS.filter((app) => Array.isArray(keys) && keys.includes(app.key));

// `open -Ra` finds an app without opening it, and fails when there is none. Apps rarely come or go
// while Herdr runs, so a mod looks once while it is loaded.
let lookup: Promise<App[]> | null = null;
export function installedApps(exec: typeof Exec): Promise<App[]> {
  lookup ??= Promise.all(
    APPS.map((app) =>
      exec("open", ["-Ra", app.app]).then(
        (r) => r.code === 0,
        () => false,
      ),
    ),
  ).then((found) => APPS.filter((_app, i) => found[i]));
  return lookup;
}

// A folder opens in every app; a file opens as the app takes it.
export function openArgs(app: App, folder: string, file?: string) {
  if (!file) return ["-a", app.app, folder];
  if (app.takes === "reveal") return ["-R", file];
  return ["-a", app.app, app.takes === "file" ? file : folder];
}
