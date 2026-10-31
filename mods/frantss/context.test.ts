import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { contextUsage, tokenCount, usageLineArgv, usedPercent } from "./context.ts";

const claudeLine = JSON.stringify({
  type: "assistant",
  message: {
    model: "claude-opus-5-5",
    usage: {
      input_tokens: 2,
      cache_creation_input_tokens: 1292,
      cache_read_input_tokens: 210344,
      output_tokens: 1192,
    },
  },
});
const codexLine = JSON.stringify({
  type: "event_msg",
  payload: {
    type: "token_count",
    info: {
      total_token_usage: { total_tokens: 90000 },
      last_token_usage: { input_tokens: 25445, output_tokens: 188, total_tokens: 25633 },
      model_context_window: 475000,
    },
  },
});

test("Claude Code's context is its last request's input and cache tokens, with no window", () => {
  assert.deepEqual(contextUsage("claude-code", claudeLine), { tokens: 211638, window: null });
});

test("Codex's context is its last turn against the model's window", () => {
  const usage = contextUsage("codex", codexLine);
  assert.deepEqual(usage, { tokens: 25633, window: 475000 });
  assert.equal(usedPercent(usage), 5);
});

test("unreadable lines and other apps give no usage", () => {
  assert.equal(contextUsage("codex", "not json"), null);
  assert.equal(contextUsage("codex", JSON.stringify({ payload: { info: {} } })), null);
  assert.equal(contextUsage("claude-code", JSON.stringify({ message: {} })), null);
  assert.equal(contextUsage("pi", claudeLine), null);
  assert.equal(usageLineArgv("pi", "/session.jsonl"), null);
});

test("the usage line is the last grep match in the session file", () => {
  assert.deepEqual(usageLineArgv("codex", "/s.jsonl"), [
    "sh",
    "-c",
    'grep -F -- "$1" "$2" | tail -n 1',
    "frantss-context",
    '"type":"token_count","info":{',
    "/s.jsonl",
  ]);
});

test("token counts and percents read short", () => {
  assert.equal(tokenCount(840), "840");
  assert.equal(tokenCount(84_400), "84k");
  assert.equal(tokenCount(1_000_000), "1M");
  assert.equal(tokenCount(1_240_000), "1.2M");
  assert.equal(usedPercent({ tokens: 950, window: 1000 }), 95);
  assert.equal(usedPercent({ tokens: 2000, window: 1000 }), 100);
  assert.equal(usedPercent({ tokens: 10, window: null }), null);
});
