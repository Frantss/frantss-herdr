import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import type { exec as Exec } from "herdr";
import {
  inspectWorktree,
  removeWorktree,
  planWorktreeRemoval,
  removeWorktrees,
  type RemovalTarget,
} from "./worktree-removal.ts";

const record = (path: string) => `worktree ${path}\0HEAD abc\0branch refs/heads/topic\0\0`;
const target: RemovalTarget = {
  key: JSON.stringify([null, "/repo with spaces/.git"]),
  path: "/linked with spaces",
};
const list = record("/main") + record(target.path);
type Result = { code: number; stdout: string; stderr: string };
const ok = (stdout = ""): Result => ({ code: 0, stdout, stderr: "" });
const failed = (stderr: string, code = 128): Result => ({ code, stdout: "", stderr });

function harness(results: (Result | Error)[]) {
  const calls: {
    command: string;
    args: string[];
    options: { cwd?: string; on?: string | null };
  }[] = [];
  const exec: typeof Exec = async (command, args, options) => {
    calls.push({ command, args, options });
    const result = results.shift();
    assert.ok(result, "Unexpected exec call");
    if (result instanceof Error) throw result;
    return result;
  };
  return { exec, calls, results };
}

const listCall = (on: string | null = null) => ({
  command: "git",
  args: ["--git-dir", "/repo with spaces/.git", "worktree", "list", "--porcelain", "-z"],
  options: { on },
});
const rootCall = (on: string | null = null) => ({
  command: "git",
  args: ["rev-parse", "--show-toplevel"],
  options: { cwd: target.path, on },
});
const statusCall = (on: string | null = null) => ({
  command: "git",
  args: ["status", "--porcelain", "-z", "--untracked-files=normal"],
  options: { cwd: target.path, on },
});
const removeCall = (on: string | null = null) => ({
  command: "git",
  args: ["--git-dir", "/repo with spaces/.git", "worktree", "remove", target.path],
  options: { on },
});

for (const operation of [inspectWorktree, removeWorktree]) {
  test(`${operation.name} rejects main and missing checkouts before querying their folders`, async () => {
    for (const [output, message] of [
      [record(target.path), /main checkout/],
      [record("/main"), /no longer registered/],
      ["", /no longer registered/],
      [record("/main") + `worktree ${target.path}\0HEAD abc\0prunable\0\0`, /no longer registered/],
    ] as const) {
      const h = harness([ok(output)]);
      await assert.rejects(operation(target, h.exec), message);
      assert.deepEqual(h.calls, [listCall()]);
    }
  });

  test(`${operation.name} stops on failed list and includes Git errors`, async () => {
    for (const result of [failed("fatal: repository unavailable"), new Error("Remote offline")]) {
      const h = harness([result]);
      await assert.rejects(operation(target, h.exec), /repository unavailable|Remote offline/);
      assert.deepEqual(h.calls, [listCall()]);
    }
  });

  test(`${operation.name} rejects replaced paths, nested roots and failed root checks`, async () => {
    for (const [result, message] of [
      [ok("/parent\n"), /root no longer matches/],
      [ok(`${target.path}/nested\n`), /root no longer matches/],
      [failed("fatal: not a git repository"), /Verify worktree root failed.*not a git repository/],
      [new Error("Folder missing"), /Folder missing/],
    ] as const) {
      const h = harness([ok(list), result]);
      await assert.rejects(operation(target, h.exec), message);
      assert.deepEqual(h.calls, [listCall(), rootCall()]);
    }
  });

  test(`${operation.name} rejects invalid repository keys without executing`, async () => {
    for (const key of [
      "invalid",
      "null",
      "{}",
      "[]",
      '[null,"/git",1]',
      '[1,"/git"]',
      '["","/git"]',
      '[null,""]',
    ]) {
      const h = harness([]);
      await assert.rejects(
        operation({ ...target, key }, h.exec),
        /Invalid worktree repository key/,
      );
      assert.deepEqual(h.calls, []);
    }
    const h = harness([]);
    await assert.rejects(operation({ ...target, path: "" }, h.exec), /Invalid worktree/);
    assert.deepEqual(h.calls, []);
  });
}

test("inspection checks tracked and untracked changes with normal Git status only", async () => {
  for (const status of ["", " M tracked\0", "?? new file\0", "R  new name\0old name\0"]) {
    const h = harness([ok(list), ok(`${target.path}\n`), ok(status)]);
    assert.deepEqual(await inspectWorktree(target, h.exec), { dirty: status !== "" });
    assert.deepEqual(h.calls, [listCall(), rootCall(), statusCall()]);
    assert.deepEqual(h.results, []);
  }
});

test("inspection fails closed when status fails instead of reporting a clean worktree", async () => {
  const h = harness([ok(list), ok(`${target.path}\n`), failed("fatal: index unreadable", 1)]);
  await assert.rejects(
    inspectWorktree(target, h.exec),
    /Read worktree status failed.*index unreadable/,
  );
  assert.deepEqual(h.calls, [listCall(), rootCall(), statusCall()]);
});

test("removal revalidates after inspection and never forces or deletes a branch", async () => {
  const h = harness([
    ok(list),
    ok(`${target.path}\n`),
    ok(" M tracked\0"),
    ok(list),
    ok(`${target.path}\n`),
    ok(),
  ]);
  assert.deepEqual(await inspectWorktree(target, h.exec), { dirty: true });
  assert.equal(await removeWorktree(target, h.exec), undefined);
  assert.deepEqual(h.calls, [
    listCall(),
    rootCall(),
    statusCall(),
    listCall(),
    rootCall(),
    removeCall(),
  ]);
  assert.deepEqual(h.results, []);
});

test("a checkout removed or promoted to main after inspection cannot be removed", async () => {
  for (const next of [record("/main"), record(target.path)]) {
    const h = harness([ok(list), ok(`${target.path}\n`), ok(), ok(next)]);
    await inspectWorktree(target, h.exec);
    await assert.rejects(removeWorktree(target, h.exec), /no longer registered|main checkout/);
    assert.deepEqual(h.calls, [listCall(), rootCall(), statusCall(), listCall()]);
  }
});

test("Git removal failures, including dirty and locked worktrees, are surfaced without a forced retry", async () => {
  for (const detail of ["contains modified or untracked files", "is locked", "permission denied"]) {
    const h = harness([ok(list), ok(`${target.path}\n`), failed(detail, 128)]);
    await assert.rejects(removeWorktree(target, h.exec), (error: Error) => {
      assert.match(error.message, /Remove worktree failed \(exit 128\)/);
      assert.ok(error.message.includes(detail));
      return true;
    });
    assert.deepEqual(h.calls, [listCall(), rootCall(), removeCall()]);
  }
});

test("errors without stderr include stdout or at least the exit code", async () => {
  for (const [result, message] of [
    [{ code: 2, stdout: "fallback detail", stderr: "" }, /exit 2.*fallback detail/],
    [{ code: 3, stdout: "", stderr: "" }, /exit 3/],
  ] as const) {
    const h = harness([result]);
    await assert.rejects(removeWorktree(target, h.exec), message);
  }
});

test("every query and removal uses the explicit remote machine and preserves paths as argv", async () => {
  const remote = { ...target, key: JSON.stringify(["build machine", "/repo with spaces/.git"]) };
  const h = harness([
    ok(list),
    ok(`${target.path}\n`),
    ok(),
    ok(list),
    ok(`${target.path}\n`),
    ok(),
  ]);
  await inspectWorktree(remote, h.exec);
  await removeWorktree(remote, h.exec);
  assert.deepEqual(h.calls, [
    listCall("build machine"),
    rootCall("build machine"),
    statusCall("build machine"),
    listCall("build machine"),
    rootCall("build machine"),
    removeCall("build machine"),
  ]);
});

test("linked checkouts of a bare repository remain removable", async () => {
  const h = harness([
    ok(`worktree /bare\0bare\0\0${record(target.path)}`),
    ok(`${target.path}\n`),
    ok(),
  ]);
  await removeWorktree(target, h.exec);
  assert.deepEqual(h.calls, [listCall(), rootCall(), removeCall()]);
});

test("bulk planning skips main, open, dirty, locked and submodule checkouts using a fresh inventory", async () => {
  const paths = ["/main", "/a-clean", "/b-dirty", "/c-locked", "/d-submodules", "/e-open"];
  const output = paths
    .map(record)
    .join("")
    .replace("worktree /c-locked\0HEAD", "worktree /c-locked\0locked keep this\0HEAD");
  const h = harness([
    ok(output),
    ok(output),
    ok("/a-clean\n"),
    ok(),
    ok(),
    ok(output),
    ok("/b-dirty\n"),
    ok("?? local\0"),
    ok(output),
    ok(output),
    ok("/d-submodules\n"),
    ok(),
    ok("160000 abc 0\tchild\0"),
  ]);
  const plan = await planWorktreeRemoval(target.key, h.exec, (item) =>
    item.path === "/e-open" ? "Open in Herdr" : null,
  );
  assert.deepEqual(plan.targets, [{ key: target.key, path: "/a-clean" }]);
  assert.equal(plan.skipped.length, 5);
  for (const reason of [/Main checkout/, /local changes/, /locked/, /submodules/, /Open in Herdr/])
    assert.ok(plan.skipped.some((item) => reason.test(item.reason)));
  assert.equal(h.results.length, 0);
  assert.equal(
    h.calls.some((call) => call.args.includes("remove")),
    false,
  );
});

test("bulk removal rechecks candidates, continues after refusal, and retains preflight skips", async () => {
  const second = { ...target, path: "/second" };
  const output = list + record(second.path);
  const h = harness([
    ok(output),
    ok(`${target.path}\n`),
    ok("?? became-dirty\0"),
    ok(output),
    ok(`${second.path}\n`),
    ok(),
    ok(),
    ok(output),
    ok(`${second.path}\n`),
    ok(),
  ]);
  const result = await removeWorktrees(
    { targets: [target, second], skipped: [{ path: "/protected", reason: "Open" }] },
    h.exec,
    () => null,
  );
  assert.deepEqual(result.removed, [second.path]);
  assert.deepEqual(result.skipped[0], { path: "/protected", reason: "Open" });
  assert.match(result.skipped[1].reason, /local changes/);
  assert.equal(h.results.length, 0);
  assert.equal(h.calls.filter((call) => call.args.includes("remove")).length, 1);
  assert.equal(
    h.calls.some((call) => call.args.includes("--force")),
    false,
  );
});

test("bulk removal skips candidates opened before or during inspection", async () => {
  for (const opensDuringInspection of [false, true]) {
    const h = harness(opensDuringInspection ? [ok(list), ok(`${target.path}\n`), ok(), ok()] : []);
    let checks = 0;
    const result = await removeWorktrees({ targets: [target], skipped: [] }, h.exec, () => {
      checks++;
      return !opensDuringInspection || checks > 1 ? "Open in Herdr" : null;
    });
    assert.deepEqual(result.removed, []);
    assert.equal(result.skipped[0].reason, "Error: Open in Herdr");
    assert.equal(
      h.calls.some((call) => call.args.includes("remove")),
      false,
    );
  }
});

test("bulk removal checks open spaces again after final Git validation", async () => {
  const h = harness([
    ok(list),
    ok(`${target.path}\n`),
    ok(),
    ok(),
    ok(list),
    ok(`${target.path}\n`),
  ]);
  let checks = 0;
  const result = await removeWorktrees({ targets: [target], skipped: [] }, h.exec, () =>
    ++checks === 3 ? "Opened during validation" : null,
  );
  assert.deepEqual(result.removed, []);
  assert.match(result.skipped[0].reason, /Opened during validation/);
  assert.equal(h.results.length, 0);
  assert.equal(
    h.calls.some((call) => call.args.includes("remove")),
    false,
  );
});

test("bulk removal continues after Git refuses one checkout and routes every operation remotely", async () => {
  const first = { ...target, key: JSON.stringify(["build", "/repo with spaces/.git"]) };
  const second = { ...first, path: "/second" };
  const output = list + record(second.path);
  const h = harness([
    ok(output),
    ok(`${first.path}\n`),
    ok(),
    ok(),
    ok(output),
    ok(`${first.path}\n`),
    failed("permission denied"),
    ok(output),
    ok(`${second.path}\n`),
    ok(),
    ok(),
    ok(output),
    ok(`${second.path}\n`),
    ok(),
  ]);
  const result = await removeWorktrees(
    { targets: [first, second], skipped: [] },
    h.exec,
    () => null,
  );
  assert.deepEqual(result.removed, [second.path]);
  assert.match(result.skipped[0].reason, /permission denied/);
  assert.equal(h.results.length, 0);
  assert.ok(h.calls.every((call) => call.options.on === "build"));
});

test("bulk planning fails closed on inventory failure and unreadable submodule status", async () => {
  const unavailable = harness([failed("offline")]);
  await assert.rejects(
    planWorktreeRemoval(target.key, unavailable.exec, () => null),
    /offline/,
  );
  const h = harness([ok(list), ok(list), ok(`${target.path}\n`), ok(), failed("index unreadable")]);
  const plan = await planWorktreeRemoval(target.key, h.exec, () => null);
  assert.deepEqual(plan.targets, []);
  assert.ok(plan.skipped.some((item) => /index unreadable/.test(item.reason)));
});

test("real Git refuses dirty removal, removes a clean linked checkout and keeps its branch", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "frantss-worktree-removal-"));
  try {
    const root = await realpath(temporary);
    const main = join(root, "main checkout");
    const linked = join(root, "linked checkout");
    await mkdir(main);
    const exec: typeof Exec = (command, args, options) => {
      assert.equal(command, "git");
      assert.equal(options.on, null);
      return new Promise((resolve, reject) => {
        execFile(command, args, { cwd: options.cwd, encoding: "utf8" }, (error, stdout, stderr) => {
          if (error && typeof error.code !== "number") return reject(error);
          resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
        });
      });
    };
    const git = async (args: string[]) => {
      const result = await exec("git", args, { cwd: main, on: null });
      assert.equal(result.code, 0, result.stderr);
      return result.stdout;
    };
    await git(["init", "-b", "main"]);
    await git([
      "-c",
      "user.name=Worktree Removal Test",
      "-c",
      "user.email=worktree-removal@example.invalid",
      "commit",
      "--allow-empty",
      "--no-gpg-sign",
      "-m",
      "Initial test commit",
    ]);
    await git(["worktree", "add", "-b", "retained-branch", linked]);
    const key = JSON.stringify([null, join(main, ".git")]);
    const target = { key, path: linked };
    assert.deepEqual(await inspectWorktree(target, exec), { dirty: false });
    const dirtyFile = join(linked, "untracked local changes.txt");
    await writeFile(dirtyFile, "Keep these local changes.\n");
    assert.deepEqual(await inspectWorktree(target, exec), { dirty: true });
    await assert.rejects(
      removeWorktree(target, exec),
      /Remove worktree failed.*modified or untracked/,
    );
    assert.equal(await readFile(dirtyFile, "utf8"), "Keep these local changes.\n");
    const dirtyPlan = await planWorktreeRemoval(key, exec, () => null);
    assert.deepEqual(dirtyPlan.targets, []);
    assert.ok(dirtyPlan.skipped.some((item) => /local changes/.test(item.reason)));
    await unlink(dirtyFile);
    await git(["worktree", "lock", linked]);
    const lockedPlan = await planWorktreeRemoval(key, exec, () => null);
    assert.deepEqual(lockedPlan.targets, []);
    assert.ok(lockedPlan.skipped.some((item) => /locked/.test(item.reason)));
    await git(["worktree", "unlock", linked]);
    assert.deepEqual(await inspectWorktree(target, exec), { dirty: false });
    const plan = await planWorktreeRemoval(key, exec, () => null);
    assert.deepEqual(plan.targets, [target]);
    const result = await removeWorktrees(plan, exec, () => null);
    assert.deepEqual(result.removed, [linked]);
    await assert.rejects(stat(linked), { code: "ENOENT" });
    await git(["show-ref", "--verify", "refs/heads/retained-branch"]);
    await assert.rejects(removeWorktree({ key, path: main }, exec), /main checkout/);
    assert.ok((await stat(main)).isDirectory());
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("removal module is strip-only TypeScript with no runtime Herdr import", async () => {
  const source = await readFile(new URL("worktree-removal.ts", import.meta.url), "utf8");
  const stripped = stripTypeScriptTypes(source);
  assert.doesNotMatch(stripped, /from ["']herdr["']/);
});
