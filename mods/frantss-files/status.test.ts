import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { statusMarks } from "./status.ts";

test("git status entries become marks by absolute path", () => {
  const stdout = [
    "?? new.ts",
    "A  added.ts",
    " M changed.ts",
    " D gone.ts",
    "UU conflict.ts",
    "!! dist/",
    "!! .env",
  ].join("\0");
  assert.deepEqual(statusMarks(stdout + "\0", "/repo", 100), {
    "/repo/new.ts": "A",
    "/repo/added.ts": "A",
    "/repo/changed.ts": "M",
    "/repo/gone.ts": "D",
    "/repo/conflict.ts": "U",
    "/repo/dist": "I",
    "/repo/.env": "I",
  });
});

test("changes mark each ancestor folder without marking the repository root", () => {
  assert.deepEqual(statusMarks("?? src/nested/new.ts\0", "/repo", 100), {
    "/repo/src/nested/new.ts": "A",
    "/repo/src/nested": "A",
    "/repo/src": "A",
  });
});

test("folder summaries retain matching changes and use M for mixed changes", () => {
  for (const [entries, expected] of [
    [["A  src/one.ts", "?? src/nested/two.ts"], "A"],
    [[" D src/one.ts", "D  src/nested/two.ts"], "D"],
    [[" M src/one.ts", " M src/nested/two.ts"], "M"],
    [["A  src/one.ts", " D src/nested/two.ts"], "M"],
    [[" M src/one.ts", "?? src/nested/two.ts"], "M"],
    [["UU src/one.ts", "?? src/nested/two.ts"], "U"],
  ] as const) {
    for (const ordered of [entries, [...entries].reverse()]) {
      const marks = statusMarks(ordered.join("\0") + "\0", "/repo", 100);
      assert.equal(marks["/repo/src"], expected);
    }
  }
});

test("ignored paths do not contribute to folder summaries", () => {
  assert.deepEqual(statusMarks("!! src/cache/\0", "/repo", 100), {
    "/repo/src/cache": "I",
  });
});

test("the entry limit also bounds which changes contribute to folder summaries", () => {
  const marks = statusMarks("?? src/one.ts\0 M src/two.ts\0", "/repo", 1);
  assert.equal(marks["/repo/src"], "A");
  assert.equal(marks["/repo/src/two.ts"], undefined);
});

test("only the first entries up to the limit are read", () => {
  assert.deepEqual(Object.keys(statusMarks("?? a\0?? b\0", "/repo", 1)), ["/repo/a"]);
});
