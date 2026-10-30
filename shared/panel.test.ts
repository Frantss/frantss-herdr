import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

async function load(host: Record<string, unknown>) {
  const context = vm.createContext({});
  const herdr = {
    focused: () => null,
    layout: () => null,
    panes: () => [],
    props: () => null,
    spaces: () => [],
    ...host,
  };
  const source = stripTypeScriptTypes(await readFile(new URL("panel.ts", import.meta.url), "utf8"));
  const module = new vm.SourceTextModule(source, { context });
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
  return module.namespace as typeof import("./panel.ts");
}

const panelLayout = (hidden: boolean, active: string) => ({
  children: [{ id: "panel", hidden, active }],
});

test("a panel copy shows only while the panel shows its child", async () => {
  for (const [hidden, active, shown] of [
    [false, "files", true],
    [false, "changes", false],
    [true, "files", false],
  ] as const) {
    const panel = await load({ layout: () => panelLayout(hidden, active) });
    assert.equal(panel.panelShown("files"), shown);
  }
  assert.equal((await load({})).panelShown("files"), true, "layouts without the panel show it");
});

test("a pane copy shows while its tab is shown, whatever the panel does", async () => {
  const spaces = [{ active: true, tabs: [{ id: "t2", active: true }] }];
  const shownIn = async (tab: string) =>
    (
      await load({
        props: () => ({ pane: true }),
        layout: () => panelLayout(true, "changes"),
        spaces: () => spaces,
        panes: () => [{ pane: "p1", tab, mod: "frantss-files" }],
      })
    ).panelShown("files");
  assert.equal(await shownIn("t2"), true);
  assert.equal(await shownIn("t1"), false);
});

test("panels follow the terminal pane focused before a mod pane", async () => {
  const all = [
    { pane: "p1", tab: "t1", cwd: "/a" },
    { pane: "p2", tab: "t1", cwd: "/b" },
    { pane: "p3", tab: "t1", mod: "frantss-files" },
  ];
  let focus = { pane: "p2" };
  const panel = await load({ panes: () => all, focused: () => focus });
  assert.equal(panel.followedPane()?.cwd, "/b");
  focus = { pane: "p3" };
  assert.equal(panel.followedPane()?.cwd, "/b");
  assert.equal(panel.followedPane({ pane: null } as never), null);
});

test("a mod pane focused first follows its tab's first terminal pane", async () => {
  const panel = await load({
    panes: () => [
      { pane: "p3", tab: "t1", mod: "frantss-files" },
      { pane: "p1", tab: "t1", cwd: "/a" },
    ],
    focused: () => ({ pane: "p3" }),
  });
  assert.equal(panel.followedPane()?.cwd, "/a");
});
