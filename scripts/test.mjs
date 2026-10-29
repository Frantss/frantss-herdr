import { copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const appHome = process.env.HERDR_APP_HOME || join(homedir(), ".config/herdr-app");
copyFileSync(join(appHome, "gpui-kit.d.ts"), join(root, "mods/git-history/gpui-kit.d.ts"));
const result = spawnSync(process.execPath, ["--experimental-vm-modules", "--test",
  "scripts/link.test.mjs", "scripts/watch.test.mjs", "mods/git-history/git.test.mjs", "mods/git-history/graph.test.mjs",
  "mods/git-history/ui.test.mjs", "mods/github/github.test.mjs"], { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
