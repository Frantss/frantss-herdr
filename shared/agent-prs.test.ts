import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  agentPullRequests,
  loadLinkedPrs,
  mostUrgentPr,
  prLinks,
  prState,
  trackedAgents,
  type AgentPr,
} from "./agent-prs.ts";

const rollup = (state: string) => ({ nodes: [{ commit: { statusCheckRollup: { state } } }] });

test("links come from created, pushed and panel labels", () => {
  assert.deepEqual(
    prLinks({
      "frantss.pr.acme/app#42": "created",
      "frantss.branch.acme/app:fix/ci": "pushed",
      "herdr.pr": "acme/app#7",
      "herdr.pr.action": "fix-ci",
      "frantss.session": "/tmp/session.jsonl",
      "frantss.pr.not-a-pr": "created",
    }),
    [
      { repo: "acme/app", number: 42, source: "created" },
      { repo: "acme/app", branch: "fix/ci", source: "pushed" },
      { repo: "acme/app", number: 7, source: "panel" },
    ],
  );
  assert.deepEqual(prLinks(undefined), []);
});

test("the most urgent state wins", () => {
  const pr = (state: AgentPr["state"]) => ({ state }) as AgentPr;
  assert.equal(mostUrgentPr([pr("ready"), pr("failing"), pr("comments")]), "failing");
  assert.equal(mostUrgentPr([pr("merged"), pr("pending")]), "pending");
  assert.equal(mostUrgentPr([]), null);
});

const linkedNode = (number: number, overrides = {}) => ({
  number,
  title: "Add login",
  url: `https://github.com/o/r/pull/${number}`,
  isDraft: false,
  headRefName: "feat/login",
  reviewDecision: null,
  commits: rollup("SUCCESS"),
  reviewThreads: { nodes: [] },
  state: "OPEN",
  mergeable: "MERGEABLE",
  ...overrides,
});

test("a pull request's state is its most urgent one", () => {
  const state = (overrides) => prState(linkedNode(1, overrides) as Parameters<typeof prState>[0]);
  assert.equal(state({ state: "MERGED" }), "merged");
  assert.equal(
    state({ commits: rollup("FAILURE"), reviewDecision: "CHANGES_REQUESTED" }),
    "failing",
  );
  assert.equal(state({ reviewDecision: "CHANGES_REQUESTED" }), "changes");
  assert.equal(state({ mergeable: "CONFLICTING" }), "conflicts");
  assert.equal(
    state({ reviewThreads: { nodes: [{ isResolved: false, isOutdated: false }] } }),
    "comments",
  );
  assert.equal(state({ commits: rollup("PENDING") }), "pending");
  assert.equal(state({ reviewDecision: "APPROVED" }), "ready");
  assert.equal(state({ reviewDecision: "APPROVED", isDraft: true }), "open");
});

test("linked pull requests load in one query, missing ones and the default branch skipped", async () => {
  const calls = [];
  const gh = async (args) => {
    calls.push(args);
    return {
      code: 1,
      stderr: "Could not resolve to a PullRequest with the number of 9.",
      stdout: JSON.stringify({
        data: {
          repository: {
            defaultBranchRef: { name: "main" },
            n4: linkedNode(4),
            n9: null,
            b0: { nodes: [linkedNode(5, { headRefName: "feat", state: "MERGED" })] },
            b1: { nodes: [linkedNode(6)] },
          },
        },
      }),
    };
  };
  const { byNumber, byBranch } = await loadLinkedPrs(gh, "o/r", [4, 9], ["feat", "main"]);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("b0=feat") && calls[0].includes("b1=main"));
  assert.deepEqual([...byNumber.keys()], [4]);
  assert.deepEqual([...byBranch.keys()], ["feat"]);
  assert.equal(byBranch.get("feat")[0].state, "merged");
  await assert.rejects(
    loadLinkedPrs(async () => ({ code: 1, stderr: "HTTP 401", stdout: "" }), "o/r", [1], []),
    /HTTP 401/,
  );
});

test("an agent's pull requests are listed once, created before pushed, most urgent first", () => {
  const pr = (number, state) => ({
    repo: "o/r",
    number,
    title: "",
    url: "",
    branch: `b${number}`,
    state,
  });
  const lookups = new Map([
    [
      "o/r",
      {
        byNumber: new Map([[2, pr(2, "pending")]]),
        byBranch: new Map([
          ["b2", [pr(2, "pending")]],
          ["b3", [pr(3, "failing")]],
        ]),
      },
    ],
  ]);
  const prs = agentPullRequests(
    [
      { repo: "o/r", branch: "b2", source: "pushed" },
      { repo: "o/r", number: 2, source: "created" },
      { repo: "o/r", branch: "b3", source: "pushed" },
      { repo: "x/y", number: 1, source: "created" },
    ],
    lookups,
  );
  assert.deepEqual(
    prs.map((p) => [p.number, p.source]),
    [
      [3, "pushed"],
      [2, "created"],
    ],
  );
});

test("tracked agents are live local terminals with links, then closed records", () => {
  const prs = [{ repo: "o/r", number: 1, source: "created" as const }];
  const labels = { "frantss.pr.o/r#1": "created" };
  const tracked = trackedAgents(
    [
      { address: "t1", state: "live", cwd: "/a", labels },
      { address: "t2", state: "live", labels: {} },
      { address: "m/t3", state: "live", labels },
      { address: "t4", state: "finished", labels },
    ],
    [{ address: "t1", title: "Fix CI", status: "working", app: "pi" }],
    [
      { address: "t1", title: "old", app: "pi", closed: 5, prs },
      { address: "t5", title: null, program: { name: "Codex" }, app: "codex", closed: 9, prs },
      { address: "t6", title: "no links", app: "pi", closed: 9 },
    ],
  );
  assert.deepEqual(
    tracked.map((a) => [a.address, a.name, a.status, a.closed]),
    [
      ["t1", "Fix CI", "working", null],
      ["t5", "Codex", null, 9],
    ],
  );
});
