import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleTurnHook } from "./turn-hooks.mjs";

const claudePrompt = {
  session_id: "abc123",
  transcript_path: "/Users/example/.claude/projects/project/session.jsonl",
  cwd: "/Users/example/project",
  permission_mode: "default",
  hook_event_name: "UserPromptSubmit",
  prompt: "Write a function to calculate the factorial of a number",
};
const codexPrompt = {
  session_id: "019a12a8-75b0-7482-9155-6acb0ad2c450",
  turn_id: "turn-1",
  transcript_path: null,
  cwd: "/workspace",
  hook_event_name: "UserPromptSubmit",
  model: "gpt-5.4",
  permission_mode: "default",
  prompt: "Fix the failing tests",
};

function harness(terminal = "t7") {
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  let fail = false;
  const engine = Object.fromEntries(
    ["beginTurn", "endTurn"].map((method) => [
      method,
      async (args: Record<string, unknown>) => {
        calls.push({ method, args });
        if (fail) throw new Error("Snapshot failed");
      },
    ]),
  );
  return {
    calls,
    fail: () => {
      fail = true;
    },
    send: (agent: string, payload: unknown) =>
      handleTurnHook(agent, payload, {
        env: { HC_TERMINAL_ID: terminal },
        engine,
      }),
  };
}

for (const [agent, prompt] of [
  ["claude-code", claudePrompt],
  ["codex", codexPrompt],
] as const) {
  test(`${agent} snapshots one request, not model/tool/compaction boundaries`, async () => {
    const h = harness();
    await h.send(agent, prompt);
    for (const event of [
      "PreModelRequest",
      "PostModelRequest",
      "PreToolUse",
      "PostToolUse",
      "PreCompact",
      "PostCompact",
      "SubagentStart",
      "SubagentStop",
      "SessionStart",
    ]) {
      await h.send(agent, { ...prompt, hook_event_name: event });
    }
    await h.send(agent, {
      ...prompt,
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: "Done",
    });
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.calls[0], {
      method: "beginTurn",
      args: {
        cwd: prompt.cwd,
        agent,
        session: prompt.session_id,
        terminal: "t7",
        title: prompt.prompt,
        replaceActive: true,
        ...(agent === "codex" ? { request: codexPrompt.turn_id } : {}),
      },
    });
    assert.deepEqual(h.calls[1], {
      method: "endTurn",
      args: {
        cwd: prompt.cwd,
        agent,
        session: prompt.session_id,
        terminal: "t7",
        status: "complete",
        continued: false,
      },
    });
  });

  test(`${agent} finalizes Stop even when already continued by another Stop hook`, async () => {
    const h = harness();
    await h.send(agent, prompt);
    await h.send(agent, {
      ...prompt,
      hook_event_name: "Stop",
      stop_hook_active: false,
    });
    await h.send(agent, {
      ...prompt,
      hook_event_name: "Stop",
      stop_hook_active: true,
    });
    await h.send(agent, {
      ...prompt,
      hook_event_name: "Stop",
      stop_hook_active: true,
    });
    assert.equal(h.calls.filter(({ method }) => method === "beginTurn").length, 1);
    assert.deepEqual(
      h.calls.slice(1).map(({ args }) => [args.status, args.continued]),
      [
        ["complete", false],
        ["complete", true],
        ["complete", true],
      ],
    );
  });
}

test("official request identifiers reach the engine without requiring newer payload fields", async () => {
  const h = harness();
  await h.send("claude-code", {
    ...claudePrompt,
    prompt_id: "550e8400-e29b-41d4-a716-446655440000",
  });
  await h.send("claude-code", claudePrompt);
  await h.send("codex", { ...codexPrompt, turn_id: "" });
  assert.equal(h.calls[0].args.request, "550e8400-e29b-41d4-a716-446655440000");
  assert.equal("request" in h.calls[1].args, false);
  assert.equal("request" in h.calls[2].args, false);
});

test("Codex interrupt and official session-end payloads close active work as interrupted", async () => {
  const h = harness();
  await h.send("codex", { ...codexPrompt, hook_event_name: "Interrupt" });
  await h.send("codex", {
    session_id: "thr_123",
    transcript_path: "/workspace/.codex/rollout.jsonl",
    cwd: "/workspace",
    hook_event_name: "SessionEnd",
    reason: "other",
  });
  await h.send("claude-code", {
    ...claudePrompt,
    hook_event_name: "SessionEnd",
    reason: "clear",
  });
  assert.deepEqual(
    h.calls.map(({ args }) => args.status),
    ["interrupted", "interrupted", "interrupted"],
  );
  assert.ok(h.calls.every(({ args }) => !("continued" in args)));
});

test("Claude API failure closes the request; the next prompt replaces an interrupted active request", async () => {
  const h = harness();
  await h.send("claude-code", {
    ...claudePrompt,
    hook_event_name: "StopFailure",
    error: "rate_limit",
    error_details: "429 Too Many Requests",
  });
  assert.equal(h.calls[0].args.status, "error");
  await h.send("claude-code", claudePrompt);
  await h.send("claude-code", { ...claudePrompt, prompt: "Retry the task" });
  assert.ok(h.calls.slice(1).every(({ args }) => args.replaceActive === true));
  await h.send("claude-code", {
    ...claudePrompt,
    hook_event_name: "Interrupt",
  });
  assert.equal(h.calls.length, 3);
});

for (const agent of ["pi", "omp"]) {
  test(`${agent} settled outcomes and shutdown use the shared engine without model context output`, async () => {
    const h = harness();
    const payload = {
      cwd: "/workspace",
      session_id: `${agent}-session`,
      prompt: "Fix it",
      messageType: "user",
    };
    await h.send(agent, { ...payload, hook_event_name: "before_agent_start" });
    for (const [extra, expected] of [
      [{}, "complete"],
      [{ aborted: true }, "interrupted"],
      [{ outcome: "aborted" }, "interrupted"],
      [{ outcome: "error" }, "error"],
    ] as const) {
      await h.send(agent, {
        ...payload,
        hook_event_name: "agent_settled",
        ...extra,
      });
      assert.equal(h.calls.at(-1).args.status, expected);
    }
    await h.send(agent, { ...payload, hook_event_name: "session_shutdown" });
    assert.equal(h.calls.at(-1).args.status, "interrupted");
    assert.equal(h.calls.length, 6);
  });
}

test("adapters fail open for engine errors, invalid payloads, subagents, and execution outside Herdr", async () => {
  const h = harness();
  for (const payload of [
    null,
    [],
    {},
    { ...claudePrompt, cwd: "relative" },
    { ...claudePrompt, session_id: "" },
    { ...claudePrompt, prompt: 42 },
    { ...claudePrompt, agent_id: "child" },
  ]) {
    await h.send("claude-code", payload);
  }
  await h.send("unknown", claudePrompt);
  await h.send("pi", {
    ...claudePrompt,
    hook_event_name: "before_agent_start",
    messageType: "custom",
  });
  assert.equal(h.calls.length, 0);
  const outside = harness("");
  await outside.send("claude-code", claudePrompt);
  assert.equal(outside.calls.length, 0);
  h.fail();
  assert.equal(await h.send("claude-code", claudePrompt), undefined);
  assert.equal(await h.send("codex", { ...codexPrompt, hook_event_name: "Stop" }), undefined);
});

async function cliFixture(run: (dir: string, script: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "herdr-turn-hooks-"));
  const script = join(dir, "turn-hooks.mjs");
  try {
    await copyFile(new URL("turn-hooks.mjs", import.meta.url), script);
    await run(dir, script);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function invoke(script: string, input: string, terminal = "t7", agent = "codex") {
  const child = spawn(process.execPath, [script, agent], {
    env: { ...process.env, HC_TERMINAL_ID: terminal },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.on("error", () => {});
  child.stdin.end(input);
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test("CLI reads official stdin JSON, loads only its sibling engine, and stays silent through a symlink", async () => {
  await cliFixture(async (dir, script) => {
    const log = join(dir, "calls.jsonl");
    await writeFile(
      join(dir, "turn-snapshots.mjs"),
      `import {appendFile} from 'node:fs/promises';
      export async function beginTurn(args) { await appendFile(${JSON.stringify(log)}, JSON.stringify(args)+'\\n'); }
      export async function endTurn() { throw new Error('offline'); }`,
    );
    const link = join(dir, "hook-link.mjs");
    await symlink(script, link);
    assert.deepEqual(await invoke(link, JSON.stringify(codexPrompt)), {
      code: 0,
      stdout: "",
      stderr: "",
    });
    assert.equal(JSON.parse((await readFile(log, "utf8")).trim()).request, "turn-1");
    for (const input of [
      "{invalid",
      "null",
      JSON.stringify({ ...codexPrompt, hook_event_name: "Stop" }),
    ]) {
      assert.deepEqual(await invoke(script, input), {
        code: 0,
        stdout: "",
        stderr: "",
      });
    }
    assert.deepEqual(await invoke(script, JSON.stringify(codexPrompt), ""), {
      code: 0,
      stdout: "",
      stderr: "",
    });
    assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 1);
  });
});

test("SessionEnd bounds a stuck engine and exits successfully without stdout or stderr", async () => {
  await cliFixture(async (dir, script) => {
    await writeFile(
      join(dir, "turn-snapshots.mjs"),
      "export async function endTurn() { await new Promise(() => { setInterval(() => {}, 1000); }); }",
    );
    const start = Date.now();
    assert.deepEqual(
      await invoke(script, JSON.stringify({ ...codexPrompt, hook_event_name: "SessionEnd" })),
      { code: 0, stdout: "", stderr: "" },
    );
    assert.ok(Date.now() - start < 4000);
  });
});
