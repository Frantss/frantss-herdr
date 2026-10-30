import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { treeRows, type TreeRow } from "./tree.ts";

const shown = (rows: TreeRow<{ path: string; add: number; del: number }>[]) =>
  rows.map((row) =>
    row.kind === "folder"
      ? `${"  ".repeat(row.depth)}${row.open ? "▾" : "▸"} ${row.name} +${row.add} −${row.del}`
      : `${"  ".repeat(row.depth)}${row.file.path}`,
  );
const files = [
  "README.md",
  "src/main.ts",
  "src/lib/a.ts",
  "src/lib/b.ts",
  "docs/deep/guide.md",
].map((path) => ({ path, add: 2, del: 1 }));

test("tree rows put folders before files and join single-folder chains", () => {
  assert.deepEqual(shown(treeRows(files, new Set())), [
    "▾ docs/deep +2 −1",
    "  docs/deep/guide.md",
    "▾ src +6 −3",
    "  ▾ lib +4 −2",
    "    src/lib/a.ts",
    "    src/lib/b.ts",
    "  src/main.ts",
    "README.md",
  ]);
});

test("tree rows hide what a collapsed folder holds", () => {
  assert.deepEqual(shown(treeRows(files, new Set(["src/lib", "docs/deep"]))), [
    "▸ docs/deep +2 −1",
    "▾ src +6 −3",
    "  ▸ lib +4 −2",
    "  src/main.ts",
    "README.md",
  ]);
});
