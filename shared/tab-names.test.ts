import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { paneName, tabName, threadTitle } from "./tab-names.ts";
import type { PaneInfo, Program, SpaceInfo, TabInfo } from "herdr";

const pi = { key: "pi", name: "Pi", agent: true } as Program;
const pane = (title: string, cwd = "/repo/gasty") => ({ title, cwd, program: pi }) as PaneInfo;

test("Pi's native title exposes the session name without its prefix or folder", () => {
  assert.equal(threadTitle("π - Fix Pi titles - gasty", pi), "Fix Pi titles");
  assert.equal(threadTitle("π - Fix Pi - naming - gasty", pi), "Fix Pi - naming");
  assert.equal(threadTitle("π - Review @src - gasty", pi), "Review @src");
  assert.equal(paneName(pane("π - Fix Pi titles - gasty")), "fix pi titles");
  assert.equal(
    paneName(pane("π - Fix Pi titles - repo - copy", "/repo/repo - copy")),
    "fix pi titles",
  );
  assert.equal(threadTitle("π - gasty", pi), null);
  assert.equal(paneName(pane("π - gasty")), "pi");
});

test("Pi task titles follow unnamed tabs while manual names and split-tab branch names stay intact", () => {
  const tab = { named: false, name: "1" } as TabInfo;
  const space = { folder: "/repo/gasty", branch: "feature/pi" } as SpaceInfo;
  const panes = [pane("π - Fix Pi titles - gasty")];
  assert.equal(tabName(tab, panes, space), "fix pi titles");
  assert.equal(tabName({ ...tab, named: true, name: "My tab" }, panes, space), "My tab");
  assert.equal(tabName(tab, [...panes, pane("π - Another task - gasty")], space), "feature/pi");
});
