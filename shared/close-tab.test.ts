import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

async function load(tabs: string[]) {
  const context = vm.createContext({});
  const opened: Record<string, unknown>[] = [];
  const herdr = {
    openOverlay: (spec: Record<string, unknown>) => (opened.push(spec), "o1"),
    spaces: () => [{ id: "s1", tabs: tabs.map((id) => ({ id })) }],
  };
  const source = stripTypeScriptTypes(
    await readFile(new URL("close-tab.ts", import.meta.url), "utf8"),
  );
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
  const { closeTab } = module.namespace as typeof import("./close-tab.ts");
  return { closeTab, opened };
}

test("closing a tab asks first and closes it confirmed", async () => {
  const { closeTab, opened } = await load(["t1", "t2"]);
  closeTab("t2", "claude");
  assert.equal(opened.length, 1);
  const { mod, kind, props } = opened[0] as {
    mod: string;
    kind: string;
    props: { title: string; detail: string; command: unknown };
  };
  assert.equal(mod, "confirm");
  assert.equal(kind, "dialog");
  assert.equal(props.title, "Close claude?");
  assert.doesNotMatch(props.detail, /space/);
  assert.equal(
    JSON.stringify(props.command),
    JSON.stringify({ name: "tab.close", args: { id: "t2", confirmed: true } }),
  );
});

test("closing a space's last tab says the space closes too", async () => {
  const { closeTab, opened } = await load(["t1"]);
  closeTab("t1", "terminal");
  assert.match((opened[0].props as { detail: string }).detail, /space closes too/);
});
