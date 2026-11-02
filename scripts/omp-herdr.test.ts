import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

async function harness(terminal = "t7") {
  const handlers = new Map<string, Function>();
  const captures: {
    command: string;
    args: string[];
    options: Record<string, unknown>;
    payload: Record<string, unknown>;
  }[] = [];
  const labels: string[][] = [];
  const names: string[] = [];
  const timers = new Set<() => Promise<void>>();
  let name = "";
  let fail = false;
  let usage: unknown = { tokens: 42000, contextWindow: 200000 };
  let branch: unknown[] = [];
  let release: (() => void) | undefined;
  let hold = false;
  const context = vm.createContext({
    process: { env: { HC_TERMINAL_ID: terminal }, execPath: "/bin/omp" },
  });
  const module = new vm.SourceTextModule(
    stripTypeScriptTypes(await readFile(new URL("omp-herdr.ts", import.meta.url), "utf8")),
    {
      context,
      initializeImportMeta(meta) {
        meta.url = "file:///extensions/frantss-herdr.ts";
      },
    },
  );
  await module.link((specifier) => {
    const exports = {
      "node:child_process": {
        execFile(command, args, options, callback) {
          if (fail) throw new Error("Missing Node");
          return {
            kill(signal: string) {
              assert.equal(signal, "SIGKILL");
              queueMicrotask(() => callback(new Error("Killed"), "", ""));
            },
            stdin: {
              on() {},
              end(input) {
                captures.push({
                  command,
                  args: Array.from(args),
                  options,
                  payload: JSON.parse(input),
                });
                if (hold) release = () => callback(null, "", "");
                else queueMicrotask(() => callback(null, "", ""));
              },
            },
          };
        },
      },
      "node:fs": { realpathSync: () => "/checkout/scripts/omp-herdr.ts" },
      "node:path": { dirname, join },
      "node:url": { fileURLToPath },
    }[specifier];
    assert.ok(exports, specifier);
    return new vm.SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
      },
      { context },
    );
  });
  await module.evaluate();
  (module.namespace as { default: Function }).default({
    on: (event, handler) => handlers.set(event, handler),
    getSessionName: () => name,
    async setSessionName(value) {
      if (fail) throw new Error("Name unavailable");
      name = value;
      names.push(value);
    },
    async exec(command, args) {
      assert.equal(command, "hc");
      labels.push(Array.from(args));
      if (fail) throw new Error("Core unavailable");
    },
  });
  const ctx = {
    agent: { kind: "main" },
    cwd: "/workspace",
    getContextUsage: () => usage,
    setInterval(callback: () => Promise<void>, milliseconds: number) {
      assert.equal(milliseconds, 5000);
      timers.add(callback);
      return callback;
    },
    clearTimer(callback: () => Promise<void>) {
      timers.delete(callback);
    },
    sessionManager: { getSessionId: () => "session-1", getBranch: () => branch },
  };
  return {
    handlers,
    captures,
    labels,
    names,
    timers,
    ctx,
    send: async (event: string, payload = {}, currentContext = ctx) =>
      handlers.get(event)?.(payload, currentContext),
    usage(value: unknown) {
      usage = value;
    },
    branch(value: unknown[]) {
      branch = value;
    },
    name(value: string) {
      name = value;
    },
    fail(value = true) {
      fail = value;
    },
    hold(value: boolean) {
      hold = value;
    },
    release() {
      release?.();
    },
  };
}
const prompt = { reason: "prompt", prompt: "Fix the tests" };
const completed = { messages: [{ role: "assistant", stopReason: "stop" }] };

test("OMP extension leaves native status reporting alone and ignores non-Herdr runs", async () => {
  const outside = await harness("");
  assert.equal(outside.handlers.size, 0);
  const h = await harness();
  await h.send("session_start");
  assert.deepEqual(h.labels, [["label", "t7", 'frantss.context={"tokens":42000,"window":200000}']]);
  assert.equal(h.captures.length, 0);
});

test("OMP refreshes context on lifecycle events and clears invalid estimates", async () => {
  const h = await harness();
  for (const event of [
    "session_start",
    "session_switch",
    "session_branch",
    "session_tree",
    "session_compact",
    "auto_compaction_end",
    "agent_start",
    "turn_end",
    "agent_end",
  ]) {
    await h.send(event);
    assert.equal(h.labels.at(-1)?.[2], 'frantss.context={"tokens":42000,"window":200000}', event);
  }
  for (const usage of [
    undefined,
    { tokens: null, contextWindow: 100 },
    { tokens: -1, contextWindow: 100 },
    { tokens: Infinity, contextWindow: 100 },
    { tokens: 1, contextWindow: 0 },
  ]) {
    h.usage(usage);
    await h.send("session_compact");
    assert.equal(h.labels.at(-1)?.[2], "frantss.context=");
  }
  await h.send("session_shutdown");
  assert.equal(h.labels.at(-1)?.[2], "frantss.context=");
});

test("OMP's managed context timer catches idle model changes without repeated labels", async () => {
  const h = await harness();
  await h.send("session_start");
  const tick = [...h.timers][0];
  await tick();
  assert.equal(h.labels.length, 1);
  h.usage({ tokens: 100, contextWindow: 400000 });
  await tick();
  assert.equal(h.labels.at(-1)?.[2], 'frantss.context={"tokens":100,"window":400000}');
  await h.send("session_shutdown");
  assert.equal(h.timers.size, 0);
  await tick();
  assert.equal(h.labels.at(-1)?.[2], "frantss.context=");
});

test("OMP names sessions before its auto-title and preserves explicit names", async () => {
  const h = await harness();
  await h.send("input", { text: "/model" });
  assert.equal(h.names.length, 0);
  await h.send("input", { text: "\n Fix   labels\nCheck the result" });
  assert.deepEqual(h.names, ["Fix labels"]);
  await h.send("before_agent_start", prompt);
  assert.deepEqual(h.names, ["Fix labels"]);
  h.name("");
  h.branch([
    {
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "Original task" }] },
    },
  ]);
  await h.send("session_start");
  assert.equal(h.names.at(-1), "Original task");
  h.name("");
  h.branch([]);
  await h.send("input", { text: "\u001b\u0007" + "A".repeat(100) });
  assert.equal(h.names.at(-1), "A".repeat(80));
});

test("OMP records once across retries, background work and re-entrant preparation", async () => {
  const h = await harness();
  await h.send("before_agent_start", { reason: "revive", prompt: "" });
  assert.equal(h.captures.length, 0);
  await h.send("before_agent_start", prompt);
  await h.send("before_agent_start", prompt);
  for (const awaitingAsyncWork of [false, true]) {
    await h.send("agent_end", { ...completed, willContinue: true, awaitingAsyncWork });
    await h.send("agent_start");
  }
  assert.equal(h.captures.length, 1);
  await h.send("agent_end", completed);
  await h.send("agent_end", completed);
  assert.deepEqual(
    h.captures.map((call) => call.payload.hook_event_name),
    ["before_agent_start", "agent_settled"],
  );
  assert.equal(h.captures[1].payload.outcome, "completed");
  assert.equal(h.captures[0].command, "node");
  assert.deepEqual(h.captures[0].args, ["/checkout/scripts/turn-hooks.mjs", "omp"]);
  assert.equal(h.captures[0].options.timeout, 16000);
});

test("OMP classifies final errors and interruptions and starts later requests separately", async () => {
  const h = await harness();
  for (const [stopReason, outcome] of [
    ["aborted", "aborted"],
    ["error", "error"],
    ["stop", "completed"],
  ]) {
    await h.send("before_agent_start", prompt);
    await h.send("agent_end", {
      messages: [
        { role: "assistant", stopReason: "error" },
        { role: "user" },
        { role: "assistant", stopReason },
      ],
    });
    assert.equal(h.captures.at(-1)?.payload.outcome, outcome);
  }
  assert.equal(h.captures.length, 6);
});

test("OMP ignores inherited subagent and advisor events, including shutdown", async () => {
  const h = await harness();
  const sub = { ...h.ctx, agent: { kind: "sub" } };
  for (const event of h.handlers.keys()) await h.send(event, prompt, sub);
  assert.equal(h.names.length + h.labels.length + h.captures.length, 0);
  await h.send("before_agent_start", prompt);
  await h.send("agent_end", completed, sub);
  assert.equal(h.captures.length, 1);
  await h.send("agent_end", completed);
  assert.equal(h.captures.length, 2);
});

test("OMP closes the old request on session changes or shutdown with a bounded capture", async () => {
  for (const event of ["session_switch", "session_branch", "session_tree", "session_shutdown"]) {
    const h = await harness();
    await h.send("before_agent_start", prompt);
    await h.send(
      event,
      {},
      {
        ...h.ctx,
        cwd: "/other",
        sessionManager: { ...h.ctx.sessionManager, getSessionId: () => "session-2" },
      },
    );
    assert.equal(h.captures[1].payload.cwd, "/workspace");
    assert.equal(h.captures[1].payload.session_id, "session-1");
    assert.equal(h.captures[1].payload.aborted, true);
    assert.equal(h.captures[1].options.timeout, 1500);
    await h.send("session_shutdown");
    assert.equal(h.captures.length, 2);
  }
});

test("OMP waits for a previous end snapshot before letting the next request edit", async () => {
  const h = await harness();
  await h.send("before_agent_start", prompt);
  h.hold(true);
  const end = h.send("agent_end", completed);
  await new Promise((resolve) => setImmediate(resolve));
  const begin = h.send("before_agent_start", { ...prompt, prompt: "Next request" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.captures.length, 2);
  h.hold(false);
  h.release();
  await Promise.all([end, begin]);
  assert.equal(h.captures[2].payload.prompt, "Next request");
});

test("OMP shutdown cancels an in-flight capture before starting its bounded final capture", async () => {
  const h = await harness();
  h.hold(true);
  const begin = h.send("before_agent_start", prompt);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.captures.length, 1);
  h.hold(false);
  await h.send("session_shutdown");
  await begin;
  assert.equal(h.captures.length, 2);
  assert.equal(h.captures[1].payload.hook_event_name, "session_shutdown");
  assert.equal(h.captures[1].options.timeout, 1500);
  assert.equal(h.labels.at(-1)?.[2], "frantss.context=");
});

test("OMP shutdown can close a request whose final capture is still in flight", async () => {
  const h = await harness();
  await h.send("before_agent_start", prompt);
  h.hold(true);
  const end = h.send("agent_end", completed);
  await new Promise((resolve) => setImmediate(resolve));
  h.hold(false);
  await h.send("session_shutdown");
  await end;
  assert.equal(h.captures.length, 3);
  assert.equal(h.captures[2].payload.hook_event_name, "session_shutdown");
  assert.equal(h.captures[2].payload.aborted, true);
});

test("OMP integration failures do not block the agent or poison later captures", async () => {
  const h = await harness();
  h.fail();
  await h.send("session_start");
  await h.send("before_agent_start", prompt);
  await h.send("agent_end", completed);
  h.fail(false);
  await h.send("before_agent_start", prompt);
  await h.send("agent_end", completed);
  assert.equal(h.captures.length, 2);
});
