import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { buildInbox, findCheckout, loadPullRequests, taskFor } from "./github.ts";

const node = (overrides = {}) => ({
  number: 1,
  title: "Add login",
  url: "https://github.com/o/r/pull/1",
  isDraft: false,
  headRefName: "feat/login",
  reviewDecision: null,
  author: { login: "ana" },
  reviewRequests: { nodes: [] },
  commits: {
    nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [] } } } }],
  },
  reviewThreads: { nodes: [] },
  ...overrides,
});

function fakeGh(nodes, viewer = "me") {
  return async (args) =>
    args[0] === "repo"
      ? { code: 0, stdout: JSON.stringify({ owner: { login: "o" }, name: "r" }) }
      : {
          code: 0,
          stdout: JSON.stringify({
            data: {
              viewer: { login: viewer },
              repository: { nameWithOwner: "o/r", pullRequests: { nodes } },
            },
          }),
        };
}

const rollup = (state, contexts) => ({
  nodes: [{ commit: { statusCheckRollup: { state, contexts: { nodes: contexts } } } }],
});
const thread = (fields = {}) => ({
  isResolved: false,
  isOutdated: false,
  path: "src/a.ts",
  line: 3,
  comments: {
    totalCount: undefined as number | undefined,
    nodes: [{ author: { login: "leo" }, body: "rename\n this", url: "u" }],
  },
  ...fields,
});

test("groups failing checks, unresolved threads, review requests and approved PRs", async () => {
  const data = await loadPullRequests(
    fakeGh([
      node({
        number: 1,
        commits: rollup("FAILURE", [
          { __typename: "CheckRun", name: "test", conclusion: "FAILURE", detailsUrl: "x" },
          { __typename: "CheckRun", name: "lint", conclusion: "SUCCESS", detailsUrl: "y" },
          { __typename: "StatusContext", context: "ci/legacy", state: "ERROR", targetUrl: "z" },
        ]),
      }),
      node({
        number: 2,
        reviewThreads: {
          nodes: [thread(), thread({ isResolved: true }), thread({ isOutdated: true })],
        },
      }),
      node({ number: 3, reviewDecision: "CHANGES_REQUESTED" }),
      node({
        number: 4,
        reviewRequests: {
          nodes: [{ requestedReviewer: { login: "me" } }, { requestedReviewer: {} }],
        },
      }),
      node({ number: 5, reviewDecision: "APPROVED" }),
      node({ number: 6, reviewDecision: "APPROVED", isDraft: true }),
    ]),
  );
  const groups = Object.fromEntries(
    buildInbox(data).map((g) => [g.key, g.items.map((i) => [i.pr.number, i.detail])]),
  );
  assert.deepEqual(groups, {
    ci: [[1, "test, ci/legacy"]],
    comments: [
      [2, "1 unresolved · leo"],
      [3, "Changes requested"],
    ],
    review: [[4, "by ana"]],
    ready: [[5, "by ana"]],
  });
});

test("hides items an agent already works on", async () => {
  const data = await loadPullRequests(fakeGh([node({ reviewDecision: "CHANGES_REQUESTED" })]));
  assert.equal(buildInbox(data, new Set(["1:address"]))[1].items.length, 0);
});

test("does not ask authors to review their own pull request", async () => {
  const data = await loadPullRequests(
    fakeGh([
      node({
        author: { login: "me" },
        reviewRequests: { nodes: [{ requestedReviewer: { login: "me" } }] },
      }),
    ]),
  );
  assert.equal(buildInbox(data)[2].items.length, 0);
});

test("reports gh errors", async () => {
  await assert.rejects(
    loadPullRequests(async () => ({ code: 1, stderr: "not a git repository" })),
    /not a git repository/,
  );
});

test("combines several actions for one pull request into one task", async () => {
  const data = await loadPullRequests(
    fakeGh([
      node({
        commits: rollup("FAILURE", [
          { __typename: "CheckRun", name: "test", conclusion: "FAILURE", detailsUrl: "x" },
        ]),
        reviewThreads: { nodes: [thread()] },
      }),
    ]),
  );
  const items = buildInbox(data).flatMap((g) => g.items);
  const task = taskFor(items, data.repo);
  assert.match(task, /These CI checks fail:\n- test \(x\)/);
  assert.match(task, /- src\/a.ts:3 \(leo\): rename this/);
  assert.match(task, /Do not push\./);
  assert.match(taskFor(items, data.repo, { push: true }), /push them to the pull request branch/);
});

test("review tasks forbid code changes", async () => {
  const data = await loadPullRequests(
    fakeGh([node({ reviewRequests: { nodes: [{ requestedReviewer: { login: "me" } }] } })]),
  );
  assert.match(taskFor(buildInbox(data)[2].items, data.repo), /Do not change code\.$/);
});

test("counts replies in a conversation", async () => {
  const replied = thread();
  replied.comments.totalCount = 3;
  const data = await loadPullRequests(
    fakeGh([node({ reviewThreads: { nodes: [replied, thread()] } })]),
  );
  assert.deepEqual(
    data.prs[0].threads.map((t) => t.replies),
    [2, 0],
  );
});

test("summarizes checks, size and conflicts", async () => {
  const data = await loadPullRequests(
    fakeGh([
      node({
        additions: 120,
        deletions: 30,
        mergeable: "CONFLICTING",
        updatedAt: "2026-10-29T10:00:00Z",
        commits: rollup("PENDING", [
          {
            __typename: "CheckRun",
            name: "test",
            status: "COMPLETED",
            conclusion: "FAILURE",
            detailsUrl: "x",
          },
          {
            __typename: "CheckRun",
            name: "e2e",
            status: "IN_PROGRESS",
            conclusion: null,
            detailsUrl: "y",
          },
          { __typename: "StatusContext", context: "deploy", state: "PENDING", targetUrl: "z" },
          { __typename: "StatusContext", context: "lint", state: "SUCCESS", targetUrl: "w" },
        ]),
      }),
    ]),
  );
  const [pr] = data.prs;
  assert.deepEqual(
    { total: pr.checks.total, pending: pr.checks.pending, failed: pr.checks.failed.length },
    { total: 4, pending: 2, failed: 1 },
  );
  assert.deepEqual(
    [pr.additions, pr.deletions, pr.conflicts, pr.updatedAt],
    [120, 30, true, "2026-10-29T10:00:00Z"],
  );
});

test("finds the checkout of a branch", () => {
  const porcelain =
    "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /wt/feat\nHEAD def\nbranch refs/heads/feat/login\n";
  assert.equal(findCheckout(porcelain, "feat/login"), "/wt/feat");
  assert.equal(findCheckout(porcelain, "feat"), null);
});
