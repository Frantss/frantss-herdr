import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import type { AsyncContext } from "gpui-kit";
import type AgentGraph from "./main.ts";

type Terminal = Parameters<AgentGraph["forest"]>[0][number];
type Result = { code: number; stdout: string; stderr: string };
const success = (value: unknown): Result => ({
  code: 0,
  stdout: JSON.stringify(value),
  stderr: "",
});
const finished = (address: string): Terminal => ({
  address,
  parent: "parent",
  state: "finished",
  finished_ms: 10000000,
});

async function harness(fetch: (args: string[]) => Promise<Result>) {
  const calls: string[][] = [];
  const tasks: Promise<unknown>[] = [];
  const timers = new Map<number, () => void>();
  const state = {
    live: [{ address: "parent", state: "live" }] as Terminal[],
    now: 10000000,
    hidden: false,
  };
  let notifications = 0;
  const cx = {
    notify() {
      notifications++;
    },
    spawn(callback: (cx: unknown) => unknown) {
      const task = Promise.resolve().then(() => callback(cx));
      tasks.push(task);
      return task;
    },
    timer: {
      every(ms: number, callback: (cx: unknown) => void) {
        timers.set(ms, () => callback(cx));
      },
    },
  };
  const context = vm.createContext({
    localStorage: { getItem: () => null, setItem() {} },
    Date: { now: () => state.now },
  });
  const empty = () => {};
  const natives = {
    "gpui-kit": { View: class {}, div: empty, image: empty, svg: empty, PathBuilder: {} },
    "gpui-base": { v_flex: empty, h_flex: empty },
    herdr: {
      agents: empty,
      terminals: () => state.live,
      panes: empty,
      focused: empty,
      run: empty,
      hc: async (args: string[]) => {
        calls.push(Array.from(args));
        return fetch(args);
      },
      settings: empty,
      theme: empty,
      props: () => null,
      spaces: () => [],
      layout: () => ({
        children: [
          { id: "panel", hidden: state.hidden },
          { id: "panel-body", active: "agent-graph" },
        ],
      }),
      shared: () => null,
    },
  };
  const module = new vm.SourceTextModule(
    stripTypeScriptTypes(await readFile(new URL("main.ts", import.meta.url), "utf8")),
    { context },
  );
  await module.link(async (name) => {
    if (name.startsWith("./"))
      return new vm.SourceTextModule(
        stripTypeScriptTypes(await readFile(new URL(name, import.meta.url), "utf8")),
        { context },
      );
    const values = natives[name];
    return new vm.SyntheticModule(
      Object.keys(values),
      function () {
        for (const [key, value] of Object.entries(values)) this.setExport(key, value);
      },
      { context },
    );
  });
  await module.evaluate();
  const Graph = (module.namespace as { default: new () => AgentGraph }).default;
  const graph = new Graph();
  const nativeContext = cx as unknown as AsyncContext;
  graph.init(undefined, nativeContext);
  return {
    graph,
    state,
    calls,
    timers,
    notifications: () => notifications,
    refresh: () => graph.syncFinished(nativeContext),
    async settle() {
      for (let index = 0; index < tasks.length; index++) await tasks[index];
    },
  };
}

test("finished agent discovery fetches at most four records concurrently", async () => {
  const records = Array.from({ length: 13 }, (_, index) => finished(`child-${index}`));
  let active = 0;
  let maximum = 0;
  const h = await harness(async (args) => {
    if (args[0] === "ls") return success({ terminals: records });
    active++;
    maximum = Math.max(maximum, active);
    await Promise.resolve();
    active--;
    return success(records.find((record) => record.address === args[1]));
  });
  await h.settle();
  assert.equal(maximum, 4);
  assert.equal(active, 0);
  assert.deepEqual(
    [...h.graph.ended.keys()].sort(),
    records.map((record) => record.address).sort(),
  );
  assert.equal(h.calls.length, 14);
  assert.equal(h.notifications(), 1);
});

test("an in-flight history refresh finishes before a changed live list starts another", async () => {
  let release: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await harness(async () => {
    await held;
    return success({ terminals: [] });
  });
  h.state.live.push({ address: "other-parent", state: "live" });
  h.refresh();
  await Promise.resolve();
  assert.equal(h.calls.length, 1);
  release();
  await h.settle();
  h.refresh();
  await h.settle();
  assert.equal(h.calls.length, 2);
});

test("failed history records retry while successful records remain cached", async () => {
  const records = [finished("good"), finished("failed"), finished("rejected")];
  let retry = false;
  const h = await harness(async (args) => {
    if (args[0] === "ls") return success({ terminals: records });
    if (!retry && args[1] === "failed") return { code: 1, stdout: "", stderr: "unavailable" };
    if (!retry && args[1] === "rejected") throw new Error("transport unavailable");
    return success(records.find((record) => record.address === args[1]));
  });
  await h.settle();
  assert.deepEqual([...h.graph.ended.keys()], ["good"]);
  retry = true;
  h.refresh();
  await h.settle();
  assert.deepEqual([...h.graph.ended.keys()].sort(), ["failed", "good", "rejected"]);
  assert.equal(h.calls.filter((args) => args[0] === "get" && args[1] === "good").length, 1);
});

test("a failed history listing retries without a live terminal change", async () => {
  let fails = true;
  const h = await harness(async () =>
    fails ? { code: 1, stdout: "", stderr: "unavailable" } : success({ terminals: [] }),
  );
  await h.settle();
  fails = false;
  h.refresh();
  await h.settle();
  assert.equal(h.calls.length, 2);
});

test("history keeps recent full records and does not refetch expired records on later polls", async () => {
  const records = [
    finished("recent"),
    { ...finished("expired"), finished_ms: 10000000 - 600000 },
    { ...finished("untimed"), finished_ms: undefined },
  ];
  const h = await harness(async (args) =>
    args[0] === "ls"
      ? success({ terminals: records })
      : success(records.find((record) => record.address === args[1])),
  );
  await h.settle();
  assert.deepEqual([...h.graph.ended.keys()], ["recent"]);
  h.graph.setScope("all");
  h.timers.get(30000)();
  await h.settle();
  assert.equal(h.calls.filter((args) => args[0] === "get").length, 3);
  assert.deepEqual([...h.graph.ended.keys()], ["recent"]);
});

test("finished full records expire while hidden without native calls or redraws", async () => {
  const record = finished("recent");
  const h = await harness(async (args) =>
    args[0] === "ls" ? success({ terminals: [record] }) : success(record),
  );
  await h.settle();
  assert.equal(h.graph.ended.size, 1);
  const callsBefore = h.calls.length;
  const notificationsBefore = h.notifications();
  h.state.hidden = true;
  h.state.now += 600000;
  h.timers.get(2000)();
  assert.equal(h.graph.ended.size, 0);
  assert.equal(h.calls.length, callsBefore);
  assert.equal(h.notifications(), notificationsBefore);
  h.state.hidden = false;
  h.timers.get(30000)();
  await h.settle();
  assert.equal(h.calls.filter((args) => args[0] === "get").length, 1);
});

test("removing expired records from core forgets their cache markers", async () => {
  const record = { ...finished("expired"), finished_ms: 1 };
  let records = [record];
  const h = await harness(async (args) =>
    args[0] === "ls" ? success({ terminals: records }) : success(record),
  );
  await h.settle();
  records = [];
  h.timers.get(30000)();
  await h.settle();
  assert.equal(h.graph.ended.size, 0);
  assert.equal(h.graph.expired.size, 0);
  records = [record];
  h.timers.get(30000)();
  await h.settle();
  assert.equal(h.calls.filter((args) => args[0] === "get").length, 2);
  assert.equal(h.graph.expired.size, 1);
});
