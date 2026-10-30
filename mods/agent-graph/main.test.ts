import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import type { AsyncContext } from "gpui-kit";
import type AgentGraph from "./main.ts";

function element() {
  const proxy = new Proxy(
    {},
    {
      get(_target, name) {
        return (...args: unknown[]) => {
          if (name === "when" && args[0]) (args[1] as (element: object) => unknown)(proxy);
          return proxy;
        };
      },
    },
  );
  return proxy;
}

test("revealing a hidden agent graph renders and refreshes its stale terminals", async () => {
  const panel = { id: "panel", hidden: true, active: "files" };
  const calls: string[][] = [];
  const tasks: Promise<unknown>[] = [];
  const timers: number[] = [];
  const reads: string[] = [];
  let notifications = 0;
  const cx = {
    focus_handle: () => ({ focus() {} }),
    notify() {
      notifications++;
    },
    spawn(callback: (cx: unknown) => unknown) {
      const task = Promise.resolve().then(() => callback(cx));
      tasks.push(task);
      return task;
    },
    timer: {
      every(ms: number) {
        timers.push(ms);
      },
    },
  };
  const context = vm.createContext({
    localStorage: { getItem: () => null },
  });
  const nativeModules: Record<string, Record<string, unknown>> = {
    "gpui-kit": { View: class {}, div: element, image: element, svg: element, PathBuilder: {} },
    "gpui-base": {
      v_flex: element,
      h_flex: element,
      Button: { new: element },
      Input: { new: element },
      InputState: { new: () => ({ on() {}, set_value() {}, focus() {}, value: () => "" }) },
    },
    herdr: {
      notify: () => {},
      openOverlay: () => {},
      setAgentOrder: () => {},
      agents: () => {
        reads.push("agents");
        return [];
      },
      terminals: () => {
        reads.push("terminals");
        return [];
      },
      panes: () => [],
      focused: () => null,
      run: () => {},
      hc: async (args: string[]) => {
        calls.push(Array.from(args));
        return { code: 0, stdout: JSON.stringify({ terminals: [] }), stderr: "" };
      },
      settings: () => ({ zoom: 1 }),
      shared: () => null,
      theme: () => {
        reads.push("theme");
        return {};
      },
      props: () => null,
      spaces: () => [],
      layout: () => ({ children: [panel] }),
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
    const values = nativeModules[name];
    assert.ok(values, `Unexpected native import ${name}`);
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
  assert.equal(graph.stale, true);
  assert.equal(tasks.length, 0);
  assert.deepEqual(calls, []);
  assert.deepEqual(timers, [2000, 30000]);
  graph.render(nativeContext);
  assert.deepEqual(reads, []);
  assert.equal(graph.stale, true);

  panel.hidden = false;
  panel.active = "agent-graph";
  assert.doesNotThrow(() => graph.render(nativeContext));
  assert.equal(graph.stale, false);
  assert.equal(tasks.length, 1);
  await Promise.all(tasks);
  assert.deepEqual(calls, [["ls", "--all", "--json"]]);
  assert.equal(notifications, 0);
  const readsBeforeHide = reads.length;
  panel.hidden = true;
  graph.render(nativeContext);
  assert.equal(reads.length, readsBeforeHide);
  assert.equal(graph.stale, false);
  panel.hidden = false;
  graph.render(nativeContext);
  assert.equal(tasks.length, 1);
});
