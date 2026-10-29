import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
  lstatSync,
  lutimesSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forwardChange, refreshLinks } from "./watch.ts";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "frantss-herdr-watch-"));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "repo"),
    home = join(dir, "home");
  for (const base of [root, home]) {
    mkdirSync(join(base, "mods"), { recursive: true });
    mkdirSync(join(base, "layouts"), { recursive: true });
  }
  mkdirSync(join(root, "mods/personal"));
  writeFileSync(join(root, "layouts/personal.json"), "{}");
  symlinkSync(join(root, "mods/personal"), join(home, "mods/personal"));
  symlinkSync(join(root, "layouts/personal.json"), join(home, "layouts/personal.json"));
  return { root, home };
}

test("forwards nested mod and layout edits to the installed links", (t) => {
  const { root, home } = fixture(t);
  for (const [file, link] of [
    ["mods/personal/main.js", "mods/personal"],
    ["layouts/personal.json", "layouts/personal.json"],
  ]) {
    lutimesSync(join(home, link), new Date(0), new Date(0));
    assert.equal(forwardChange(root, home, file), true);
    assert.ok(lstatSync(join(home, link)).mtimeMs > 0);
    assert.ok(lstatSync(join(home, link)).isSymbolicLink());
  }
});

test("ignores generated files, session data, unlinked mods and foreign links", (t) => {
  const { root, home } = fixture(t);
  for (const filename of [
    ".git/index",
    "shared.json",
    "mods/personal/gpui-kit.d.ts",
    "mods/personal/jsconfig.json",
    "mods/personal/ui.test.mjs",
    "mods/missing/main.js",
  ])
    assert.equal(forwardChange(root, home, filename), false);
  rmSync(join(home, "layouts/personal.json"));
  symlinkSync(join(root, "somewhere-else.json"), join(home, "layouts/personal.json"));
  assert.equal(forwardChange(root, home, "layouts/personal.json"), false);
});

test("successful build refreshes linked output without touching source links", (t) => {
  const { root, home } = fixture(t);
  mkdirSync(join(root, "themes"));
  lutimesSync(join(home, "mods/personal"), new Date(0), new Date(0));
  assert.equal(refreshLinks(root, home), 2);
  assert.ok(lstatSync(join(home, "mods/personal")).mtimeMs > 0);
});
