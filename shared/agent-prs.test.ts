import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { mostUrgentPr, prLinks, type AgentPr } from "./agent-prs.ts";

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
