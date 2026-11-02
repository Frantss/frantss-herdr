import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const record = (overrides = {}) => ({
  address: "t1",
  state: "live",
  status: { state: "idle" },
  turn: 8,
  ...overrides,
});

async function load(getResult: unknown = record(), labelCode = 0, getCode = 0) {
  const context = vm.createContext({});
  const calls: string[][] = [];
  const notices: unknown[] = [];
  const herdr = {
    agents: () => [],
    hc: async (args: string[]) => {
      calls.push(Array.from(args));
      if (args[0] === "get") {
        if (getResult instanceof Error) throw getResult;
        return typeof getResult === "string"
          ? { code: getCode, stdout: getResult, stderr: getCode ? "not found" : "" }
          : {
              code: getCode,
              stdout: JSON.stringify(getResult),
              stderr: getCode ? "not found" : "",
            };
      }
      if (labelCode < 0) throw new Error("offline");
      return { code: labelCode, stdout: "", stderr: labelCode ? "offline" : "" };
    },
    notify: (notice: unknown) => notices.push(notice),
    shared: () => assert.fail("Unread must not read local overlay state"),
    setShared: () => assert.fail("Unread must not write local overlay state"),
  };
  const native = new vm.SyntheticModule(
    Object.keys(herdr),
    function () {
      for (const [key, value] of Object.entries(herdr)) this.setExport(key, value);
    },
    { context },
  );
  const helper = new vm.SourceTextModule(
    stripTypeScriptTypes(await readFile(new URL("agent-hc.ts", import.meta.url), "utf8")),
    { context },
  );
  const module = new vm.SourceTextModule(
    stripTypeScriptTypes(await readFile(new URL("unread.ts", import.meta.url), "utf8")),
    { context },
  );
  await module.link((name) => (name === "herdr" ? native : helper));
  await module.evaluate();
  return { unread: module.namespace as typeof import("./unread.ts"), calls, notices };
}

test("mark unread lowers the current core turn, without a local status overlay", async () => {
  const { unread, calls, notices } = await load();
  await unread.markUnread("t1");
  assert.deepEqual(calls, [
    ["get", "t1"],
    ["label", "t1", "herdr.seen=7"],
  ]);
  assert.equal(notices.length, 0);
  assert.deepEqual(Object.keys(unread), ["markUnread"]);
});

test("mark unread preserves the remote qualified target", async () => {
  const { unread, calls } = await load(record({ address: "mac/t1", turn: 2 }));
  await unread.markUnread("mac/t1");
  assert.deepEqual(calls, [
    ["get", "mac/t1"],
    ["label", "mac/t1", "herdr.seen=1"],
  ]);
});

test("turn zero has no completed turn to mark", async () => {
  const { unread, calls, notices } = await load(record({ turn: 0 }));
  await unread.markUnread("t1");
  assert.deepEqual(calls, [["get", "t1"]]);
  assert.equal(notices.length, 0);
});

test("missing, invalid, finished or changed records cannot be marked", async () => {
  for (const invalid of [
    null,
    {},
    record({ turn: undefined }),
    record({ turn: -1 }),
    record({ turn: 1.5 }),
    record({ turn: "8" }),
    record({ turn: Number.MAX_SAFE_INTEGER + 1 }),
    record({ state: "finished" }),
    record({ address: "t2" }),
    record({ status: { state: "working" } }),
    record({ status: null }),
  ]) {
    const { unread, calls, notices } = await load(invalid);
    await unread.markUnread("t1");
    assert.deepEqual(calls, [["get", "t1"]]);
    assert.equal(notices.length, 1);
  }
});

test("read errors and malformed responses are visible and do not write labels", async () => {
  for (const response of [new Error("offline"), "not json"]) {
    const { unread, calls, notices } = await load(response);
    await unread.markUnread("t1");
    assert.deepEqual(calls, [["get", "t1"]]);
    assert.equal(notices.length, 1);
  }
});

test("failed reads preserve the core error and never label", async () => {
  const { unread, calls, notices } = await load(record(), 0, 3);
  await unread.markUnread("t1");
  assert.deepEqual(calls, [["get", "t1"]]);
  assert.equal(notices.length, 1);
  assert.match((notices[0] as { body: string }).body, /not found/);
});

test("label errors and rejected commands remain visible", async () => {
  for (const code of [1, -1]) {
    const { unread, notices } = await load(record(), code);
    await unread.markUnread("t1");
    assert.equal(notices.length, 1);
    if (code === 1) assert.equal((notices[0] as { body: string }).body, "offline");
  }
});
