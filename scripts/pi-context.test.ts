import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

async function harness(terminal: string | undefined = "t7") {
  const context = vm.createContext({ process: { env: { HC_TERMINAL_ID: terminal } } });
  const module = new vm.SourceTextModule(
    stripTypeScriptTypes(await readFile(new URL("pi-context.ts", import.meta.url), "utf8")),
    { context },
  );
  await module.link(() => assert.fail("Pi's extension must be a standalone file"));
  await module.evaluate();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
  const calls: unknown[] = [];
  let fail = false;
  (module.namespace as { default: Function }).default({
    on: (event, handler) => handlers.set(event, handler),
    exec: async (...args) => {
      calls.push(JSON.parse(JSON.stringify(args)));
      if (fail) throw new Error("Core unavailable");
      return { code: 0 };
    },
  });
  return {
    handlers,
    calls,
    fail: () => {
      fail = true;
    },
  };
}

test("Pi publishes its own context estimate on session, model, and turn changes", async () => {
  const h = await harness();
  let usage = { tokens: 42000, contextWindow: 200000 };
  const ctx = { getContextUsage: () => usage };
  for (const event of [
    "session_start",
    "session_compact",
    "session_tree",
    "model_select",
    "agent_start",
    "turn_end",
    "agent_end",
  ]) {
    assert.ok(h.handlers.has(event), event);
    await h.handlers.get(event)({}, ctx);
    assert.deepEqual(h.calls.at(-1), [
      "hc",
      [
        "label",
        "t7",
        `frantss.context=${JSON.stringify({ tokens: usage.tokens, window: usage.contextWindow })}`,
      ],
      { timeout: 1000 },
    ]);
    usage = { tokens: usage.tokens + 1000, contextWindow: usage.contextWindow + 10000 };
  }
});

test("Pi clears old usage after compaction, shutdown, or an unavailable context API", async () => {
  const h = await harness();
  for (const usage of [
    undefined,
    { tokens: null, contextWindow: 200000 },
    { tokens: -1, contextWindow: 200000 },
    { tokens: 10, contextWindow: 0 },
    { tokens: Infinity, contextWindow: 200000 },
  ]) {
    await h.handlers.get("session_compact")({}, { getContextUsage: () => usage });
    assert.deepEqual(h.calls.at(-1), [
      "hc",
      ["label", "t7", "frantss.context="],
      { timeout: 1000 },
    ]);
  }
  await h.handlers.get("session_start")(
    {},
    {
      getContextUsage: () => {
        throw new Error("API changed");
      },
    },
  );
  assert.deepEqual(h.calls.at(-1), ["hc", ["label", "t7", "frantss.context="], { timeout: 1000 }]);
  await h.handlers.get("session_shutdown")({}, {});
  assert.deepEqual(h.calls.at(-1), ["hc", ["label", "t7", "frantss.context="], { timeout: 1000 }]);
});

test("Pi continues when Herdr cannot receive the context label", async () => {
  const h = await harness();
  h.fail();
  await h.handlers.get("turn_end")(
    {},
    { getContextUsage: () => ({ tokens: 0, contextWindow: 200000 }) },
  );
  assert.deepEqual(h.calls[0], [
    "hc",
    ["label", "t7", 'frantss.context={"tokens":0,"window":200000}'],
    { timeout: 1000 },
  ]);
});

test("Pi outside Herdr registers no handlers", async () => {
  const h = await harness("");
  assert.equal(h.handlers.size, 0);
  assert.equal(h.calls.length, 0);
});
