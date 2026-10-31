// How full an agent's context window is, from the last usage line in its session file. The
// session-label hook (scripts/session-label.sh) puts that file's path on the agent's terminal.

export const SESSION_LABEL = "frantss.session";

// A line that has the usage, per app, to find the last one with grep.
const USAGE_LINE: Record<string, string> = {
  "claude-code": '"usage":{"input_tokens"',
  codex: '"type":"token_count","info":{',
};

// `window`: null when the session file doesn't say (Claude Code's doesn't).
export type ContextUsage = { tokens: number; window: number | null };

// The last usage line in a session file, or null for an app this can't read.
export const usageLineArgv = (app: string | null, transcript: string) =>
  USAGE_LINE[app]
    ? [
        "sh",
        "-c",
        'grep -F -- "$1" "$2" | tail -n 1',
        "frantss-context",
        USAGE_LINE[app],
        transcript,
      ]
    : null;

// Claude Code: what the last request sent (input and cache tokens). Codex: its last turn's total
// and the model's window.
export function contextUsage(app: string | null, line: string): ContextUsage | null {
  let entry: any;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (app === "claude-code") {
    const usage = entry?.message?.usage;
    if (!usage) return null;
    const tokens =
      (usage.input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0);
    return { tokens, window: null };
  }
  if (app === "codex") {
    const info = entry?.payload?.info;
    const tokens = info?.last_token_usage?.total_tokens;
    if (!Number.isFinite(tokens)) return null;
    return {
      tokens,
      window: Number.isFinite(info.model_context_window) ? info.model_context_window : null,
    };
  }
  return null;
}

// "84k", "1.2M"; under a thousand as is.
export function tokenCount(tokens: number) {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

// The share of the window used, 0 to 100, or null without a window.
export const usedPercent = ({ tokens, window }: ContextUsage) =>
  window ? Math.min(100, Math.round((tokens / window) * 100)) : null;
