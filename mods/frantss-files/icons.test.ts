import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { iconFile, type IconManifest } from "./icons.ts";

const manifest: IconManifest = JSON.parse(
  readFileSync(
    new URL("../../node_modules/material-icon-theme/dist/material-icons.json", import.meta.url),
    "utf8",
  ),
);
const icon = (name: string, dir = false, open = false, light = false) =>
  iconFile(manifest, { name, dir, open }, light);

test("files match by name, then by the longest extension, then the default", () => {
  assert.equal(icon("package.json"), "nodejs.svg");
  assert.equal(icon("Dockerfile"), "docker.svg");
  assert.equal(icon("main.test.ts"), "test-ts.svg");
  assert.equal(icon("main.ts"), "typescript.svg");
  assert.equal(icon("notes.unknown-extension"), "file.svg");
});

test("folders use the closed or open icon for their name", () => {
  assert.equal(icon("src", true), "folder-src.svg");
  assert.equal(icon("src", true, true), "folder-src-open.svg");
  assert.equal(icon("anything-else", true), "folder.svg");
  assert.equal(icon("anything-else", true, true), "folder-open.svg");
});

test("a light theme takes light variants without changing which key wins", () => {
  assert.equal(icon("pnpm-lock.yaml", false, false, true), "pnpm_light.svg");
  assert.equal(icon("config.toml", false, false, true), "toml_light.svg");
  assert.equal(icon("config.toml"), "toml.svg");
  assert.equal(icon("pyproject.toml", false, false, true), "python-misc.svg");
});
