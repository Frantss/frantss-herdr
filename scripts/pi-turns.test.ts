import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

async function harness(terminal: string | undefined = "t7") {
  const calls: {
    command: string;
    args: string[];
    options: Record<string, unknown>;
    payload: Record<string, unknown>;
  }[] = [];
  const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<void>>();
  let fail = false;
  const canonicalExtension = "/checkout/scripts/pi-turns.ts";
  const context = vm.createContext({
    process: { env: { HC_TERMINAL_ID: terminal }, execPath: process.execPath },
  });
  const module = new vm.SourceTextModule(
    stripTypeScriptTypes(await readFile(new URL("pi-turns.ts", import.meta.url), "utf8")),
    {
      context,
      initializeImportMeta(meta) {
        meta.url = "file:///extensions/pi-turns.ts";
      },
    },
  );
  await module.link(async (specifier) => {
    let exports: Record<string, unknown>;
    if (specifier === "node:child_process") {
      exports = {
        execFile(
          command: string,
          args: string[],
          options: Record<string, unknown>,
          callback: Function,
        ) {
          if (fail) throw new Error("Node unavailable");
          return {
            stdin: {
              on() {},
              end(input: string) {
                calls.push({ command, args, options, payload: JSON.parse(input) });
                queueMicrotask(() => callback(null, "", ""));
              },
            },
          };
        },
      };
    } else if (specifier === "node:fs") {
      exports = { realpathSync: () => canonicalExtension };
    } else if (specifier === "node:path") {
      exports = { dirname, join };
    } else if (specifier === "node:url") {
      exports = { fileURLToPath };
    } else {
      assert.fail(`Unexpected dependency: ${specifier}`);
    }
    return new vm.SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
      },
      { context },
    );
  });
  await module.evaluate();
  (module.namespace as { default: Function }).default({
    on(event: string, handler: (event: unknown, ctx?: unknown) => Promise<void>) {
      handlers.set(event, handler);
    },
  });
  const ctx = { cwd: "/workspace", sessionManager: { getSessionId: () => "session-1" } };
  return {
    calls,
    handlers,
    ctx,
    fail(value = true) {
      fail = value;
    },
    async send(event: string, payload: unknown = {}, currentContext: unknown = ctx) {
      return handlers.get(event)?.(payload, currentContext);
    },
  };
}

test("Pi uses user-request start and final settlement, never model or low-level agent end", async () => {
  const h = await harness();
  assert.deepEqual(
    [...h.handlers.keys()],
    ["before_agent_start", "agent_before_settle", "agent_settled", "session_shutdown"],
  );
  assert.equal(
    await h.send("before_agent_start", { messageType: "user", prompt: "Fix the tests" }),
    undefined,
  );
  for (const event of [
    "agent_start",
    "turn_start",
    "turn_end",
    "agent_end",
    "session_before_compact",
    "session_compact",
  ]) {
    await h.send(event);
  }
  assert.equal(h.calls.length, 1);
  assert.equal(
    await h.send("agent_before_settle", { outcome: "completed", continue: true }),
    undefined,
  );
  await h.send("agent_start");
  await h.send("turn_end");
  await h.send("agent_end");
  await h.send("agent_before_settle", { outcome: "completed", continue: false });
  assert.equal(h.calls.length, 1);
  assert.equal(await h.send("agent_settled", { aborted: false }), undefined);
  assert.deepEqual(
    h.calls.map(({ payload }) => payload.hook_event_name),
    ["before_agent_start", "agent_settled"],
  );
  assert.equal(h.calls[0].payload.prompt, "Fix the tests");
  assert.equal(h.calls[1].payload.outcome, "completed");
  assert.equal(h.calls[1].payload.aborted, false);
});

test("Pi resolves the canonical extension sibling and bounds silent child invocations", async () => {
  const h = await harness();
  await h.send("before_agent_start", { messageType: "user", prompt: "Task" });
  const call = h.calls[0];
  assert.equal(call.command, process.execPath);
  assert.deepEqual(Array.from(call.args), ["/checkout/scripts/turn-hooks.mjs", "pi"]);
  assert.equal(call.options.timeout, 16_000);
  assert.equal(call.options.killSignal, "SIGKILL");
  assert.equal(call.options.maxBuffer, 16 * 1024);
  await h.send("session_shutdown");
  assert.equal(h.calls.at(-1).options.timeout, 3000);
});

test("Pi ignores custom starts, duplicate begins, and duplicate settlement/shutdown", async () => {
  const h = await harness();
  await h.send("before_agent_start", {
    messageType: "custom",
    message: { content: "Internal continuation" },
  });
  await h.send("agent_settled");
  await h.send("session_shutdown");
  assert.equal(h.calls.length, 0);
  await h.send("before_agent_start", { messageType: "user", prompt: "First request" });
  await h.send("before_agent_start", { messageType: "user", prompt: "Already running" });
  await h.send("before_agent_start", { messageType: "custom" });
  assert.equal(h.calls.length, 1);
  await h.send("agent_settled", { aborted: false });
  await h.send("agent_settled", { aborted: false });
  await h.send("session_shutdown");
  assert.equal(h.calls.length, 2);
  await h.send("before_agent_start", { messageType: "user", prompt: "Next request" });
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls.at(-1).payload.prompt, "Next request");
});

test("Pi interruption closes once, and a later prompt starts a separate request", async () => {
  const h = await harness();
  await h.send("before_agent_start", { messageType: "user", prompt: "Interrupted task" });
  await h.send("agent_before_settle", { outcome: "aborted" });
  await h.send("agent_settled", { aborted: true });
  await h.send("session_shutdown");
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].payload.aborted, true);
  assert.equal(h.calls[1].payload.outcome, "aborted");
  await h.send("before_agent_start", { messageType: "user", prompt: "Try again" });
  await h.send("agent_settled", { aborted: false });
  assert.equal(h.calls.length, 4);
});

test("Pi shutdown retains the active session identity across reload, fork, or session switch", async () => {
  const h = await harness();
  await h.send("before_agent_start", { messageType: "user", prompt: "Old task" });
  const nextContext = {
    cwd: "/other-project",
    sessionManager: { getSessionId: () => "session-2" },
  };
  await h.send("session_shutdown", {}, nextContext);
  assert.equal(h.calls[1].payload.cwd, "/workspace");
  assert.equal(h.calls[1].payload.session_id, "session-1");
  assert.equal(h.calls[1].payload.aborted, true);
  await h.send("before_agent_start", { messageType: "user", prompt: "New task" }, nextContext);
  assert.equal(h.calls[2].payload.session_id, "session-2");
  assert.equal(h.calls[2].payload.cwd, "/other-project");
});

test("Pi tracks the final before-settle outcome across retries and continuations", async () => {
  const h = await harness();
  await h.send("before_agent_start", { messageType: "user", prompt: "Task" });
  await h.send("agent_before_settle", { outcome: "error", continue: true });
  await h.send("agent_before_settle", { outcome: "completed", continue: false });
  await h.send("agent_settled", { aborted: false });
  assert.equal(h.calls[1].payload.outcome, "completed");
  await h.send("before_agent_start", { messageType: "user", prompt: "Failed task" });
  await h.send("agent_before_settle", { outcome: "error" });
  await h.send("agent_settled", { aborted: false });
  assert.equal(h.calls[3].payload.outcome, "error");
});

test("Pi fails open when launching snapshots or reading the session identity fails", async () => {
  const h = await harness();
  h.fail();
  await h.send("before_agent_start", { messageType: "user", prompt: "Task" });
  await h.send("agent_settled", { aborted: false });
  h.fail(false);
  await h.send(
    "before_agent_start",
    { messageType: "user", prompt: "Missing session" },
    { cwd: "/workspace" },
  );
  assert.equal(h.calls.length, 0);
  await h.send("before_agent_start", { messageType: "user", prompt: "Recovered" });
  assert.equal(h.calls.length, 1);
});

test("Pi outside Herdr registers no handlers or processes", async () => {
  const h = await harness("");
  assert.equal(h.handlers.size, 0);
  assert.equal(h.calls.length, 0);
});
