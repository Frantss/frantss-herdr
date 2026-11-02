import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import type * as MenuList from "./menu-list.ts";

async function load<T>(file: string, natives: Record<string, Record<string, unknown>>) {
  const context = vm.createContext({});
  const module = new vm.SourceTextModule(
    stripTypeScriptTypes(await readFile(new URL(file, import.meta.url), "utf8")),
    { context },
  );
  await module.link(async (name) => {
    const values = natives[name];
    assert.ok(values, `Unexpected import ${name}`);
    return new vm.SyntheticModule(
      Object.keys(values),
      function () {
        for (const [key, value] of Object.entries(values)) this.setExport(key, value);
      },
      { context },
    );
  });
  await module.evaluate();
  return module.namespace as T;
}

const list = () =>
  load<typeof MenuList>("menu-list.ts", {
    "gpui-kit": { div: () => {} },
    "gpui-base": { h_flex: () => {}, v_flex: () => {}, v_virtual_list: () => {}, Scrollbar: {} },
  });

test("arrows wrap, Home and End jump, Enter and Space choose, Escape closes", async () => {
  const { listCommand } = await list();
  const keys = ["a", "b", "c"];
  const press = (key: string, selected: string | null, modifiers = {}) =>
    JSON.parse(JSON.stringify(listCommand({ key, modifiers }, keys, selected)));
  assert.deepEqual(press("down", null), { select: "b" });
  assert.deepEqual(press("down", "c"), { select: "a" });
  assert.deepEqual(press("up", "a"), { select: "c" });
  assert.deepEqual(press("home", "c"), { select: "a" });
  assert.deepEqual(press("end", "a"), { select: "c" });
  assert.deepEqual(press("enter", "b"), { choose: "b" });
  assert.deepEqual(press("space", "b"), { choose: "b" });
  assert.deepEqual(press("escape", "b"), { close: true });
  assert.equal(press("x", "b"), null);
  assert.equal(press("down", "b", { platform: true }), null, "Shortcuts stay with the mod");
  assert.deepEqual(
    JSON.parse(JSON.stringify(listCommand({ key: "escape" }, [], null))),
    { close: true },
    "An empty list still closes",
  );
  assert.equal(listCommand({ key: "enter" }, [], null), null);
});

test("a selection that left the list falls back to the first row", async () => {
  const { listCommand, selectedKey } = await list();
  assert.equal(selectedKey(["x", "b"], "b"), "b");
  assert.equal(selectedKey(["x", "y"], "b"), "x");
  assert.equal(selectedKey([], "b"), null);
  assert.deepEqual({ ...listCommand({ key: "enter" }, ["x", "y"], "gone") }, { choose: "x" });
});
