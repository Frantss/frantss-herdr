import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
  lstatSync,
  lutimesSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installMod } from "./link.ts";
import { forwardChange, refreshInstall } from "./watch.ts";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "frantss-herdr-watch-"));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "repo"),
    home = join(dir, "home");
  for (const base of [root, home]) {
    mkdirSync(join(base, "mods"), { recursive: true });
    mkdirSync(join(base, "layouts"), { recursive: true });
    mkdirSync(join(base, "themes"), { recursive: true });
  }
  mkdirSync(join(root, "mods/personal"));
  writeFileSync(join(root, "mods/personal/main.js"), "first");
  writeFileSync(join(root, "layouts/personal.json"), "{}");
  installMod(root, join(root, "mods/personal"), join(home, "mods/personal"));
  symlinkSync(join(root, "layouts/personal.json"), join(home, "layouts/personal.json"));
  return { root, home };
}

test("forwards layout edits to the installed links", (t) => {
  const { root, home } = fixture(t);
  lutimesSync(join(home, "layouts/personal.json"), new Date(0), new Date(0));
  assert.equal(forwardChange(root, home, "layouts/personal.json"), true);
  assert.ok(lstatSync(join(home, "layouts/personal.json")).mtimeMs > 0);
  assert.ok(lstatSync(join(home, "layouts/personal.json")).isSymbolicLink());
});

test("ignores mods, session data, unlinked layouts and foreign links", (t) => {
  const { root, home } = fixture(t);
  for (const filename of ["shared.json", "mods/personal/main.js", "layouts/missing.json"])
    assert.equal(forwardChange(root, home, filename), false);
  rmSync(join(home, "layouts/personal.json"));
  symlinkSync(join(root, "somewhere-else.json"), join(home, "layouts/personal.json"));
  assert.equal(forwardChange(root, home, "layouts/personal.json"), false);
});

test("successful build copies changed owned mods and skips foreign ones", (t) => {
  const { root, home } = fixture(t);
  assert.equal(refreshInstall(root, home), 1);
  writeFileSync(join(root, "mods/personal/main.js"), "second");
  mkdirSync(join(root, "mods/foreign"));
  mkdirSync(join(home, "mods/foreign"));
  writeFileSync(join(root, "mods/foreign/main.js"), "ours");
  writeFileSync(join(home, "mods/foreign/main.js"), "theirs");
  assert.equal(refreshInstall(root, home), 2);
  assert.equal(readFileSync(join(home, "mods/personal/main.js"), "utf8"), "second");
  assert.equal(readFileSync(join(home, "mods/foreign/main.js"), "utf8"), "theirs");
});
