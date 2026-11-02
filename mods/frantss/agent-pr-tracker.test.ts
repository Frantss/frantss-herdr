import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { AgentPrTracker, PR_POLL_MS } from "./agent-pr-tracker.ts";
import { AGENT_PRS, AGENT_PR_ERRORS, type TrackedAgent } from "./agent-prs.ts";

const agent = (address: string, repo: string, number: number): TrackedAgent => ({
  address,
  name: address,
  status: "idle",
  closed: null,
  cwd: null,
  app: null,
  links: [{ repo, number, source: "created" }],
});
const node = (number: number) => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  state: "OPEN",
  headRefName: `b${number}`,
  isDraft: false,
  reviewDecision: null,
  mergeable: "MERGEABLE",
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
  reviewThreads: { nodes: [] },
});

function harness(failing = new Set<string>()) {
  const store = new Map<string, unknown>(),
    writes: string[] = [];
  const gh = async (args: string[]) => {
    const owner = args.find((arg) => arg.startsWith("owner=")).slice(6);
    if (failing.has(owner)) return { code: 1, stderr: "HTTP 502", stdout: "" };
    const numbers = [...args.join(" ").matchAll(/n(\d+): pullRequest/g)].map((m) => Number(m[1]));
    const repository = Object.fromEntries(numbers.map((n) => [`n${n}`, node(n)]));
    return { code: 0, stdout: JSON.stringify({ data: { repository } }) };
  };
  const tracker = new AgentPrTracker(
    gh,
    (key) => store.get(key) ?? null,
    (key, value) => {
      writes.push(key);
      store.set(key, value);
    },
  );
  return { tracker, store, writes };
}

test("a lookup is due when the links change or the poll interval passes", async () => {
  const { tracker } = harness();
  const agents = [agent("t1", "o/r", 4)];
  assert.ok(tracker.due(agents, 0));
  await tracker.lookUp(agents, 0);
  assert.ok(!tracker.due(agents, 1000));
  assert.ok(tracker.due([agent("t1", "o/r", 5)], 1000));
  assert.ok(tracker.due(agents, PR_POLL_MS));
});

test("a lookup shares each agent's PRs and writes only changes", async () => {
  const { tracker, store, writes } = harness();
  const agents = [agent("t1", "o/r", 4), agent("t2", "o/r", 7)];
  await tracker.lookUp(agents, 0);
  const prs = store.get(AGENT_PRS) as Record<string, { number: number; state: string }[]>;
  assert.deepEqual(
    Object.entries(prs).map(([address, list]) => [address, list.map((p) => [p.number, p.state])]),
    [
      ["t1", [[4, "failing"]]],
      ["t2", [[7, "failing"]]],
    ],
  );
  assert.deepEqual(writes, [AGENT_PRS]);
  await tracker.lookUp(agents, PR_POLL_MS);
  assert.deepEqual(writes, [AGENT_PRS]);
});

test("a repository that fails keeps its last PRs and reports its error", async () => {
  const failing = new Set<string>();
  const { tracker, store } = harness(failing);
  const agents = [agent("t1", "o/r", 4)];
  await tracker.lookUp(agents, 0);
  failing.add("o");
  await tracker.lookUp(agents, PR_POLL_MS);
  assert.equal((store.get(AGENT_PRS) as Record<string, unknown[]>).t1.length, 1);
  assert.deepEqual(store.get(AGENT_PR_ERRORS), { "o/r": "HTTP 502" });
});
