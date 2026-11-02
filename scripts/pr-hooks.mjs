// A PostToolUse hook for Claude Code and Codex, and the Pi extension's helper: labels the Herdr
// terminal with each pull request the agent creates and each GitHub branch it pushes, so Herdr can
// track that agent's pull requests. Prints nothing and never fails the tool call.
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;
// `To https://github.com/owner/repo.git`, `To github.com:owner/repo.git`, `To git@github.com:owner/repo`.
const PUSH_TARGET =
  /^To (?:(?:https|ssh):\/\/)?(?:[^@\s/]+@)?github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/;
// A pushed ref: ` * [new branch]  feat -> feat`, `   1a2b..3c4d  feat -> feat`, ` + 1a...2b  x -> x (forced update)`.
const PUSHED_REF = /^\s*[ *+]\s+(?:\[new branch\]|[0-9a-f]+\.\.\.?[0-9a-f]+)\s+\S+\s+->\s+(\S+)/;

// Every string in a tool result, whatever its shape: Claude Code sends stdout and stderr, Codex and
// Pi send their own shapes.
function texts(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(texts);
  if (value && typeof value === "object") return Object.values(value).flatMap(texts);
  return [];
}

// The labels for one tool call: `frantss.pr.owner/repo#12=created` for a created pull request and
// `frantss.branch.owner/repo:feat=pushed` for a pushed branch.
export function prLabels(tool, command, output) {
  const labels = new Set();
  const created =
    tool.endsWith("create_pull_request") ||
    (tool === "Bash" && /\bgh\s+pr\s+create\b/.test(command));
  if (created)
    for (const [, repo, number] of output.matchAll(PR_URL))
      labels.add(`frantss.pr.${repo}#${number}=created`);
  if (tool === "Bash" && /\bgit\b.*\bpush\b/.test(command)) {
    let repo = null;
    for (const line of output.split("\n")) {
      if (line.startsWith("To ")) repo = PUSH_TARGET.exec(line.trim())?.[1] ?? null;
      const branch = repo && PUSHED_REF.exec(line)?.[1];
      if (branch)
        labels.add(`frantss.branch.${repo}:${branch.replace(/^refs\/heads\//, "")}=pushed`);
    }
  }
  return [...labels];
}

export async function handlePrHook(payload, { env = process.env, label = hcLabel } = {}) {
  try {
    const terminal = env.HC_TERMINAL_ID;
    if (!terminal || !payload || typeof payload !== "object") return;
    const tool = typeof payload.tool_name === "string" ? payload.tool_name : "";
    const command =
      typeof payload.tool_input?.command === "string" ? payload.tool_input.command : "";
    const labels = prLabels(tool, command, texts(payload.tool_response).join("\n"));
    if (labels.length) await label(terminal, labels);
  } catch {}
}

function hcLabel(terminal, labels) {
  return new Promise((resolve) =>
    execFile("hc", ["label", terminal, ...labels], { timeout: 5000 }, () => resolve()),
  );
}

async function main() {
  if (!process.env.HC_TERMINAL_ID) return;
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) return;
    chunks.push(chunk);
  }
  await handlePrHook(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

try {
  if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    setTimeout(() => process.exit(0), 8000).unref();
    await main();
  }
} catch {}
process.exitCode = 0;
