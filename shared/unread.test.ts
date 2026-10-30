import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

async function load(stored: unknown = null) {
  const context = vm.createContext({});
  const state = { value: stored, writes: 0 };
  const herdr = {
    shared: () => state.value,
    setShared: (_key: string, value: unknown) => {
      state.value = value;
      state.writes++;
    },
  };
  const module = new vm.SourceTextModule(
    stripTypeScriptTypes(await readFile(new URL("unread.ts", import.meta.url), "utf8")),
    { context },
  );
  await module.link(
    () =>
      new vm.SyntheticModule(
        Object.keys(herdr),
        function () {
          for (const [key, value] of Object.entries(herdr)) this.setExport(key, value);
        },
        { context },
      ),
  );
  await module.evaluate();
  return { unread: module.namespace as typeof import("./unread.ts"), state };
}

const agent = (address: string, status: string, focused = false) => ({ address, status, focused });
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test("a marked idle agent shows as done, and other agents keep their status", async () => {
  const { unread } = await load();
  assert.equal(unread.shownStatus(agent("t1", "idle"), ["t1"]), "done");
  assert.equal(unread.shownStatus(agent("t2", "idle"), ["t1"]), "idle");
  assert.equal(unread.shownStatus(agent("t1", "working"), ["t1"]), "working");
});

test("a mark goes when the agent stops being idle or is gone", async () => {
  const { unread } = await load();
  const list = [agent("t1", "working"), agent("t2", "blocked"), agent("t3", "idle")];
  assert.deepEqual(plain(unread.keptUnread(["t1", "t2", "t3", "t4"], list, null)), ["t3"]);
});

test("a mark goes when you go to the agent, and stays while you are still on it", async () => {
  const { unread } = await load();
  const list = [agent("t1", "idle", true)];
  assert.deepEqual(plain(unread.keptUnread(["t1"], list, "t2")), []);
  assert.deepEqual(plain(unread.keptUnread(["t1"], list, "t1")), ["t1"]);
});

test("marking adds the agent once", async () => {
  const { unread, state } = await load(["t1"]);
  unread.markUnread("t1");
  unread.markUnread("t2");
  assert.deepEqual(plain(state.value), ["t1", "t2"]);
  assert.equal(state.writes, 1);
});

test("keeping writes only when a mark goes", async () => {
  const { unread, state } = await load(["t1"]);
  unread.keepUnread([agent("t1", "idle")], null);
  assert.equal(state.writes, 0);
  unread.keepUnread([agent("t1", "working")], null);
  assert.deepEqual(plain(state.value), []);
  assert.equal(state.writes, 1);
});
