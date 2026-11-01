import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  CLOSED_LIMIT,
  age,
  closedAgents,
  recordAgents,
  resumeArgv,
  settleAgents,
  type AgentRecord,
} from "./closed.ts";

const claude = { name: "Claude Code", key: "claude", agent: true } as AgentRecord["program"];
const live = (address: string, title: string | null = null) => ({
  address,
  app: "claude-code",
  program: claude,
  title,
});

test("recording adds new agents and keeps the last telling title", () => {
  const first = recordAgents([], [live("t1", "Fix tabs")]);
  assert.deepEqual(first, [live("t1", "Fix tabs")]);
  assert.deepEqual(recordAgents(first, [live("t1"), live("t2")]), [
    live("t1", "Fix tabs"),
    live("t2"),
  ]);
});

test("recording keeps what settling learned", () => {
  const settled = [{ ...live("t1", "Fix tabs"), cwd: "/repo" }];
  assert.deepEqual(recordAgents(settled, [live("t1", "Fix rail")]), [
    { ...live("t1", "Fix rail"), cwd: "/repo" },
  ]);
});

test("settling drops unknown terminals, takes the core's cwd, and stamps a finish once", () => {
  const records = [live("t1"), live("t2"), live("t3")];
  const terminals = [
    { address: "t1", state: "live", cwd: "/live" },
    { address: "t2", state: "finished", cwd: "/done" },
  ];
  const settled = settleAgents(records, terminals, 1000);
  assert.deepEqual(settled, [
    { ...live("t1"), cwd: "/live" },
    { ...live("t2"), cwd: "/done", closed: 1000 },
  ]);
  assert.equal(settleAgents(settled, terminals, 5000)[1].closed, 1000);
});

test("settling keeps only the latest closed agents and every live one", () => {
  const records = Array.from({ length: CLOSED_LIMIT + 2 }, (_, i) => ({
    ...live(`t${i}`),
    closed: i,
  }));
  const terminals = records.map((r) => ({ address: r.address, state: "finished" }));
  terminals.push({ address: "live", state: "live" });
  const settled = settleAgents([...records, live("live")], terminals, 0);
  assert.equal(settled.length, CLOSED_LIMIT + 1);
  assert.ok(settled.some((r) => r.address === "live"));
  assert.ok(!settled.some((r) => r.address === "t0" || r.address === "t1"));
});

test("closed agents come latest first and skip live ones", () => {
  const records = [{ ...live("old"), closed: 1 }, live("open"), { ...live("new"), closed: 2 }];
  assert.deepEqual(
    closedAgents(records).map((r) => r.address),
    ["new", "old"],
  );
});

test("resume opens each agent's own session picker", () => {
  assert.deepEqual(resumeArgv("claude-code"), ["claude", "--resume"]);
  assert.deepEqual(resumeArgv("codex"), ["codex", "--no-daemon", "resume"]);
  assert.equal(resumeArgv("pi"), null);
  assert.equal(resumeArgv(null), null);
});

test("age names the largest whole unit", () => {
  assert.equal(age(59_000), "now");
  assert.equal(age(5 * 60_000), "5m");
  assert.equal(age(3 * 3_600_000 + 1), "3h");
  assert.equal(age(2 * 86_400_000), "2d");
});
