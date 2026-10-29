import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const binary = process.env.HERDR_APP_BIN || "herdr-app";
for (const group of ["layouts", "themes"])
  for (const name of readdirSync(join(root, group)).filter((name) => name.endsWith(".json")))
    JSON.parse(readFileSync(join(root, group, name), "utf8"));

const failed = [];
for (const name of readdirSync(join(root, "mods"))) {
  console.log(`Checking ${name}`);
  const result = spawnSync(binary, ["check", join(root, "mods", name)], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) failed.push(name);
}
if (failed.length) {
  console.error(`Native checks failed: ${failed.join(", ")}`);
  process.exitCode = 1;
}
