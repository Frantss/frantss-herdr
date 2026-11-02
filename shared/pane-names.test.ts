import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

async function load() {
  const state = {
    names: { p1: "My pane", "remote/p1": "Remote pane", gone: "Closed" },
    panes: [{ pane: "p1", title: "Live title", tab: "tab1" }],
    machines: [
      { name: null, layout: "ready" },
      { name: "remote", layout: "unavailable" },
    ],
    writes: 0,
  };
  const context = vm.createContext({});
  const natives = {
    shared: (key) => {
      assert.equal(key, "frantss.paneNames");
      return state.names;
    },
    setShared: (key, value) => {
      assert.equal(key, "frantss.paneNames");
      state.names = JSON.parse(JSON.stringify(value));
      state.writes++;
    },
    panes: () => state.panes,
    machines: () => state.machines,
  };
  const module = new vm.SourceTextModule(
    stripTypeScriptTypes(await readFile(new URL("pane-names.ts", import.meta.url), "utf8")),
    { context },
  );
  await module.link(async (name) => {
    if (name.startsWith("./"))
      return new vm.SourceTextModule(
        stripTypeScriptTypes(await readFile(new URL(name, import.meta.url), "utf8")),
        { context },
      );
    return new vm.SyntheticModule(
      Object.keys(natives),
      function () {
        for (const [key, value] of Object.entries(natives)) this.setExport(key, value);
      },
      { context },
    );
  });
  await module.evaluate();
  return { state, names: module.namespace as typeof import("./pane-names.ts") };
}

test("pane aliases preserve case, survive fresh views and live titles, and leave named tabs intact", async () => {
  const { state, names } = await load();
  const pane = state.panes[0] as unknown as import("herdr").PaneInfo;
  assert.equal(names.paneName(pane), "My pane");
  pane.title = "Changed by program";
  assert.equal(names.paneName(pane), "My pane");
  const tab = { named: false } as import("herdr").TabInfo;
  const space = { branch: "feature" } as import("herdr").SpaceInfo;
  assert.equal(names.tabName(tab, [pane], space), "My pane");
  assert.equal(names.tabName({ ...tab, named: true, name: "My tab" }, [pane], space), "My tab");
  assert.equal(names.tabName(tab, [pane, pane], space), "feature");
});

test("saving and clearing a pane alias persist without changing another pane or terminal title", async () => {
  const { state, names } = await load();
  names.setPaneName("p1", "  New NAME  ");
  assert.equal(state.names.p1, "New NAME");
  assert.equal(state.names["remote/p1"], "Remote pane");
  assert.equal(state.panes[0].title, "Live title");
  names.setPaneName("p1", "   ");
  assert.equal(Object.hasOwn(state.names, "p1"), false);
  assert.equal(names.paneName(state.panes[0] as unknown as import("herdr").PaneInfo), "live title");
  names.setPaneName("missing", "Do not save a closed pane");
  assert.equal(Object.hasOwn(state.names, "missing"), false);
});

test("cleanup removes closed panes only on machines with a loaded layout and avoids repeat writes", async () => {
  const { state, names } = await load();
  names.prunePaneNames(state.panes as unknown as import("herdr").PaneInfo[]);
  assert.deepEqual(state.names, { p1: "My pane", "remote/p1": "Remote pane" });
  assert.equal(state.writes, 1);
  names.prunePaneNames(state.panes as unknown as import("herdr").PaneInfo[]);
  assert.equal(state.writes, 1);
  state.machines[1].layout = "loading";
  names.prunePaneNames(state.panes as unknown as import("herdr").PaneInfo[]);
  assert.equal(state.writes, 1);
  state.machines[1].layout = "ready";
  names.prunePaneNames(state.panes as unknown as import("herdr").PaneInfo[]);
  assert.deepEqual(state.names, { p1: "My pane" });
});
