import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { handlePrHook, prLabels } from "./pr-hooks.mjs";

const pushOutput = `remote:
remote: Create a pull request for 'feat' on GitHub by visiting:
remote:      https://github.com/acme/app/pull/new/feat
remote:
To https://github.com/acme/app.git
 * [new branch]      feat -> feat
   1a2b3c4..5d6e7f8  fix/ci -> fix/ci
 + 1a2b3c4...5d6e7f8 old -> old (forced update)
 ! [rejected]        main -> main (fetch first)
 - [deleted]         gone
 * [new tag]         v1.0 -> v1.0
branch 'feat' set up to track 'origin/feat'.`;

test("gh pr create labels the pull request it prints", () => {
  assert.deepEqual(
    prLabels(
      "Bash",
      "git push -u origin feat && gh pr create --fill",
      "Creating pull request for feat into main in acme/app\n\nhttps://github.com/acme/app/pull/42\n",
    ),
    ["frantss.pr.acme/app#42=created"],
  );
});

test("pull request URLs count only from a create", () => {
  assert.deepEqual(prLabels("Bash", "gh pr view 42", "https://github.com/acme/app/pull/42"), []);
  assert.deepEqual(
    prLabels(
      "mcp__github__create_pull_request",
      "",
      '{"html_url":"https://github.com/acme/app/pull/7"}',
    ),
    ["frantss.pr.acme/app#7=created"],
  );
});

test("git push labels the branches it created or updated on GitHub", () => {
  assert.deepEqual(prLabels("Bash", "git push --force-with-lease", pushOutput), [
    "frantss.branch.acme/app:feat=pushed",
    "frantss.branch.acme/app:fix/ci=pushed",
    "frantss.branch.acme/app:old=pushed",
  ]);
});

test("pushes to SSH remotes count; other hosts and failed pushes don't", () => {
  const ref = " * [new branch]      feat -> feat";
  for (const to of [
    "To github.com:acme/app.git",
    "To git@github.com:acme/app",
    "To ssh://git@github.com/acme/app.git",
  ])
    assert.deepEqual(prLabels("Bash", "git push", `${to}\n${ref}`), [
      "frantss.branch.acme/app:feat=pushed",
    ]);
  assert.deepEqual(prLabels("Bash", "git push", `To https://gitlab.com/acme/app.git\n${ref}`), []);
  assert.deepEqual(
    prLabels("Bash", "git push", "To https://github.com/acme/app.git\n ! [rejected] feat -> feat"),
    [],
  );
  assert.deepEqual(prLabels("Bash", "cat push.log", pushOutput), []);
});

test("the hook reads any result shape and labels its terminal", async () => {
  const calls: [string, string[]][] = [];
  const label = async (terminal: string, labels: string[]) => {
    calls.push([terminal, labels]);
  };
  const payload = (response: unknown) => ({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "gh pr create --fill" },
    tool_response: response,
  });
  const env = { HC_TERMINAL_ID: "t7" };
  await handlePrHook(payload({ stdout: "https://github.com/acme/app/pull/1", stderr: "" }), {
    env,
    label,
  });
  await handlePrHook(payload("https://github.com/acme/app/pull/2"), { env, label });
  await handlePrHook(payload([{ type: "text", text: "https://github.com/acme/app/pull/3" }]), {
    env,
    label,
  });
  await handlePrHook(payload("https://github.com/acme/app/pull/4"), { env: {}, label });
  await handlePrHook(payload("no link"), { env, label });
  assert.deepEqual(calls, [
    ["t7", ["frantss.pr.acme/app#1=created"]],
    ["t7", ["frantss.pr.acme/app#2=created"]],
    ["t7", ["frantss.pr.acme/app#3=created"]],
  ]);
});

test("a failing label command doesn't throw", async () => {
  await handlePrHook(
    {
      tool_name: "Bash",
      tool_input: { command: "gh pr create" },
      tool_response: "https://github.com/a/b/pull/1",
    },
    {
      env: { HC_TERMINAL_ID: "t7" },
      label: async () => {
        throw new Error("no hc");
      },
    },
  );
});
