import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = fileURLToPath(new URL("../", import.meta.url));
export const outputRoot = join(packageRoot, "dist");
export const appHome = process.env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app");
