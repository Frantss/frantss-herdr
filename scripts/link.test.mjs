import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readlinkSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkPackage } from "./link.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "frantss-herdr-link-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "package"), home = join(root, "home");
  for (const dir of [source, home]) {
    mkdirSync(join(dir, "layouts"), { recursive: true });
    mkdirSync(join(dir, "mods", "personal"), { recursive: true });
    mkdirSync(join(dir, "themes"), { recursive: true });
    writeFileSync(join(dir, "layouts", "personal.json"), '{"type":"row"}');
    writeFileSync(join(dir, "mods", "personal", "main.js"), "export default class Personal {}");
    writeFileSync(join(dir, "themes", "personal.json"), "{}");
  }
  return { source, home };
}

test("links expose source edits, preserve originals and leave session state alone", t => {
  const { source, home } = fixture(t);
  writeFileSync(join(home, "shared.json"), '{"layout":"personal"}');
  writeFileSync(join(home, "mods/personal/gpui-kit.d.ts"), "generated");
  const result = linkPackage(source, home);
  assert.equal(result.linked, 3);
  assert.equal(readlinkSync(join(home, "mods/personal")), join(source, "mods/personal"));
  writeFileSync(join(source, "mods/personal/main.js"), "changed");
  assert.equal(readFileSync(join(home, "mods/personal/main.js"), "utf8"), "changed");
  assert.equal(readFileSync(join(result.backup, "mods/personal/main.js"), "utf8"), "export default class Personal {}");
  assert.equal(readFileSync(join(home, "shared.json"), "utf8"), '{"layout":"personal"}');
  assert.deepEqual(linkPackage(source, home), { linked: 0, backup: null });
});

test("a changed destination aborts before replacing any files", t => {
  const { source, home } = fixture(t);
  writeFileSync(join(home, "themes/personal.json"), '{"changed":true}');
  assert.throws(() => linkPackage(source, home), /Different files/);
  assert.equal(readFileSync(join(home, "layouts/personal.json"), "utf8"), '{"type":"row"}');
  assert.equal(existsSync(join(home, "backups")), false);
});

test("refuses shipped mods", t => {
  const { source, home } = fixture(t);
  writeFileSync(join(home, "installed.json"), '{"personal":{}}');
  assert.throws(() => linkPackage(source, home), /shipped mod/);
  assert.equal(existsSync(join(home, "backups")), false);
});

test("refuses a link owned by another package", t => {
  const { source, home } = fixture(t);
  rmSync(join(home, "layouts/personal.json"));
  symlinkSync(join(source, "themes/personal.json"), join(home, "layouts/personal.json"));
  assert.throws(() => linkPackage(source, home), /Already linked elsewhere/);
  assert.equal(existsSync(join(home, "backups")), false);
});

test("installs into missing layout, mod and theme directories", t => {
  const { source, home } = fixture(t);
  rmSync(home, { recursive: true });
  assert.deepEqual(linkPackage(source, home), { linked: 3, backup: null });
  assert.equal(readFileSync(join(home, "themes/personal.json"), "utf8"), "{}");
});
