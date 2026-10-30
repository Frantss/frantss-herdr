import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

async function load(statuses: Record<string, string>) {
  const context = vm.createContext({});
  const herdr = {
    notify: () => {},
    agents: () => Object.entries(statuses).map(([address, status]) => ({ address, status })),
    hc: async () => ({
      code: 0,
      stdout: JSON.stringify({ text: "working…\n─────\n│ Proceed? │\n" }),
      stderr: "",
    }),
  };
  const module = new vm.SourceTextModule(
    stripTypeScriptTypes(await readFile(new URL("agent-hc.ts", import.meta.url), "utf8")),
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
  return module.namespace as typeof import("./agent-hc.ts");
}

test("question lines skip rules and box borders and keep the last lines with text", async () => {
  const { questionLines } = await load({});
  const screen = [
    "earlier output",
    "╭──────────────────────────╮",
    "│ Bash command             │",
    "│   rm -rf dist            │",
    "│ Do you want to proceed?  │",
    "│ ❯ 1. Yes                 │",
    "│   2. No                  │",
    "╰──────────────────────────╯",
    "",
  ].join("\n");
  assert.deepEqual(Array.from(questionLines(screen, 4)), [
    "  rm -rf dist",
    "Do you want to proceed?",
    "❯ 1. Yes",
    "  2. No",
  ]);
});

test("reading a question reads the agent's screen", async () => {
  const { readQuestion } = await load({});
  assert.deepEqual(Array.from(await readQuestion("t1", 4)), ["working…", "Proceed?"]);
});

test("a reply forces its way only into a blocked agent", async () => {
  const { replyArgs } = await load({ t1: "blocked", t2: "idle" });
  assert.deepEqual(Array.from(replyArgs("t1", "yes")), ["send", "--force", "t1", "yes"]);
  assert.deepEqual(Array.from(replyArgs("t2", "go on")), ["send", "t2", "go on"]);
});
