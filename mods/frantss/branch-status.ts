export type BranchStatus = { ahead: number; behind: number };

// `git status --porcelain=v2 --branch` without locks or fsmonitor, so reading never writes under .git.
export const BRANCH_STATUS_ARGS = [
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "status",
  "--porcelain=v2",
  "--branch",
  "--untracked-files=no",
];

// Commits ahead of and behind the upstream; none without an upstream.
export function parseBranchStatus(output: string): BranchStatus {
  const line = output.split("\n").find((each) => each.startsWith("# branch.ab "));
  const [ahead, behind] = (line?.slice("# branch.ab ".length).split(" ") ?? []).map(
    (count) => Math.abs(parseInt(count, 10)) || 0,
  );
  return { ahead: ahead ?? 0, behind: behind ?? 0 };
}
