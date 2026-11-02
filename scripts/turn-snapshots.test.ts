import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { beginTurn, endTurn, listTurns } from "./turn-snapshots.mjs";

function git(cwd: string, args: string[], input?: string | Buffer) {
  return execFileSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).replace(/\n$/, "");
}

function fixture(t: { onTestFinished(callback: () => void): void }, format?: string) {
  const directory = mkdtempSync(join(tmpdir(), "frantss-turns-test-"));
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const cwd = join(directory, "repo");
  mkdirSync(cwd);
  git(cwd, ["init", "--quiet", ...(format ? [`--object-format=${format}`] : [])]);
  git(cwd, ["config", "user.name", "Turn Tests"]);
  git(cwd, ["config", "user.email", "turns@example.invalid"]);
  const put = (name: string, content: string | Buffer) => {
    mkdirSync(dirname(join(cwd, name)), { recursive: true });
    writeFileSync(join(cwd, name), content);
  };
  const seed = () => {
    put("tracked.txt", "initial\n");
    git(cwd, ["add", "."]);
    git(cwd, ["commit", "--quiet", "-m", "initial"]);
  };
  return { cwd, directory, put, seed };
}

function options(cwd: string, session = "session") {
  return { cwd, agent: "pi", session, title: "Update tracked file", terminal: "t-test" };
}

function gitDirectory(cwd: string) {
  return git(cwd, ["rev-parse", "--absolute-git-dir"]);
}

function treeFile(cwd: string, tree: string, path: string) {
  return execFileSync("git", ["show", `${tree}:${path}`], { cwd });
}

function lockRef(cwd: string) {
  const key = createHash("sha256").update(gitDirectory(cwd)).digest("hex");
  return `refs/frantss/turn-locks/${key}`;
}

function installLock(cwd: string, pid: number) {
  const owner = git(
    cwd,
    ["hash-object", "-w", "--stdin"],
    JSON.stringify({ pid, host: hostname(), token: randomUUID() }),
  );
  git(cwd, ["update-ref", lockRef(cwd), owner]);
  return owner;
}

function refListing(cwd: string) {
  return git(cwd, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags"]);
}

test("snapshots preserve dirty user index bytes, HEAD, branches, and worktree", async (t) => {
  const { cwd, put, seed } = fixture(t);
  seed();
  put("tracked.txt", "staged\n");
  git(cwd, ["add", "."]);
  put("tracked.txt", "worktree before\n");
  put("new.txt", "staged new\n");
  git(cwd, ["add", "new.txt"]);
  put("new.txt", "unstaged new\n");
  const index = readFileSync(join(gitDirectory(cwd), "index"));
  const head = git(cwd, ["rev-parse", "HEAD"]);
  const branches = refListing(cwd);
  const beforeStatus = git(cwd, ["status", "--porcelain=v1"]);
  const start = await beginTurn(options(cwd));
  assert.match(start.before!, /^[a-f0-9]{40}$/);
  assert.equal(treeFile(cwd, start.before!, "tracked.txt").toString(), "worktree before\n");
  assert.equal(treeFile(cwd, start.before!, "new.txt").toString(), "unstaged new\n");
  assert.equal(git(cwd, ["status", "--porcelain=v1"]), beforeStatus);
  put("tracked.txt", "worktree after\n");
  const finish = await endTurn(options(cwd));
  assert.equal(finish!.status, "complete");
  assert.equal(treeFile(cwd, finish!.after!, "tracked.txt").toString(), "worktree after\n");
  assert.deepEqual(readFileSync(join(gitDirectory(cwd), "index")), index);
  assert.equal(git(cwd, ["rev-parse", "HEAD"]), head);
  assert.equal(refListing(cwd), branches);
  assert.equal(readFileSync(join(cwd, "tracked.txt"), "utf8"), "worktree after\n");
  assert.equal(git(cwd, ["cat-file", "-t", `refs/frantss/turns/${start.id}/before`]), "tree");
  assert.equal(git(cwd, ["rev-parse", `refs/frantss/turns/${start.id}/after`]), finish!.after);
  assert.equal(finish!.terminal, "t-test");
  assert.ok(finish!.endedAt);
});

test("consecutive turns of the same file use independent baselines and idempotent endpoints", async (t) => {
  const { cwd, put, seed } = fixture(t);
  seed();
  const first = await beginTurn(options(cwd));
  put("tracked.txt", "first change\n");
  assert.deepEqual(await beginTurn(options(cwd)), first);
  const ended = await endTurn(options(cwd));
  put("tracked.txt", "later change\n");
  assert.deepEqual(await endTurn(options(cwd)), ended);
  const second = await beginTurn(options(cwd));
  assert.notEqual(second.id, first.id);
  assert.equal(treeFile(cwd, second.before!, "tracked.txt").toString(), "later change\n");
  put("tracked.txt", "second change\n");
  const secondEnd = await endTurn(options(cwd));
  assert.equal(treeFile(cwd, ended!.after!, "tracked.txt").toString(), "first change\n");
  assert.equal(treeFile(cwd, secondEnd!.after!, "tracked.txt").toString(), "second change\n");
  assert.equal((await listTurns(cwd)).length, 2);
});

test("captures ignored tracked/staged files, untracked files, deletions, binary, modes, and unusual paths", async (t) => {
  const { cwd, put, seed } = fixture(t);
  seed();
  put(".gitignore", "*.ignored\n");
  put("tracked.ignored", "old ignored tracked\n");
  put("executable", "#!/bin/sh\nexit 0\n");
  put("deleted.txt", "delete this\n");
  git(cwd, ["add", ".gitignore", "executable", "deleted.txt"]);
  git(cwd, ["add", "--force", "tracked.ignored"]);
  git(cwd, ["commit", "--quiet", "-m", "capture cases"]);
  put("tracked.ignored", "changed ignored tracked\n");
  put("new.ignored", "staged ignored\n");
  git(cwd, ["add", "--force", "new.ignored"]);
  put("new.ignored", "unstaged ignored\n");
  put("omitted.ignored", "must not capture\n");
  const unusual = "nested/space tab\tnewline\n-λ.txt";
  put(unusual, "unusual\n");
  const binary = Buffer.from([0, 255, 128, 13, 10, 1]);
  put("binary", binary);
  chmodSync(join(cwd, "executable"), 0o755);
  symlinkSync("tracked.txt", join(cwd, "symlink"));
  unlinkSync(join(cwd, "deleted.txt"));
  const originalIndex = readFileSync(join(gitDirectory(cwd), "index"));
  const record = await beginTurn(options(cwd));
  const tree = record.before!;
  assert.equal(treeFile(cwd, tree, "tracked.ignored").toString(), "changed ignored tracked\n");
  assert.equal(treeFile(cwd, tree, "new.ignored").toString(), "unstaged ignored\n");
  assert.equal(treeFile(cwd, tree, unusual).toString(), "unusual\n");
  assert.deepEqual(treeFile(cwd, tree, "binary"), binary);
  assert.equal(treeFile(cwd, tree, "symlink").toString(), "tracked.txt");
  assert.equal(git(cwd, ["ls-tree", tree, "executable"]).slice(0, 6), "100755");
  assert.equal(git(cwd, ["ls-tree", tree, "symlink"]).slice(0, 6), "120000");
  assert.equal(git(cwd, ["ls-tree", tree, "deleted.txt", "omitted.ignored"]), "");
  assert.deepEqual(readFileSync(join(gitDirectory(cwd), "index")), originalIndex);
});

test("private index clears assume-unchanged and skip-worktree without touching user flags", async (t) => {
  const { cwd, put, seed } = fixture(t);
  seed();
  put("skipped", "initial\n");
  git(cwd, ["add", "skipped"]);
  git(cwd, ["update-index", "--assume-unchanged", "tracked.txt"]);
  git(cwd, ["update-index", "--skip-worktree", "skipped"]);
  put("tracked.txt", "changed assumed\n");
  put("skipped", "changed skipped\n");
  const index = readFileSync(join(gitDirectory(cwd), "index"));
  const record = await beginTurn(options(cwd));
  assert.equal(treeFile(cwd, record.before!, "tracked.txt").toString(), "changed assumed\n");
  assert.equal(treeFile(cwd, record.before!, "skipped").toString(), "changed skipped\n");
  assert.deepEqual(readFileSync(join(gitDirectory(cwd), "index")), index);
});

test("split user indexes retain their bytes and shared index while the snapshot uses a private full index", async (t) => {
  const { cwd, put, seed } = fixture(t);
  seed();
  git(cwd, ["config", "core.splitIndex", "true"]);
  git(cwd, ["update-index", "--split-index"]);
  const directory = gitDirectory(cwd);
  const originalFiles = readdirSync(directory).filter(
    (name) => name === "index" || name.startsWith("sharedindex."),
  );
  const originalBytes = originalFiles.map((name) => readFileSync(join(directory, name)));
  put("tracked.txt", "changed split-index worktree\n");
  const record = await beginTurn(options(cwd));
  assert.equal(
    treeFile(cwd, record.before!, "tracked.txt").toString(),
    "changed split-index worktree\n",
  );
  await endTurn(options(cwd));
  assert.deepEqual(
    readdirSync(directory).filter((name) => name === "index" || name.startsWith("sharedindex.")),
    originalFiles,
  );
  for (let position = 0; position < originalFiles.length; position++)
    assert.deepEqual(
      readFileSync(join(directory, originalFiles[position])),
      originalBytes[position],
    );
});

test("unborn and SHA-256 repositories need no commits or existing user index", async (t) => {
  for (const format of ["sha1", "sha256"]) {
    const { cwd, put } = fixture(t, format);
    put("new.txt", "before\n");
    const head = readFileSync(join(gitDirectory(cwd), "HEAD"));
    const index = join(gitDirectory(cwd), "index");
    assert.equal(existsSync(index), false);
    const start = await beginTurn(options(cwd));
    assert.equal(start.before!.length, format === "sha256" ? 64 : 40);
    put("new.txt", "after\n");
    const end = await endTurn(options(cwd));
    assert.equal(treeFile(cwd, end!.after!, "new.txt").toString(), "after\n");
    assert.equal(existsSync(index), false);
    assert.deepEqual(readFileSync(join(gitDirectory(cwd), "HEAD")), head);
    assert.equal(refListing(cwd), "");
  }
});

test("linked worktrees isolate records, indexes, and retained private refs", async (t) => {
  const { cwd, directory, put, seed } = fixture(t);
  seed();
  const linked = join(directory, "linked");
  git(cwd, ["worktree", "add", "--quiet", "-b", "linked", linked]);
  const mainIndex = readFileSync(join(gitDirectory(cwd), "index"));
  const linkedIndex = readFileSync(join(gitDirectory(linked), "index"));
  put("tracked.txt", "main worktree\n");
  writeFileSync(join(linked, "tracked.txt"), "linked worktree\n");
  const [main, other] = await Promise.all([beginTurn(options(cwd)), beginTurn(options(linked))]);
  assert.notEqual(main.id, other.id);
  assert.equal(treeFile(cwd, main.before!, "tracked.txt").toString(), "main worktree\n");
  assert.equal(treeFile(linked, other.before!, "tracked.txt").toString(), "linked worktree\n");
  assert.deepEqual(
    (await listTurns(cwd)).map((record) => record.id),
    [main.id],
  );
  assert.deepEqual(
    (await listTurns(linked)).map((record) => record.id),
    [other.id],
  );
  await Promise.all([endTurn(options(cwd)), endTurn(options(linked))]);
  assert.deepEqual(readFileSync(join(gitDirectory(cwd), "index")), mainIndex);
  assert.deepEqual(readFileSync(join(gitDirectory(linked), "index")), linkedIndex);
});

test("same-session concurrent calls serialize and a live writer cannot be stolen", async (t) => {
  const { cwd, seed } = fixture(t);
  seed();
  const owner = installLock(cwd, process.pid);
  const metadata = join(gitDirectory(cwd), "frantss-turns");
  mkdirSync(metadata, { recursive: true });
  const liveCapture = mkdtempSync(join(metadata, ".capture-"));
  writeFileSync(join(liveCapture, "index"), "live writer index");
  let settled = false;
  const waiting = beginTurn(options(cwd)).then((record) => {
    settled = true;
    return record;
  });
  await setTimeout(100);
  assert.equal(settled, false);
  assert.equal(git(cwd, ["rev-parse", lockRef(cwd)]), owner);
  assert.equal(readFileSync(join(liveCapture, "index"), "utf8"), "live writer index");
  git(cwd, ["update-ref", "-d", lockRef(cwd), owner]);
  const first = await waiting;
  assert.equal(existsSync(liveCapture), false);
  const results = await Promise.all(Array.from({ length: 4 }, () => beginTurn(options(cwd))));
  assert.ok(results.every((record) => record.id === first.id));
  const ended = await Promise.all(Array.from({ length: 4 }, () => endTurn(options(cwd))));
  assert.ok(ended.every((record) => record!.after === ended[0]!.after));
  assert.equal((await listTurns(cwd)).length, 1);
});

test("dead-writer recovery removes its orphan capture/temp files but preserves unrelated files and metadata", async (t) => {
  const { cwd, seed } = fixture(t);
  seed();
  const directory = join(gitDirectory(cwd), "frantss-turns");
  mkdirSync(directory, { recursive: true });
  const key = createHash("sha256")
    .update(JSON.stringify(["pi", "session"]))
    .digest("hex");
  const id = `${key}-${randomUUID()}`;
  const interrupted = {
    id,
    agent: "pi",
    session: "session",
    title: "Interrupted begin",
    startedAt: "2000-01-01T00:00:00.000Z",
    status: "recording",
  };
  writeFileSync(join(directory, `${id}.json`), JSON.stringify(interrupted));
  const atomicTemporary = join(directory, `${id}.${randomUUID()}.tmp`);
  const child = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    `import { mkdtempSync, writeFileSync } from 'node:fs';
     import { join } from 'node:path';
     const capture = mkdtempSync(join(process.argv[1], '.capture-'));
     writeFileSync(join(capture, 'index'), 'orphan private index');
     writeFileSync(join(capture, 'index.lock'), 'orphan private index lock');
     writeFileSync(process.argv[2], 'unfinished atomic metadata');
     console.log(capture);
     setInterval(() => {}, 1000);`,
    directory,
    atomicTemporary,
  ]);
  const orphanCapture = await new Promise<string>((resolve) =>
    child.stdout.once("data", (chunk) => resolve(chunk.toString().trim())),
  );
  installLock(cwd, child.pid!);
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited;
  assert.equal(existsSync(orphanCapture), true);
  assert.equal(existsSync(atomicTemporary), true);
  const otherWriterFile = join(directory, ".capture-other-writer");
  mkdirSync(otherWriterFile);
  writeFileSync(join(otherWriterFile, "index"), "not ours");
  const record = await beginTurn(options(cwd));
  assert.notEqual(record.id, id);
  const recovered = (await listTurns(cwd)).find((candidate) => candidate.id === id)!;
  assert.equal(recovered.status, "interrupted");
  assert.ok(recovered.endedAt);
  assert.equal(readFileSync(join(otherWriterFile, "index"), "utf8"), "not ours");
  assert.equal(existsSync(orphanCapture), false);
  assert.equal(existsSync(atomicTemporary), false);
  assert.equal(git(cwd, ["for-each-ref", "--format=%(refname)", "refs/frantss/turn-locks"]), "");
});

test("capture failures persist error records, release locks, and leave user index untouched", async (t) => {
  const { cwd, seed } = fixture(t);
  seed();
  const indexPath = join(gitDirectory(cwd), "index");
  const index = readFileSync(indexPath);
  const corrupt = Buffer.from("corrupt user index");
  writeFileSync(indexPath, corrupt);
  await assert.rejects(beginTurn(options(cwd)));
  assert.deepEqual(readFileSync(indexPath), corrupt);
  let records = await listTurns(cwd);
  assert.equal(records[0].status, "error");
  assert.ok(records[0].error);
  assert.ok(records[0].endedAt);
  writeFileSync(indexPath, index);
  const start = await beginTurn(options(cwd));
  writeFileSync(indexPath, corrupt);
  await assert.rejects(endTurn(options(cwd)));
  assert.deepEqual(readFileSync(indexPath), corrupt);
  records = await listTurns(cwd);
  const failed = records.find((record) => record.id === start.id)!;
  assert.equal(failed.status, "error");
  assert.equal(failed.before, start.before);
  assert.equal(failed.after, undefined);
  assert.equal(git(cwd, ["for-each-ref", "--format=%(refname)", "refs/frantss/turn-locks"]), "");
  assert.ok(
    readdirSync(join(gitDirectory(cwd), "frantss-turns")).every((name) => name.endsWith(".json")),
  );
});

test("retention keeps 100 finished records and active records, deleting only their corresponding refs", async (t) => {
  const { cwd, directory, seed } = fixture(t);
  seed();
  const linked = join(directory, "linked");
  git(cwd, ["worktree", "add", "--quiet", "-b", "retention-linked", linked]);
  const other = await beginTurn(options(linked));
  const start = await beginTurn(options(cwd));
  const metadata = join(gitDirectory(cwd), "frantss-turns");
  const commands: string[] = [];
  const seeded: string[] = [];
  for (let position = 0; position < 102; position++) {
    const id = `${start.id.slice(0, 64)}-${randomUUID()}`;
    seeded.push(id);
    const record = {
      ...start,
      id,
      startedAt: new Date(Date.UTC(2000, 0, 1, 0, 0, position)).toISOString(),
      endedAt: "2000-01-02T00:00:00.000Z",
      status: position === 1 ? "error" : position === 2 ? "interrupted" : "complete",
      after: start.before,
    };
    writeFileSync(join(metadata, `${id}.json`), JSON.stringify(record));
    commands.push(
      `update refs/frantss/turns/${id}/before ${start.before}`,
      `update refs/frantss/turns/${id}/after ${start.before}`,
    );
  }
  git(cwd, ["update-ref", "--stdin"], `${commands.join("\n")}\n`);
  git(cwd, ["update-ref", "refs/frantss/unrelated", start.before!]);
  await endTurn(options(cwd));
  const records = await listTurns(cwd);
  assert.equal(records.length, 100);
  for (const id of seeded.slice(0, 3)) {
    assert.equal(existsSync(join(metadata, `${id}.json`)), false);
    assert.equal(git(cwd, ["for-each-ref", "--format=%(refname)", `refs/frantss/turns/${id}`]), "");
  }
  assert.equal(git(cwd, ["rev-parse", "refs/frantss/unrelated"]), start.before);
  assert.equal(git(cwd, ["rev-parse", `refs/frantss/turns/${other.id}/before`]), other.before);
  assert.equal((await listTurns(linked))[0].status, "recording");
  const active = await beginTurn(options(cwd, "another-session"));
  assert.equal((await listTurns(cwd)).length, 101);
  assert.equal(
    (await listTurns(cwd)).find((record) => record.id === active.id)!.status,
    "recording",
  );
});

test("continued Stop updates the same completed turn, but not interrupted turns or a new prompt baseline", async (t) => {
  const { cwd, put, seed } = fixture(t);
  seed();
  const start = await beginTurn(options(cwd));
  put("tracked.txt", "first Stop\n");
  const stopped = await endTurn(options(cwd));
  put("tracked.txt", "continued Stop\n");
  assert.deepEqual(await endTurn(options(cwd)), stopped);
  const continued = await endTurn({ ...options(cwd), continued: true });
  assert.equal(continued!.id, start.id);
  assert.equal(continued!.before, start.before);
  assert.notEqual(continued!.after, stopped!.after);
  assert.equal(treeFile(cwd, continued!.after!, "tracked.txt").toString(), "continued Stop\n");
  assert.equal((await listTurns(cwd)).length, 1);
  const next = await beginTurn(options(cwd));
  put("tracked.txt", "second prompt\n");
  const nextEnd = await endTurn({ ...options(cwd), continued: true, status: "interrupted" });
  assert.equal(nextEnd!.id, next.id);
  assert.equal(nextEnd!.before, continued!.after);
  put("tracked.txt", "not captured\n");
  assert.deepEqual(await endTurn({ ...options(cwd), continued: true }), nextEnd);
  assert.equal((await listTurns(cwd)).length, 2);
});

test("a genuine new request replaces abandoned active turn as interrupted with a shared boundary tree", async (t) => {
  const { cwd, put, seed } = fixture(t);
  seed();
  const first = await beginTurn(options(cwd));
  put("tracked.txt", "abandoned first request\n");
  const next = await beginTurn({ ...options(cwd), title: "Next request", replaceActive: true });
  const previous = (await listTurns(cwd)).find((record) => record.id === first.id)!;
  assert.equal(previous.status, "interrupted");
  assert.equal(previous.after, next.before);
  assert.notEqual(first.id, next.id);
  assert.equal(next.title, "Next request");
  assert.equal(treeFile(cwd, next.before!, "tracked.txt").toString(), "abandoned first request\n");
});

test("request IDs deduplicate active and ended deliveries without replacing a different active request", async (t) => {
  const { cwd, put, seed } = fixture(t);
  seed();
  const firstOptions = { ...options(cwd), request: "prompt-1", replaceActive: true };
  const first = await beginTurn(firstOptions);
  put("tracked.txt", "first prompt\n");
  assert.deepEqual(await beginTurn(firstOptions), first);
  const ended = await endTurn(options(cwd));
  assert.deepEqual(await beginTurn(firstOptions), ended);
  const next = await beginTurn({ ...firstOptions, request: "prompt-2" });
  assert.notEqual(next.id, first.id);
  assert.deepEqual(await beginTurn(firstOptions), ended);
  const third = await beginTurn({ ...firstOptions, request: "prompt-3" });
  assert.notEqual(third.id, next.id);
  assert.equal(
    (await listTurns(cwd)).find((record) => record.id === next.id)!.status,
    "interrupted",
  );
});

test("titles keep only the normalized first nonempty line and are bounded by Unicode codepoints", async (t) => {
  const { cwd, seed } = fixture(t);
  seed();
  const record = await beginTurn({
    ...options(cwd),
    title: `\n  \t\n  Fix\t\u0000  ${"🙂".repeat(200)}\nprivate prompt details ${"long".repeat(30_000)}`,
  });
  assert.equal(Array.from(record.title).length, 160);
  assert.ok(record.title.startsWith("Fix "));
  assert.ok(!record.title.includes("private prompt details"));
  assert.ok(!record.title.includes("\u0000"));
  assert.ok(
    readFileSync(join(gitDirectory(cwd), "frantss-turns", `${record.id}.json`)).length < 64 * 1024,
  );
});

test("continued Stop cannot recapture a turn from another terminal", async (t) => {
  const { cwd, put, seed } = fixture(t);
  seed();
  await beginTurn(options(cwd));
  const ended = await endTurn(options(cwd));
  put("tracked.txt", "not captured by other terminal\n");
  assert.equal(
    await endTurn({ ...options(cwd), terminal: "another-terminal", continued: true }),
    undefined,
  );
  assert.deepEqual((await listTurns(cwd))[0], ended);
});

test("snapshots do not execute commit, reference-transaction, or fsmonitor hooks", async (t) => {
  const { cwd, directory, seed } = fixture(t);
  seed();
  const hooks = join(directory, "hooks");
  mkdirSync(hooks);
  const marker = join(directory, "hook-ran");
  for (const name of ["pre-commit", "post-commit", "reference-transaction", "fsmonitor"])
    writeFileSync(join(hooks, name), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
  git(cwd, ["config", "core.hooksPath", hooks]);
  git(cwd, ["config", "core.fsmonitor", join(hooks, "fsmonitor")]);
  await beginTurn(options(cwd));
  await endTurn(options(cwd));
  assert.equal(existsSync(marker), false);
});

test("invalid inputs and non-Git directories throw, missing end is harmless, and malformed records are ignored", async (t) => {
  const { cwd, directory, seed } = fixture(t);
  seed();
  await assert.rejects(beginTurn({ ...options(cwd), agent: "unknown" }));
  await assert.rejects(beginTurn({ ...options(cwd), session: "" }));
  await assert.rejects(beginTurn({ ...options(cwd), title: undefined }));
  await assert.rejects(beginTurn({ ...options(cwd), session: "a".repeat(4097) }));
  await assert.rejects(beginTurn({ ...options(cwd), request: "a".repeat(4097) }));
  await assert.rejects(beginTurn({ ...options(cwd), replaceActive: "yes" }));
  await assert.rejects(endTurn({ ...options(cwd), continued: "yes" }));
  await assert.rejects(endTurn({ ...options(cwd), status: "recording" }));
  await assert.rejects(listTurns(directory));
  assert.equal(await endTurn(options(cwd)), undefined);
  assert.deepEqual(await listTurns(cwd), []);
  const start = await beginTurn(options(cwd));
  const metadata = join(gitDirectory(cwd), "frantss-turns");
  writeFileSync(join(metadata, "broken.json"), "not json");
  for (const contents of ["{broken", "null", "42", "[]", "{}"])
    writeFileSync(join(metadata, `${start.id.slice(0, 64)}-${randomUUID()}.json`), contents);
  assert.equal((await listTurns(cwd)).length, 1);
});
