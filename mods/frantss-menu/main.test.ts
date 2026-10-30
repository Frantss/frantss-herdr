import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const records = [
  { address: "t1", cwd: "/repo" },
  { address: "t2", cwd: "/repo", parent: "t1" },
  { address: "t3", cwd: "/repo" },
];

async function load() {
  const context = vm.createContext({});
  const empty = () => {};
  const natives: Record<string, Record<string, unknown>> = {
    "gpui-kit": { View: class {}, div: empty, svg: empty },
    "gpui-base": { v_flex: empty, h_flex: empty },
    herdr: {
      run: empty,
      props: empty,
      agents: () => [{ address: "t1" }, { address: "t2" }],
      hc: empty,
      notify: empty,
      closeOverlay: empty,
      openOverlay: empty,
      theme: empty,
      keys: () => [],
      terminals: () => records,
      spaces: () => [],
      panes: () => [],
      exec: empty,
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
  return module.namespace as typeof import("./main.ts");
}

const paneMenu = async (terminal: string) =>
  JSON.parse(
    JSON.stringify((await load()).items({ tab: "pane", target: { pane: "p1", terminal } }, null)),
  ) as [string, string, Record<string, string>][];

test("an agent's pane menu starts with its actions and can send it back", async () => {
  assert.deepEqual(await paneMenu("t1"), [
    ["Peek", "terminal.peek", { terminal: "t1" }],
    ["Reply…", "reply", { terminal: "t1" }],
    ["Interrupt", "interrupt", { terminal: "t1" }],
    ["Copy address", "copy", { text: "t1" }],
    ["Copy folder", "copy", { text: "/repo" }],
    ["Kill…", "kill", { terminal: "t1" }],
    ["Split right", "pane.split", { direction: "right", pane: "p1" }],
    ["Split down", "pane.split", { direction: "down", pane: "p1" }],
    ["Zoom", "pane.zoom", { pane: "p1" }],
    ["Send right-clicks to pane", "terminal.right_click", { terminal: "t1", to: "program" }],
    ["Send back", "terminal.park", { terminal: "t1" }],
    ["Close pane", "pane.close", { pane: "p1" }],
  ]);
});

test("a kept sub-agent goes back to its parent, and a plain terminal gets no agent actions", async () => {
  assert.deepEqual(
    (await paneMenu("t2")).find(([, command]) => command === "terminal.park"),
    ["Send back to t1", "terminal.park", { terminal: "t2" }],
  );
  const plain = (await paneMenu("t3")).map(([, command]) => command);
  assert.deepEqual(plain, [
    "pane.split",
    "pane.split",
    "pane.zoom",
    "terminal.right_click",
    "pane.close",
  ]);
});
