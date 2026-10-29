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

test("only the first entries up to the limit are read", () => {
  assert.deepEqual(Object.keys(statusMarks("?? a\0?? b\0", "/repo", 1)), ["/repo/a"]);
});
