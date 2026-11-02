import type { exec as Exec } from "herdr";
import { parseWorktrees } from "./worktrees.ts";

export type RemovalTarget = { key: string; path: string };

type Repository = { machine: string | null; commonGitDir: string };

function repository(key: string): Repository {
  let parsed: unknown;
  try {
    parsed = JSON.parse(key);
  } catch {
    throw new Error("Invalid worktree repository key");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    !(parsed[0] === null || (typeof parsed[0] === "string" && parsed[0].length > 0)) ||
    typeof parsed[1] !== "string" ||
    !parsed[1]
  ) {
    throw new Error("Invalid worktree repository key or path");
  }
  return { machine: parsed[0], commonGitDir: parsed[1] };
}

async function git(
  exec: typeof Exec,
  args: string[],
  options: { cwd?: string; on: string | null },
  operation: string,
): Promise<string> {
  const result = await exec("git", args, options);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(`${operation} failed (exit ${result.code})${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

async function validateWorktree(target: RemovalTarget, exec: typeof Exec): Promise<Repository> {
  if (!target.path) throw new Error("Invalid worktree path");
  const repo = repository(target.key);
  const output = await git(
    exec,
    ["--git-dir", repo.commonGitDir, "worktree", "list", "--porcelain", "-z"],
    { on: repo.machine },
    "List registered worktrees",
  );
  const worktree = parseWorktrees(output).find((item) => item.path === target.path);
  if (!worktree) throw new Error(`Worktree is no longer registered: ${target.path}`);
  if (worktree.main) throw new Error(`Cannot remove the main checkout: ${target.path}`);
  const fields = output
    .split("\0\0")
    .find((record) => record.split("\0").includes(`worktree ${target.path}`))
    ?.split("\0");
  if (fields?.some((field) => field === "locked" || field.startsWith("locked ")))
    throw new Error("Worktree is locked.");
  const root = await git(
    exec,
    ["rev-parse", "--show-toplevel"],
    { cwd: target.path, on: repo.machine },
    "Verify worktree root",
  );
  if (root.replace(/\n$/, "") !== target.path) {
    throw new Error(`Worktree root no longer matches: ${target.path}`);
  }
  return repo;
}

export async function inspectWorktree(
  target: RemovalTarget,
  exec: typeof Exec,
): Promise<{ dirty: boolean }> {
  const repo = await validateWorktree(target, exec);
  const status = await git(
    exec,
    ["status", "--porcelain", "-z", "--untracked-files=normal"],
    { cwd: target.path, on: repo.machine },
    "Read worktree status",
  );
  return { dirty: status.length > 0 };
}

export type RemovalSkip = { path: string; reason: string };
export type RemovalPlan = { targets: RemovalTarget[]; skipped: RemovalSkip[] };
type RemovalBlock = (target: RemovalTarget) => string | null;

async function inspectEligibleWorktree(target: RemovalTarget, exec: typeof Exec): Promise<void> {
  if ((await inspectWorktree(target, exec)).dirty) throw new Error("Checkout has local changes.");
  const repo = repository(target.key);
  const index = await git(
    exec,
    ["ls-files", "--stage", "-z"],
    { cwd: target.path, on: repo.machine },
    "Check for submodules",
  );
  if (index.split("\0").some((entry) => entry.startsWith("160000 ")))
    throw new Error("Checkout contains submodules.");
}

export async function planWorktreeRemoval(
  key: string,
  exec: typeof Exec,
  blocked: RemovalBlock,
): Promise<RemovalPlan> {
  const repo = repository(key);
  const output = await git(
    exec,
    ["--git-dir", repo.commonGitDir, "worktree", "list", "--porcelain", "-z"],
    { on: repo.machine },
    "List registered worktrees",
  );
  const plan: RemovalPlan = { targets: [], skipped: [] };
  for (const tree of parseWorktrees(output)) {
    const target = { key, path: tree.path };
    try {
      if (tree.main) throw new Error("Main checkout is protected.");
      let reason = blocked(target);
      if (reason) throw new Error(reason);
      await inspectEligibleWorktree(target, exec);
      reason = blocked(target);
      if (reason) throw new Error(reason);
      plan.targets.push(target);
    } catch (error) {
      plan.skipped.push({ path: target.path, reason: String(error) });
    }
  }
  return plan;
}

export async function removeWorktrees(
  plan: RemovalPlan,
  exec: typeof Exec,
  blocked: RemovalBlock,
): Promise<{ removed: string[]; skipped: RemovalSkip[] }> {
  const result = { removed: [] as string[], skipped: [...plan.skipped] };
  for (const target of plan.targets) {
    try {
      let reason = blocked(target);
      if (reason) throw new Error(reason);
      await inspectEligibleWorktree(target, exec);
      reason = blocked(target);
      if (reason) throw new Error(reason);
      await removeWorktree(target, exec, blocked);
      result.removed.push(target.path);
    } catch (error) {
      result.skipped.push({ path: target.path, reason: String(error) });
    }
  }
  return result;
}

export async function removeWorktree(
  target: RemovalTarget,
  exec: typeof Exec,
  blocked?: RemovalBlock,
): Promise<void> {
  const repo = await validateWorktree(target, exec);
  const reason = blocked?.(target);
  if (reason) throw new Error(reason);
  await git(
    exec,
    ["--git-dir", repo.commonGitDir, "worktree", "remove", target.path],
    { on: repo.machine },
    "Remove worktree",
  );
}
