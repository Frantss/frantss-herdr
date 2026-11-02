import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import type * as KnownAgents from "./known-agents.ts";

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test("known agents keep other machines' lists and write only when one changes", async () => {
  let state: Record<string, unknown[]> | null = { build: [{ key: "pi" }] };
  const writes = [];
  const asked = [];
  const answers: Record<string, unknown[]> = { "": [{ key: "codex" }], build: [{ key: "pi" }] };
  const herdr = {
    shared: () => state,
    setShared: (key: string, value: typeof state) => {
      writes.push(key);
      state = value;
    },
    knownAgents: async ({ on }: { on: string | null }) => {
      asked.push(on);
      return answers[on ?? ""];
    },
  };
  const context = vm.createContext({});
  const module = new vm.SourceTextModule(
    stripTypeScriptTypes(await readFile(new URL("known-agents.ts", import.meta.url), "utf8")),
    { context },
  );
  await module.link(
    async () =>
      new vm.SyntheticModule(
        Object.keys(herdr),
        function () {
          for (const [key, value] of Object.entries(herdr)) this.setExport(key, value);
        },
        { context },
      ),
  );
  await module.evaluate();
  const agents = module.namespace as typeof KnownAgents;

  assert.deepEqual(plain(agents.cachedAgents("")), []);
  assert.deepEqual(plain(await agents.refreshAgents("")), [{ key: "codex" }]);
  assert.deepEqual(plain(state), { build: [{ key: "pi" }], "": [{ key: "codex" }] });
  assert.deepEqual(plain(agents.cachedAgents("")), [{ key: "codex" }]);
  await agents.refreshAgents("build");
  assert.deepEqual(asked, [null, "build"]);
  assert.deepEqual(writes, ["frantss.agents"], "An unchanged list is not written again");
  assert.deepEqual(plain(agents.cachedAgents("build")), [{ key: "pi" }]);
});
