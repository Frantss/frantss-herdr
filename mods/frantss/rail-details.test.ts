import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { stampStatuses } from "./status-since.ts";
import { parseBranchStatus } from "./branch-status.ts";
import { WORKSPACE_PALETTE, assignColors } from "./workspace-colors.ts";

const DAY = 86_400_000;

test("status stamps change only with the status, treating done and idle as one", () => {
  const first = stampStatuses({}, [{ address: "a", status: "working" }], 1000);
  assert.deepEqual(first, { a: { status: "working", at: 1000 } });
  assert.equal(stampStatuses(first, [{ address: "a", status: "working" }], 2000), null);
  const done = stampStatuses(first, [{ address: "a", status: "done" }], 3000);
  assert.deepEqual(done, { a: { status: "idle", at: 3000 } });
  assert.equal(stampStatuses(done, [{ address: "a", status: "idle" }], 4000), null);
});

test("status stamps of unlisted agents go only once they are old", () => {
  const stamps = { old: { status: "idle", at: 0 }, recent: { status: "idle", at: 29 * DAY } };
  const next = stampStatuses(stamps, [{ address: "new", status: "working" }], 31 * DAY);
  assert.deepEqual(Object.keys(next).sort(), ["new", "recent"]);
});

test("branch status reads ahead and behind, and none without an upstream", () => {
  const output =
    "# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -3\n";
  assert.deepEqual(parseBranchStatus(output), { ahead: 2, behind: 3 });
  assert.deepEqual(parseBranchStatus("# branch.head main\n"), { ahead: 0, behind: 0 });
});

test("workspace colors keep existing ones, give new ones the least used, and drop gone ones", () => {
  assert.deepEqual(assignColors({ old: "#22a99a" }, ["old"]), { old: WORKSPACE_PALETTE[0] });
  const first = assignColors({}, ["a", "b"]);
  assert.deepEqual(first, { a: WORKSPACE_PALETTE[0], b: WORKSPACE_PALETTE[1] });
  assert.equal(assignColors(first, ["a", "b"]), null);
  assert.deepEqual(assignColors(first, ["b", "c"]), {
    b: WORKSPACE_PALETTE[1],
    c: WORKSPACE_PALETTE[0],
  });
});
