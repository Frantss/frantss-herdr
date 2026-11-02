import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadTurns, turnDiff, turnFiles } from "../mods/frantss-changes/turns.ts";

const run = promisify(execFile);
const hookPath = fileURLToPath(new URL("turn-hooks.mjs", import.meta.url));

for (const agent of ["pi", "omp", "claude-code", "codex"]) {
  test(`${agent} hook snapshots can be reviewed after later edits and a commit`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "herdr-turn-integration-"));
    const git = async (...args: string[]) => (await run("git", args, { cwd })).stdout.trim();
    const hook = async (event: string, prompt?: string) => {
      const execution = run(process.execPath, [hookPath, agent], {
        cwd,
        env: { ...process.env, HC_TERMINAL_ID: "turn-integration" },
        timeout: 20_000,
      });
      execution.child.stdin.end(
        JSON.stringify({
          hook_event_name: event,
          cwd,
          session_id: `${agent}-session`,
          prompt_id: "request-one",
          turn_id: "request-one",
          messageType: "user",
          prompt,
          stop_hook_active: false,
          aborted: false,
        }),
      );
      const result = await execution;
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    };
    try {
      await git("init", "-q");
      await git("config", "user.name", "Turn integration test");
      await git("config", "user.email", "turn-test@example.invalid");
      await writeFile(join(cwd, "request.txt"), "committed baseline\n");
      await git("add", ".");
      await git("commit", "-qm", "baseline");
      await writeFile(join(cwd, "request.txt"), "existing staged edit\n");
      await git("add", ".");
      await writeFile(join(cwd, "request.txt"), "existing working edit\n");
      const beforeIndex = await readFile(join(cwd, ".git/index"));
      const beforeHead = await git("rev-parse", "HEAD");
      await hook(
        agent === "pi" || agent === "omp" ? "before_agent_start" : "UserPromptSubmit",
        "Change request behavior",
      );
      await writeFile(join(cwd, "request.txt"), "this turn only\n");
      await writeFile(join(cwd, "new.txt"), "added during this turn\n");
      await hook(agent === "pi" || agent === "omp" ? "agent_settled" : "Stop");
      assert.deepEqual(await readFile(join(cwd, ".git/index")), beforeIndex);
      assert.equal(await git("rev-parse", "HEAD"), beforeHead);

      const execute = async (
        command: string,
        args: string[],
        options: { cwd: string; on: string | null },
      ) => {
        try {
          const result = await run(command, args, {
            cwd: options.cwd,
            timeout: 20_000,
          });
          return { code: 0, stdout: result.stdout, stderr: result.stderr };
        } catch (error) {
          return {
            code: 1,
            stdout: error.stdout ?? "",
            stderr: error.stderr ?? String(error),
          };
        }
      };
      const place = {
        root: cwd,
        gitDir: await git("rev-parse", "--absolute-git-dir"),
        on: null,
      };
      const { turns, skipped } = await loadTurns(execute, place);
      assert.equal(skipped, 0);
      assert.equal(turns.length, 1);
      const turn = turns[0];
      assert.equal(turn.agent, agent);
      assert.equal(turn.status, "complete");
      const files = await turnFiles(execute, place, turn);
      assert.deepEqual(files.map((file) => file.path).sort(), ["new.txt", "request.txt"]);
      const request = files.find((file) => file.path === "request.txt");
      assert.ok(request);
      const saved = await turnDiff(execute, place, turn, request);
      assert.ok(saved.includes("-existing working edit"));
      assert.ok(saved.includes("+this turn only"));
      assert.ok(!saved.includes("-committed baseline"));

      await writeFile(join(cwd, "request.txt"), "later turn edit\n");
      await git("add", ".");
      await git("commit", "-qm", "later changes");
      assert.deepEqual(await turnDiff(execute, place, turn, request), saved);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
