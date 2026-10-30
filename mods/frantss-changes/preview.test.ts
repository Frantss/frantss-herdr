import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { trackedPreview, untrackedPreview } from "./preview.ts";

const truncated = "… (line truncated)";

test("untracked previews retain exact full-file counts with a bounded number of rows", () => {
  const preview = untrackedPreview("line\n".repeat(2000));
  assert.equal(preview.add, 2000);
  assert.equal(preview.lines.length, 1500);
  assert.equal(preview.lines[0], "@@ -0,0 +1,2000 @@");
  assert.equal(preview.lines[1], "+line");
  assert.equal(preview.lines.at(-1), "+line");
});

test("untracked previews retain empty files, trailing newlines, blank lines, and CRLF", () => {
  for (const [text, count, rows] of [
    ["", 0, ["+"]],
    ["a", 1, ["+a"]],
    ["a\n", 1, ["+a"]],
    ["a\n\n", 2, ["+a", "+"]],
    ["\n", 1, ["+"]],
    ["a\r\nb\r\n", 2, ["+a\r", "+b\r"]],
  ] as const) {
    assert.deepEqual(untrackedPreview(text), {
      add: count,
      lines: [`@@ -0,0 +1,${count} @@`, ...rows],
    });
  }
});

test("untracked previews count beyond the raw prefix and detect binary data beyond it", () => {
  const prefix = "a".repeat(399999) + "\n";
  const preview = untrackedPreview(prefix + "outside\n".repeat(10));
  assert.equal(preview.add, 11);
  assert.deepEqual(preview.lines, ["@@ -0,0 +1,11 @@", "+" + "a".repeat(3999) + truncated]);
  assert.deepEqual(untrackedPreview(prefix + "\0"), {
    add: null,
    lines: ["Binary file · no text diff"],
  });
});

test("the untracked plus prefix counts toward the 4000-character line limit", () => {
  const exact = untrackedPreview("a".repeat(3999));
  assert.equal(exact.lines[1], "+" + "a".repeat(3999));
  const over = untrackedPreview("a".repeat(4000));
  assert.equal(over.lines[1], "+" + "a".repeat(3999) + truncated);
});

test("tracked previews start at the first hunk and retain later hunks and line endings", () => {
  assert.deepEqual(
    trackedPreview(
      "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n@@ -5 +5 @@\n context\n",
      false,
    ),
    ["@@ -1 +1 @@", "-old", "+new", "@@ -5 +5 @@", " context"],
  );
  assert.deepEqual(trackedPreview("@@ -1 +1 @@\r\n-old\r\n+new\r\n\n", false), [
    "@@ -1 +1 @@\r",
    "-old\r",
    "+new\r",
    "",
  ]);
  assert.deepEqual(trackedPreview("prefix\r@@ not a line", false), ["No text diff available"]);
});

test("tracked previews retain no-hunk messages", () => {
  assert.deepEqual(trackedPreview("", false), ["No text diff available"]);
  assert.deepEqual(trackedPreview("Binary files a/a and b/a differ\n", true), [
    "Binary file changed",
  ]);
});

test("tracked previews bound line count and truncate large lines without their full split arrays", () => {
  const preview = trackedPreview("header\n@@ -1 +1 @@\n" + "+line\n".repeat(3000), false);
  assert.equal(preview.length, 1500);
  assert.equal(preview[0], "@@ -1 +1 @@");
  assert.equal(preview.at(-1), "+line");
  assert.deepEqual(
    trackedPreview("@@ -1 +1 @@\n" + "a".repeat(4000) + "\n" + "b".repeat(8 * 1024 * 1024), false),
    ["@@ -1 +1 @@", "a".repeat(4000), "b".repeat(4000) + truncated],
  );
});
