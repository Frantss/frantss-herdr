import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  agentChoices,
  agentName,
  lineSide,
  pickAgent,
  reviewMessage,
  withComments,
  withComposer,
} from "./review.ts";

const comment = (
  path: string,
  side: "old" | "new",
  number: number,
  quote: string,
  text: string,
) => ({
  path,
  side,
  number,
  quote,
  text,
});

test("review messages quote each line and end with the note", () => {
  assert.equal(
    reviewMessage(
      [
        comment("a.ts", "new", 42, "const x = 1;", "Rename this."),
        comment("b.ts", "old", 17, "old code", "Why remove this?"),
      ],
      "  Looks close.  ",
    ),
    [
      "Review comments:",
      "",
      "a.ts:42",
      "> const x = 1;",
      "Rename this.",
      "",
      "b.ts:17 (removed line)",
      "> old code",
      "Why remove this?",
      "",
      "Looks close.",
    ].join("\n"),
  );
  assert.equal(
    reviewMessage([comment("a.ts", "new", 1, "x", "Hi.")], " "),
    "Review comments:\n\na.ts:1\n> x\nHi.",
  );
});

test("the review goes to the most recently changed agent in the space", () => {
  const agents = [
    { address: "t1", space: "s1", seq: 5 },
    { address: "t2", space: "s2", seq: 9 },
    { address: "t3", space: "s1", seq: 7 },
  ];
  assert.equal(pickAgent(agents, "s1")?.address, "t3");
  assert.equal(pickAgent(agents, "s3"), null);
});

test("a chosen agent wins while it lives, and choices list this space first", () => {
  const agents = [
    { address: "t1", space: "s1", seq: 5 },
    { address: "t2", space: "s2", seq: 9 },
    { address: "t3", space: "s1", seq: 7 },
  ];
  assert.equal(pickAgent(agents, "s1", "t2")?.address, "t2");
  assert.equal(pickAgent(agents, "s1", "gone")?.address, "t3");
  assert.equal(pickAgent(agents, "s3", "t1")?.address, "t1");
  assert.deepEqual(
    agentChoices(agents, "s1").map((agent) => agent.address),
    ["t3", "t1", "t2"],
  );
});

test("diff lines name their side: removed lines the old file, others the new one", () => {
  assert.equal(lineSide({ kind: "-", number: 1, text: "a" }), "old");
  assert.equal(lineSide({ kind: "+", number: 1, text: "a" }), "new");
  assert.equal(lineSide({ kind: " ", number: 1, text: "a" }), "new");
  assert.equal(lineSide({ kind: "@", number: 1, text: "@@" }), null);
  assert.equal(lineSide({ kind: "", text: "\\ No newline" }), null);
});

test("comments show under their line, and changed or missing lines are outdated at the end", () => {
  const rows = [
    { kind: "-", number: 1, text: "a" },
    { kind: "+", number: 1, text: "b" },
    { kind: " ", number: 2, text: "c" },
  ];
  const comments = [
    comment("x.ts", "new", 1, "b", "On b"),
    comment("x.ts", "old", 1, "a", "On a"),
    comment("other.ts", "new", 1, "b", "Elsewhere"),
    comment("x.ts", "new", 2, "was c", "Changed"),
    comment("x.ts", "new", 9, "gone", "Missing"),
  ];
  assert.deepEqual(
    withComments(rows, comments, "x.ts").map((row) => [
      row.kind,
      row.text,
      row.comment,
      row.outdated,
    ]),
    [
      ["-", "a", undefined, undefined],
      ["#", "On a", 1, undefined],
      ["+", "b", undefined, undefined],
      ["#", "On b", 0, undefined],
      [" ", "c", undefined, undefined],
      ["#", "Changed", 3, true],
      ["#", "Missing", 4, true],
    ],
  );
  assert.equal(withComments(rows, [], "x.ts"), rows);
});

test("the comment box follows its line, or replaces the comment it edits", () => {
  const rows = [
    { kind: "-", number: 1, text: "a" },
    { kind: "+", number: 1, text: "b" },
    { kind: "#", text: "On b", comment: 0 },
  ];
  const line = { path: "x.ts", side: "old" as const, number: 1, quote: "a" };
  assert.deepEqual(
    withComposer(rows, { ...line, index: null }).map((row) => row.kind),
    ["-", "compose", "+", "#"],
  );
  assert.deepEqual(
    withComposer(rows, { ...line, side: "new", quote: "b", index: 0 }).map((row) => row.kind),
    ["-", "+", "compose"],
  );
  assert.deepEqual(
    withComposer(rows, { ...line, number: 9, index: null }).map((row) => row.kind),
    ["-", "+", "#", "compose"],
  );
  assert.equal(withComposer(rows, null), rows);
});

test("agents go by their tab's given name, else their thread, else their program", () => {
  const program = { name: "Claude Code", key: "claude" } as never;
  const agent = (title: string) => ({ title, program });
  assert.equal(agentName(agent("✳ Fix tests"), { name: "Review", named: true }), "Review");
  assert.equal(
    agentName(agent("✳ Herdr plugins in UI"), { name: "2", named: false }),
    "herdr plugins in ui",
  );
  assert.equal(agentName(agent("Claude Code"), undefined), "claude code");
  assert.equal(agentName(agent("me@host"), undefined), "claude code");
});
