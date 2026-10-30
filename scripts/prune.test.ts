import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneOutput } from "./prune.ts";

test("pruning removes JavaScript without a TypeScript source and mods without a source folder", (t) => {
  const root = mkdtempSync(join(tmpdir(), "frantss-herdr-prune-"));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "package"),
    output = join(root, "dist");
  mkdirSync(join(source, "mods", "kept"), { recursive: true });
  writeFileSync(join(source, "mods", "kept", "main.ts"), "");
  for (const file of [
    "mods/kept/main.js",
    "mods/kept/deleted.js",
    "mods/kept/mod.json",
    "mods/kept/icon.svg",
    "mods/kept/gpui-kit.d.ts",
    "mods/gone/main.js",
    "mods/gone/mod.json",
  ]) {
    mkdirSync(join(output, file, ".."), { recursive: true });
    writeFileSync(join(output, file), "");
  }

  pruneOutput(output, source);

  assert.ok(existsSync(join(output, "mods/kept/main.js")));
  assert.ok(!existsSync(join(output, "mods/kept/deleted.js")));
  for (const kept of ["mod.json", "icon.svg", "gpui-kit.d.ts"])
    assert.ok(existsSync(join(output, "mods/kept", kept)), kept);
  assert.ok(!existsSync(join(output, "mods/gone")));
});
