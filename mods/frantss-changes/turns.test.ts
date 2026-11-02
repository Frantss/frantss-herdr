import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadTurns,
  parseTurn,
  turnDiff,
  turnFiles,
  turnLabel,
  validTreeOid,
  validTurnId,
  type Turn,
} from "./turns.ts";

const run = promisify(execFile);
const execute = async (command, args, options) => {
  try {
    const result = await run(command, args, {
      cwd: options.cwd,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, ...result };
  } catch (error) {
    return {
      code: error.code,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message,
    };
  }
};
const metadata = (overrides: Partial<Turn> = {}): Turn => ({
  id: "recorded-turn",
  agent: "pi",
  session: "session-1",
  terminal: "t42",
  title: "Add retry handling",
  startedAt: "2026-07-31T12:00:00.000Z",
  endedAt: "2026-07-31T12:01:00.000Z",
  status: "complete",
  before: "a".repeat(40),
  after: "b".repeat(40),
  ...overrides,
});
async function repository(callback) {
  const root = await mkdtemp(join(tmpdir(), "herdr-turn-ui-"));
  const git = async (...args: string[]) => (await run("git", args, { cwd: root })).stdout.trim();
  try {
    await git("init", "-q");
    await git("config", "user.name", "Turn test");
    await git("config", "user.email", "turn@example.test");
    await callback({ root, gitDir: join(root, ".git"), on: null }, git);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("turn validation accepts engine IDs and SHA-1/SHA-256 trees, not refs or option injection", () => {
  assert.ok(
    parseTurn(
      metadata({
        id: `${"a".repeat(64)}-12345678-1234-1234-1234-123456789abc`,
      }),
    ),
  );
  assert.ok(validTreeOid("F".repeat(64)));
  for (const oid of [
    "HEAD",
    "--cached",
    "a".repeat(39),
    "b".repeat(41),
    "a".repeat(65),
    "a".repeat(40) + ":file",
  ])
    assert.equal(validTreeOid(oid), false);
  for (const id of ["../x", ".hidden", "a/b", "--help", "", "a\0b"])
    assert.equal(validTurnId(id), false);
  for (const patch of [
    { before: "HEAD" },
    { agent: "unknown" },
    { status: "done" },
    { startedAt: "bad" },
    { terminal: {} },
    { session: null },
  ])
    assert.equal(parseTurn({ ...metadata(), ...patch }), null);
  assert.ok(
    parseTurn(
      metadata({
        status: "recording",
        before: undefined,
        after: undefined,
        endedAt: undefined,
      }),
    ),
  );
  assert.equal(turnLabel(metadata()), "t42 · Pi · 07-31 12:00:00Z · Add retry handling");
  assert.equal(
    turnLabel(metadata({ agent: "claude-code", status: "interrupted" })),
    "t42 · Claude Code · 07-31 12:00:00Z · Add retry handling · interrupted",
  );
});

test("metadata reader handles absent/corrupt records, ignores temporary files, and caps all agents at 100", async () => {
  await repository(async (place) => {
    assert.deepEqual(await loadTurns(execute, place), {
      turns: [],
      skipped: 0,
    });
    const dir = join(place.gitDir, "frantss-turns");
    await mkdir(dir);
    await writeFile(join(dir, "broken.json"), "{");
    await writeFile(join(dir, "mismatch.json"), JSON.stringify(metadata()));
    await writeFile(
      join(dir, "bad-oid.json"),
      JSON.stringify(metadata({ id: "bad-oid", before: "HEAD" })),
    );
    await writeFile(join(dir, ".lock"), "locked");
    await writeFile(join(dir, "pending.json.tmp"), "{");
    await symlink(join(dir, "broken.json"), join(dir, "link.json"));
    await writeFile(
      join(dir, "oversized.json"),
      JSON.stringify(metadata({ id: "oversized", title: "x".repeat(65536) })),
    );
    await writeFile(
      join(dir, "large-whitespace.json"),
      JSON.stringify(metadata({ id: "large-whitespace" })) + "\n".repeat(65536),
    );
    await writeFile(
      join(dir, "nul.json"),
      JSON.stringify(metadata({ id: "nul", title: "raw-nul" })).replace("raw-nul", "raw\0nul"),
    );
    const all = Array.from({ length: 105 }, (_, i) =>
      metadata({
        id: `turn-${i}`,
        agent: (["pi", "omp", "claude-code", "codex"] as const)[i % 4],
        startedAt: new Date(Date.UTC(2026, 6, 31, 12, i)).toISOString(),
      }),
    );
    await Promise.all(
      all.map((turn) => writeFile(join(dir, `${turn.id}.json`), JSON.stringify(turn))),
    );
    const result = await loadTurns(execute, place);
    assert.equal(result.skipped, 7);
    assert.deepEqual(result.turns, all.slice(-100));
    await rm(dir, { recursive: true });
    await writeFile(dir, "not a directory");
    await assert.rejects(loadTurns(execute, place), /Cannot read recorded turn directory/);
  });
});

test("shell reader bounds bytes, keeps literal directory arguments, and needs no Node on PATH", async () => {
  await repository(async (place) => {
    const gitDir = join(place.root, "git ' $(not-a-command)");
    const dir = join(gitDir, "frantss-turns"),
      bin = join(place.root, "bin");
    await mkdir(dir, { recursive: true });
    await mkdir(bin);
    await symlink("/usr/bin/head", join(bin, "head"));
    await symlink("/usr/bin/tr", join(bin, "tr"));
    const base = metadata({ id: "exact-limit", title: "" });
    const exact = {
      ...base,
      title: "x".repeat(65536 - JSON.stringify(base).length),
    };
    await writeFile(join(dir, "exact-limit.json"), JSON.stringify(exact));
    const shellOnly = async (command, args, options) => {
      assert.equal(command, "sh");
      const result = await run("/bin/sh", args, {
        cwd: options.cwd,
        env: { PATH: bin },
      });
      return { code: 0, ...result };
    };
    const result = await loadTurns(shellOnly, { ...place, gitDir });
    assert.equal(result.skipped, 0);
    assert.equal(result.turns[0].title, exact.title);
    if (process.getuid?.() !== 0) {
      await chmod(dir, 0);
      try {
        await assert.rejects(
          loadTurns(execute, { ...place, gitDir }),
          /Cannot read recorded turn directory/,
        );
      } finally {
        await chmod(dir, 0o700);
      }
    }
    await assert.rejects(loadTurns(execute, { ...place, gitDir: ".git" }), /must be absolute/);
    await assert.rejects(
      loadTurns(async () => ({ code: 0, stdout: "broken.json\0{", stderr: "" }), place),
      /Invalid recorded turn list/,
    );
  });
});

test("reader uses the followed worktree's absolute git directory, including remote execution options", async () => {
  await repository(async (place, git) => {
    await writeFile(join(place.root, "base"), "base\n");
    await git("add", "-A");
    await git("commit", "-qm", "base");
    const worktree = join(place.root, "linked");
    await git("worktree", "add", "--detach", worktree);
    const gitDir = (
      await run("git", ["rev-parse", "--absolute-git-dir"], { cwd: worktree })
    ).stdout.trim();
    await mkdir(join(gitDir, "frantss-turns"));
    await writeFile(
      join(gitDir, "frantss-turns", "recorded-turn.json"),
      JSON.stringify(metadata()),
    );
    assert.equal((await loadTurns(execute, place)).turns.length, 0);
    const calls: any[] = [];
    const followed = { root: worktree, gitDir, on: "remote" };
    const result = await loadTurns(async (command, args, options) => {
      calls.push({ command, args, options });
      return execute(command, args, options);
    }, followed);
    assert.equal(result.turns[0].id, "recorded-turn");
    assert.equal(calls[0].command, "sh");
    assert.equal(calls[0].args[0], "-c");
    assert.equal(calls[0].args[2], "turns");
    assert.equal(calls[0].args.at(-1), gitDir);
    assert.deepEqual(calls[0].options, { cwd: worktree, on: "remote" });
  });
});

test("historical files and diffs use saved trees for deletions, binaries, captured untracked files and literal paths after later commits", async () => {
  await repository(async (place, git) => {
    const literal = ":(glob)*.ts",
      odd = "tab\tline\n.ts";
    await writeFile(join(place.root, "edited.ts"), "before turn\n");
    await writeFile(join(place.root, "deleted.ts"), "removed\n");
    await writeFile(join(place.root, "binary.bin"), Buffer.from([0, 1, 2]));
    await writeFile(join(place.root, literal), "literal before\n");
    await git("add", "-A");
    const before = await git("write-tree");
    await writeFile(join(place.root, "edited.ts"), "after turn\n");
    await rm(join(place.root, "deleted.ts"));
    await writeFile(join(place.root, "binary.bin"), Buffer.from([0, 3, 4]));
    await writeFile(join(place.root, literal), "literal after\n");
    await writeFile(join(place.root, odd), "captured untracked\n");
    await writeFile(join(place.root, "--cached"), "option-shaped filename\n");
    await git("add", "-A");
    const after = await git("write-tree"),
      turn = metadata({ before, after });
    await git("commit", "-qm", "turn and other work");
    await writeFile(join(place.root, "edited.ts"), "later committed\n");
    await git("add", "-A");
    await git("commit", "-qm", "later");
    await writeFile(join(place.root, "edited.ts"), "live working tree\n");
    const files = await turnFiles(execute, place, turn);
    assert.equal(files.length, 6);
    assert.equal(files.find((file) => file.path === "deleted.ts")?.status, "D");
    assert.equal(files.find((file) => file.path === "binary.bin")?.binary, true);
    assert.equal(files.find((file) => file.path === odd)?.status, "A");
    const preview = async (path) =>
      (
        await turnDiff(
          execute,
          place,
          turn,
          files.find((file) => file.path === path)!,
        )
      ).join("\n");
    const edited = await preview("edited.ts");
    assert.match(edited, /-before turn\n\+after turn/);
    assert.doesNotMatch(edited, /later committed|live working tree/);
    assert.match(await preview("deleted.ts"), /-removed/);
    assert.match(await preview(literal), /-literal before\n\+literal after/);
    assert.doesNotMatch(await preview(literal), /after turn/);
    assert.match(await preview(odd), /\+captured untracked/);
    assert.equal(await preview("binary.bin"), "Binary file changed");
    assert.match(await preview("--cached"), /\+option-shaped filename/);
    assert.deepEqual(await turnFiles(execute, place, { ...turn, before: after }), []);
    await assert.rejects(
      turnFiles(execute, place, { ...turn, before: undefined }),
      /No before\/after snapshot/,
    );
    await assert.rejects(
      turnFiles(execute, place, { ...turn, before: "c".repeat(40) }),
      /bad object|bad revision/,
    );
    await assert.rejects(
      turnDiff(execute, place, turn, { ...files[0], path: "../outside" }),
      /Invalid saved file path/,
    );
  });
});
