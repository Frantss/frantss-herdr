import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { outputRoot, packageRoot } from "./paths.ts";

test("build emits native JavaScript entries and copies every required asset", () => {
  for (const group of ["layouts", "themes"])
    for (const name of readdirSync(join(packageRoot, group)))
      assert.deepEqual(
        readFileSync(join(outputRoot, group, name)),
        readFileSync(join(packageRoot, group, name)),
      );

  const mods = readdirSync(join(packageRoot, "mods"));
  assert.equal(mods.length, 12);
  for (const mod of mods) {
    const source = join(packageRoot, "mods", mod),
      output = join(outputRoot, "mods", mod);
    assert.ok(existsSync(join(output, "main.js")), mod);
    assert.ok(!existsSync(join(output, "main.ts")), mod);
    assert.match(readFileSync(join(output, "main.js"), "utf8"), /from ["']gpui-kit["']/);
    for (const entry of readdirSync(source, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(json|svg|png)$/.test(entry.name)) continue;
      if (entry.name === "jsconfig.json") continue;
      const path = join(entry.parentPath, entry.name);
      assert.deepEqual(
        readFileSync(join(output, path.slice(source.length + 1))),
        readFileSync(path),
      );
    }
    assert.ok(
      !readdirSync(output).some((name) => /\.test\.|\.ts$/.test(name) && !name.endsWith(".d.ts")),
      mod,
    );
  }
  assert.ok(existsSync(join(outputRoot, "mods/git-history/git.js")));
  assert.ok(existsSync(join(outputRoot, "mods/git-history/graph.js")));
  assert.ok(existsSync(join(outputRoot, "mods/github/github.js")));
});
