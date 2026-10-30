import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { expandGaps, fileLines } from "./gaps.ts";
import { LINE_LENGTH, TRUNCATED } from "./preview.ts";

const lines = ["a", "b", "c", "d", "e", "f", "", "h"];
const rows = [
  { kind: "@", number: 3, text: "@@ -3 +3 @@" },
  { kind: "-", number: 3, text: "old c" },
  { kind: "+", number: 3, text: "c" },
  { kind: "@", number: 4, text: "@@ -4 +4 @@ next" },
  { kind: " ", number: 4, text: "d" },
  { kind: "@", number: 6, text: "@@ -6 +6 @@" },
  { kind: "+", number: 6, text: "f" },
];

test("file lines drop only the final newline", () => {
  assert.deepEqual(fileLines("a\n\nb\n"), ["a", "", "b"]);
  assert.deepEqual(fileLines("a"), ["a"]);
  assert.deepEqual(fileLines(""), []);
});

test("hunk headers count hidden lines above them and a last header offers the rest", () => {
  const shown = expandGaps(rows, lines, new Set());
  assert.deepEqual(
    shown.map((row) => [row.kind, row.number, row.gap]),
    [
      ["@", 3, 2],
      ["-", 3, undefined],
      ["+", 3, undefined],
      ["@", 4, undefined],
      [" ", 4, undefined],
      ["@", 6, 1],
      ["+", 6, undefined],
      ["@", 9, 2],
    ],
  );
  assert.equal(shown.at(-1).text, "");
});

test("expanded gaps show the new file's lines in place of their header", () => {
  const shown = expandGaps(rows, lines, new Set([3, 9]));
  assert.deepEqual(
    shown.slice(0, 3).map((row) => [row.kind, row.number, row.text]),
    [
      [" ", 1, "a"],
      [" ", 2, "b"],
      ["-", 3, "old c"],
    ],
  );
  assert.deepEqual(
    shown.slice(-2).map((row) => [row.kind, row.number, row.text]),
    [
      [" ", 7, " "],
      [" ", 8, "h"],
    ],
  );
});

test("gaps stay closed without file lines and clip long lines when opened", () => {
  assert.equal(expandGaps(rows, null, new Set([3])), rows);
  const long = "x".repeat(LINE_LENGTH + 5);
  const [row] = expandGaps([{ kind: "@", number: 2, text: "@@" }], [long], new Set([2]));
  assert.equal(row.text, "x".repeat(LINE_LENGTH) + TRUNCATED);
});
