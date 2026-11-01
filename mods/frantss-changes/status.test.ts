import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { changedFiles, parseNumstat, parseStatus } from "./status.ts";

test("status entries split into the staged and unstaged sections by their codes", () => {
  const { entries } = parseStatus(
    [
      "## main...origin/main",
      "M  staged.ts",
      " M unstaged.ts",
      "MM both.ts",
      "A  added.ts",
      "AM added-then-edited.ts",
      "D  removed.ts",
      " D deleted.ts",
      "?? new.ts",
      "UU conflict.ts",
      "AA both-added.ts",
      "",
    ].join("\0"),
  );
  assert.deepEqual(
    changedFiles(entries, {}, {}).map(({ section, path, status, fresh }) => [
      section,
      path,
      status,
      fresh,
    ]),
    [
      ["staged", "staged.ts", "M", false],
      ["staged", "both.ts", "M", false],
      ["staged", "added.ts", "A", false],
      ["staged", "added-then-edited.ts", "A", false],
      ["staged", "removed.ts", "D", false],
      ["unstaged", "unstaged.ts", "M", false],
      ["unstaged", "both.ts", "M", false],
      ["unstaged", "added-then-edited.ts", "M", false],
      ["unstaged", "deleted.ts", "D", false],
      ["unstaged", "new.ts", "A", true],
      ["unstaged", "conflict.ts", "U", false],
      ["unstaged", "both-added.ts", "U", false],
    ],
  );
});

test("each section takes its own counts", () => {
  const staged = parseNumstat("2\t3\tboth.ts\0-\t-\timage.png\0"),
    unstaged = parseNumstat("5\t7\tboth.ts\0");
  assert.deepEqual(staged["image.png"], { add: 0, del: 0, binary: true });
  assert.deepEqual(
    changedFiles([{ xy: "MM", path: "both.ts" }], staged, unstaged).map(({ add, del }) => [
      add,
      del,
    ]),
    [
      [2, 3],
      [5, 7],
    ],
  );
});

test("a repository without commits has no HEAD", () => {
  assert.equal(parseStatus("## No commits yet on main\0A  a.ts\0").hasHead, false);
  assert.equal(parseStatus("## Initial commit on master\0").hasHead, false);
  assert.equal(parseStatus("## HEAD (no branch)\0").hasHead, true);
  assert.deepEqual(parseStatus("## main\0A  a.ts\0").entries, [{ xy: "A ", path: "a.ts" }]);
});

test("the branch line names the branch, its upstream, and how far apart they are", () => {
  const branch = (line: string) => {
    const { branch, upstream, ahead, behind } = parseStatus(`${line}\0`);
    return { branch, upstream, ahead, behind };
  };
  assert.deepEqual(branch("## main...origin/main [ahead 1, behind 22]"), {
    branch: "main",
    upstream: "origin/main",
    ahead: 1,
    behind: 22,
  });
  assert.deepEqual(branch("## main...origin/main"), {
    branch: "main",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
  });
  assert.deepEqual(branch("## feat/x"), { branch: "feat/x", upstream: null, ahead: 0, behind: 0 });
  assert.equal(branch("## main...origin/main [gone]").upstream, null);
  assert.equal(branch("## HEAD (no branch)").branch, null);
  assert.equal(branch("## No commits yet on main").branch, null);
});

test("a nested repository's entry drops its trailing slash, so no folder row shares its key", () => {
  const { entries } = parseStatus("## main\0?? dashboard/\0?? docs/a.md\0");
  assert.deepEqual(
    entries.map((entry) => entry.path),
    ["dashboard", "docs/a.md"],
  );
});
