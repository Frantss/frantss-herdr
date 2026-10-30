import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { checkName, menuItems, parentOf } from "./menu.ts";

const actions = (items: ReturnType<typeof menuItems>) =>
  items.map((item) => (item === null ? "—" : item.action));

test("files offer preview, Fresh, copying, and changes; other apps only on this Mac", () => {
  assert.deepEqual(actions(menuItems({ dir: false, open: false }, true)), [
    "preview",
    "fresh",
    "—",
    "copy",
    "copy-relative",
    "open-in",
    "—",
    "new-file",
    "new-folder",
    "rename",
    "trash",
  ]);
  assert.ok(!actions(menuItems({ dir: false, open: false }, false)).includes("open-in"));
});

test("folders toggle open or closed and keep the rest", () => {
  const closed = menuItems({ dir: true, open: false }, true),
    open = menuItems({ dir: true, open: true }, true);
  assert.equal(closed[0].label, "Expand");
  assert.equal(open[0].label, "Collapse");
  assert.deepEqual(actions(closed).slice(1), [
    "—",
    "copy",
    "copy-relative",
    "open-in",
    "—",
    "new-file",
    "new-folder",
    "rename",
    "trash",
  ]);
});

test("new entries go in the folder, or beside the file", () => {
  assert.equal(parentOf("src/main.ts"), "src");
  assert.equal(parentOf("main.ts"), "");
});

test("names must be single, new, and not dot entries", () => {
  const siblings = ["a.ts", "lib"];
  assert.equal(checkName("  ", siblings), "Enter a name");
  assert.equal(checkName("x/y", siblings), "A name cannot contain /");
  assert.equal(checkName("..", siblings), "That name is reserved");
  assert.equal(checkName("lib", siblings), "lib already exists");
  assert.equal(checkName("b.ts", siblings), null);
});
