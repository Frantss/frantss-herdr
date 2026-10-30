import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

// The build keeps dist between runs (layouts and themes are linked into it, and a failed build keeps
// the last output), so it removes what no source makes any more: JavaScript whose TypeScript file is
// gone, and mods whose source folder is gone. Each mods/<mod>/<path>.ts builds to the same path in
// dist with .js; a linked shared file keeps its name inside the mod.
export function pruneOutput(outputRoot: string, packageRoot: string) {
  const mods = join(outputRoot, "mods");
  for (const name of readdirSync(mods)) {
    const mod = join(mods, name);
    if (!existsSync(join(packageRoot, "mods", name))) {
      rmSync(mod, { recursive: true });
      continue;
    }
    for (const entry of readdirSync(mod, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
      const path = join(entry.parentPath, entry.name);
      const source = join(packageRoot, relative(outputRoot, path)).replace(/\.js$/, ".ts");
      if (!existsSync(source)) rmSync(path);
    }
  }
}
