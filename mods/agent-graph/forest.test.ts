import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import type AgentGraph from "./main.ts";

type Terminal = Parameters<AgentGraph["forest"]>[0][number];

async function graph() {
  const context = vm.createContext({});
  const empty = () => {};
  const nativeModules = {
    "gpui-kit": { View: class {}, div: empty, image: empty, svg: empty, PathBuilder: {} },
    "gpui-base": { v_flex: empty, h_flex: empty },
    herdr: {
      agents: empty,
      terminals: empty,
      panes: empty,
      focused: empty,
      run: empty,
      hc: empty,
      settings: empty,
      theme: empty,
      props: () => null,
      spaces: () => [],
      layout: empty,
      shared: () => ({
        "space-a": "workspace-a",
        "space-b": "workspace-a",
        "space-c": "workspace-b",
      }),
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
  const result = new Graph();
  result.folded = new Set();
  result.scope = "all";
  return result;
}

const record = (address: string, other: Partial<Terminal> = {}): Terminal => ({
  address,
  state: "live",
  ...other,
});
const summary = (nodes: ReturnType<AgentGraph["forest"]>) =>
  JSON.parse(
    JSON.stringify(
      nodes.map((node) => ({
        address: node.k.address,
        status: node.status,
        allKids: node.allKids.map((child) => child.address),
        kids: summary(node.kids),
      })),
    ),
  );

test("agent forests retain root eligibility, child order, statuses, and folded child counts", async () => {
  const g = await graph();
  const all = [
    record("shell"),
    record("parent"),
    record("late", { parent: "parent", created_ms: 30, status: "done" }),
    record("early", { parent: "parent", created_ms: 10, state: "finished" }),
    record("tie-first", { parent: "parent", created_ms: 20 }),
    record("tie-second", { parent: "parent", created_ms: 20 }),
    record("orphan", { parent: "missing", status: "working" }),
    record("ended-root", { state: "finished", status: "working" }),
    record("error-root", { status: "error" }),
  ];
  const nodes = summary(g.forest(all, new Map(), null));
  assert.deepEqual(
    nodes.map((node) => node.address),
    ["parent", "orphan", "error-root"],
  );
  assert.deepEqual(nodes[0].allKids, ["early", "tie-first", "tie-second", "late"]);
  assert.deepEqual(
    nodes[0].kids.map((node) => node.status),
    ["finished", null, null, "idle"],
  );
  assert.equal(nodes[2].status, "blocked");
  g.folded.add("parent");
  const folded = summary(g.forest(all, new Map(), null))[0];
  assert.deepEqual(folded.allKids, nodes[0].allKids);
  assert.deepEqual(folded.kids, []);
});

test("agent forests scope roots by space, tab, workspace, and remote identity", async () => {
  const g = await graph();
  const all = [
    record("a", { status: "working", labels: { "herdr.space": "space-a", "herdr.tab": "tab-a" } }),
    record("b", { status: "working", labels: { "herdr.space": "space-b", "herdr.tab": "tab-b" } }),
    record("c", { status: "working", labels: { "herdr.space": "space-c", "herdr.tab": "tab-a" } }),
    record("remote/a", {
      status: "working",
      labels: { "herdr.space": "space-a", "herdr.tab": "tab-a" },
    }),
  ];
  const here = { space: "space-a", tab: "tab-a" } as Parameters<AgentGraph["forest"]>[2];
  for (const [scope, expected] of [
    ["space", ["a"]],
    ["tab", ["a", "c"]],
    ["workspace", ["a", "b"]],
  ] as const) {
    g.scope = scope;
    assert.deepEqual(
      summary(g.forest(all, new Map(), here)).map((node) => node.address),
      expected,
    );
  }
  g.scope = "space";
  assert.deepEqual(
    summary(g.forest(all, new Map(), { ...here, space: "remote/space-a" })).map(
      (node) => node.address,
    ),
    ["remote/a"],
  );
});

test("building a thousand-node forest reads parent relationships only a bounded number of times", async () => {
  const g = await graph();
  let parentReads = 0;
  const all = Array.from({ length: 1000 }, (_, i) =>
    Object.defineProperty(record(`t${i}`, { status: "working", created_ms: i }), "parent", {
      get() {
        parentReads++;
        return i ? "t0" : undefined;
      },
    }),
  );
  const roots = g.forest(all, new Map(), null);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].kids.length, 999);
  assert.ok(
    parentReads <= all.length * 4,
    `${parentReads} parent reads for ${all.length} terminals`,
  );
});
