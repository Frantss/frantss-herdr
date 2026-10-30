import type { ExecResult } from "herdr";

export type GitHubExecutor = (
  args: string[],
) => Promise<Pick<ExecResult, "code"> & Partial<Omit<ExecResult, "code">>>;
export interface ReviewThread {
  path: string;
  line: number | null;
  author: string;
  body: string;
  url?: string;
  replies: number;
}
export interface FailedCheck {
  name: string;
  url?: string;
}
export interface PullRequest {
  number: number;
  title: string;
  url: string;
  branch: string;
  draft: boolean;
  author: string;
  decision: string | null;
  additions: number;
  deletions: number;
  updatedAt: string | null;
  conflicts: boolean;
  requested: string[];
  checks: { state: string | null; total: number; pending: number; failed: FailedCheck[] };
  threads: ReviewThread[];
}
export interface PullRequests {
  repo: string;
  viewer: string;
  prs: PullRequest[];
}
export type InboxKind = "fix-ci" | "address" | "review" | "open";
export interface InboxItem {
  id: string;
  kind: InboxKind;
  pr: PullRequest;
  detail: string;
}
export interface InboxGroup {
  key: "ci" | "comments" | "review" | "ready";
  title: string;
  items: InboxItem[];
}
interface CheckRun {
  __typename: "CheckRun";
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl?: string;
}
interface StatusContext {
  __typename: "StatusContext";
  context: string;
  state: string;
  targetUrl?: string;
}
interface PullRequestNode {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  isDraft: boolean;
  author?: { login: string };
  reviewDecision: string | null;
  additions?: number;
  deletions?: number;
  updatedAt?: string;
  mergeable?: string;
  reviewRequests: { nodes: { requestedReviewer?: { login?: string } }[] };
  commits: {
    nodes: {
      commit: {
        statusCheckRollup?: { state: string; contexts: { nodes: (CheckRun | StatusContext)[] } };
      };
    }[];
  };
  reviewThreads: {
    nodes: {
      isResolved: boolean;
      isOutdated: boolean;
      path: string;
      line: number | null;
      comments: {
        totalCount?: number;
        nodes: { author?: { login: string }; body: string; url?: string }[];
      };
    }[];
  };
}

const QUERY = `query($owner: String!, $name: String!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    nameWithOwner
    pullRequests(states: OPEN, first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number title url isDraft headRefName reviewDecision additions deletions updatedAt mergeable
        author { login }
        reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }
        commits(last: 1) { nodes { commit { statusCheckRollup {
          state
          contexts(first: 100) { nodes {
            __typename
            ... on CheckRun { name status conclusion detailsUrl }
            ... on StatusContext { context state targetUrl }
          } }
        } } } }
        reviewThreads(first: 100) { nodes {
          isResolved isOutdated path line
          comments(first: 1) { totalCount nodes { author { login } body url } }
        } }
      }
    }
  }
}`;

const failedConclusions = new Set([
  "FAILURE",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "ERROR",
]);
const pendingStates = new Set(["PENDING", "EXPECTED"]);
const threadLimit = 20;
const bodyLimit = 400;

export const ACTIONS = Object.freeze({ "fix-ci": "Fix CI", address: "Address", review: "Review" });

async function run(gh: GitHubExecutor, args: string[]): Promise<string> {
  const result = await gh(args);
  if (result.code !== 0)
    throw new Error(result.stderr?.trim() || `gh ${args[0]} failed (${result.code})`);
  return result.stdout;
}

function parsePullRequest(node: PullRequestNode): PullRequest {
  const rollup = node.commits.nodes[0]?.commit.statusCheckRollup;
  const checks = (rollup?.contexts.nodes ?? []).map((c) =>
    c.__typename === "CheckRun"
      ? {
          name: c.name,
          url: c.detailsUrl,
          failed: failedConclusions.has(c.conclusion),
          pending: c.status !== "COMPLETED",
        }
      : {
          name: c.context,
          url: c.targetUrl,
          failed: failedConclusions.has(c.state),
          pending: pendingStates.has(c.state),
        },
  );
  const threads = node.reviewThreads.nodes
    .filter((thread) => !thread.isResolved && !thread.isOutdated)
    .map((thread) => {
      const comment = thread.comments.nodes[0];
      return {
        path: thread.path,
        line: thread.line,
        author: comment?.author?.login ?? "ghost",
        body: comment?.body ?? "",
        url: comment?.url,
        replies: Math.max(0, (thread.comments.totalCount ?? 1) - 1),
      };
    });
  return {
    number: node.number,
    title: node.title,
    url: node.url,
    branch: node.headRefName,
    draft: node.isDraft,
    author: node.author?.login ?? "ghost",
    decision: node.reviewDecision,
    additions: node.additions ?? 0,
    deletions: node.deletions ?? 0,
    updatedAt: node.updatedAt ?? null,
    conflicts: node.mergeable === "CONFLICTING",
    requested: node.reviewRequests.nodes.map((r) => r.requestedReviewer?.login).filter(Boolean),
    checks: {
      state: rollup?.state ?? null,
      total: checks.length,
      pending: checks.filter((c) => c.pending).length,
      failed: checks.filter((c) => c.failed).map(({ name, url }) => ({ name, url })),
    },
    threads,
  };
}

// Open pull requests of the repository `owner/name`, else the one that `gh` resolves from its
// working folder.
export async function loadPullRequests(
  gh: GitHubExecutor,
  nameWithOwner?: string,
): Promise<PullRequests> {
  let owner: string, name: string;
  if (nameWithOwner) [owner, name] = nameWithOwner.split("/");
  else {
    const repo = JSON.parse(await run(gh, ["repo", "view", "--json", "owner,name"]));
    [owner, name] = [repo.owner.login, repo.name];
  }
  const { data } = JSON.parse(
    await run(gh, [
      "api",
      "graphql",
      "-f",
      `query=${QUERY}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
    ]),
  );
  return {
    repo: data.repository.nameWithOwner,
    viewer: data.viewer.login,
    prs: data.repository.pullRequests.nodes.map(parsePullRequest),
  };
}

const unique = <T>(values: T[]): T[] => [...new Set(values)];

// Groups the work each pull request asks for. `busy` holds the item ids an agent already works on.
export function buildInbox(
  { prs, viewer }: Pick<PullRequests, "prs" | "viewer">,
  busy = new Set<string>(),
): InboxGroup[] {
  const groups: InboxGroup[] = [
    { key: "ci", title: "Failing CI", items: [] },
    { key: "comments", title: "Comments", items: [] },
    { key: "review", title: "Review requested", items: [] },
    { key: "ready", title: "Ready to merge", items: [] },
  ];
  const [ci, comments, review, ready] = groups;
  for (const pr of prs) {
    const item = (kind: InboxKind, detail: string): InboxItem => ({
      id: `${pr.number}:${kind}`,
      kind,
      pr,
      detail,
    });
    if (pr.checks.failed.length)
      ci.items.push(item("fix-ci", unique(pr.checks.failed.map((c) => c.name)).join(", ")));
    if (pr.threads.length)
      comments.items.push(
        item(
          "address",
          `${pr.threads.length} unresolved · ${unique(pr.threads.map((t) => t.author)).join(", ")}`,
        ),
      );
    else if (pr.decision === "CHANGES_REQUESTED")
      comments.items.push(item("address", "Changes requested"));
    if (pr.author !== viewer && pr.requested.includes(viewer))
      review.items.push(item("review", `by ${pr.author}`));
    if (!pr.draft && pr.decision === "APPROVED" && pr.checks.state === "SUCCESS")
      ready.items.push(item("open", `by ${pr.author}`));
  }
  for (const group of groups) group.items = group.items.filter((item) => !busy.has(item.id));
  return groups;
}

export const squash = (text: string): string =>
  text.replace(/\s+/g, " ").trim().slice(0, bodyLimit);

function section(item: InboxItem): string {
  const { pr } = item;
  if (item.kind === "fix-ci") {
    const checks = pr.checks.failed
      .map((c) => `- ${c.name}${c.url ? ` (${c.url})` : ""}`)
      .join("\n");
    return `These CI checks fail:\n${checks}\n\nRead the failure logs with \`gh pr checks ${pr.number}\` and \`gh run view <run-id> --log-failed\`. Find the cause, fix it, and run the same checks locally.`;
  }
  if (item.kind === "address") {
    const shown = pr.threads
      .slice(0, threadLimit)
      .map((t) => `- ${t.path}${t.line ? `:${t.line}` : ""} (${t.author}): ${squash(t.body)}`)
      .join("\n");
    const more =
      pr.threads.length > threadLimit
        ? `\n- …and ${pr.threads.length - threadLimit} more. Read all of them with \`gh pr view ${pr.number} --comments\`.`
        : "";
    const comments = shown
      ? `Unresolved review comments:\n${shown}${more}`
      : `The reviewers requested changes. Read the reviews with \`gh pr view ${pr.number} --comments\`.`;
    return `${comments}\n\nAddress each comment. Do not reply on GitHub or resolve threads. When done, list each comment with what you changed, or why you changed nothing.`;
  }
  if (item.kind === "review") {
    return `Review this pull request. Read the change with \`gh pr diff ${pr.number}\` and the description with \`gh pr view ${pr.number}\`. Report correctness problems, risks and missing tests, most severe first, with file and line. Do not post anything to GitHub.`;
  }
  throw new Error(`No agent task for ${item.kind}.`);
}

// The first message for the agent that works on one pull request's inbox items.
export function taskFor(items: InboxItem[], repo: string, { push = false } = {}): string {
  const { pr } = items[0];
  const intro = `Pull request #${pr.number} "${pr.title}" in ${repo} (${pr.url}), branch ${pr.branch}. This folder has that branch checked out.`;
  const changes = items.some((item) => item.kind !== "review");
  const finish = !changes
    ? "Do not change code."
    : push
      ? "Commit your changes and push them to the pull request branch."
      : "Commit your changes. Do not push. Tell me when the work is ready for me to check.";
  return [intro, ...items.map(section), finish].join("\n\n");
}

// The checkout of `branch` in `git worktree list --porcelain` output, or null.
export function findCheckout(porcelain: string, branch: string): string | null {
  for (const block of porcelain.split(/\n\n+/)) {
    const lines = block.split("\n");
    if (lines.includes(`branch refs/heads/${branch}`))
      return lines.find((line) => line.startsWith("worktree "))?.slice(9) ?? null;
  }
  return null;
}
