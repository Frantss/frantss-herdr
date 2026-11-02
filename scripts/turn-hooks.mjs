import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export async function handleTurnHook(agent, payload, { env = process.env, engine } = {}) {
  try {
    const terminal = env.HC_TERMINAL_ID;
    if (!terminal || !["pi", "omp", "claude-code", "codex"].includes(agent)) return;
    if (!payload || typeof payload !== "object" || payload.agent_id) return;
    const { cwd, session_id: session, hook_event_name: event } = payload;
    if (typeof cwd !== "string" || !isAbsolute(cwd)) return;
    if (typeof session !== "string" || !session.trim()) return;

    const normalized = agent === "pi" || agent === "omp";
    const start = normalized ? event === "before_agent_start" : event === "UserPromptSubmit";
    let status;
    if (start) {
      if (typeof payload.prompt !== "string") return;
      if (normalized && payload.messageType !== "user") return;
    } else if ((normalized && event === "agent_settled") || (!normalized && event === "Stop")) {
      status =
        normalized && (payload.aborted === true || payload.outcome === "aborted")
          ? "interrupted"
          : normalized && payload.outcome === "error"
            ? "error"
            : "complete";
    } else if (
      (!normalized && event === "SessionEnd") ||
      (normalized && event === "session_shutdown") ||
      (agent === "codex" && event === "Interrupt")
    ) {
      status = "interrupted";
    } else if (agent === "claude-code" && event === "StopFailure") {
      status = "error";
    } else {
      return;
    }

    const snapshots = engine ?? (await import("./turn-snapshots.mjs"));
    const identity = { cwd, agent, session, terminal };
    if (start) {
      const request =
        agent === "claude-code"
          ? payload.prompt_id
          : agent === "codex"
            ? payload.turn_id
            : undefined;
      await snapshots.beginTurn({
        ...identity,
        title: payload.prompt,
        replaceActive: true,
        ...(typeof request === "string" && request.trim() ? { request } : {}),
      });
    } else {
      await snapshots.endTurn({
        ...identity,
        status,
        ...(event === "Stop" ? { continued: payload.stop_hook_active === true } : {}),
      });
    }
  } catch {}
}

async function main() {
  if (
    !process.env.HC_TERMINAL_ID ||
    !["pi", "omp", "claude-code", "codex"].includes(process.argv[2])
  )
    return;
  let timer = setTimeout(() => process.exit(0), 15_000);
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) return;
      chunks.push(chunk);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (["SessionEnd", "session_shutdown", "Interrupt"].includes(payload?.hook_event_name)) {
      clearTimeout(timer);
      timer = setTimeout(() => process.exit(0), 2500);
    }
    await handleTurnHook(process.argv[2], payload);
  } catch {
  } finally {
    clearTimeout(timer);
  }
}

try {
  if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main();
    process.exit(0);
  }
} catch {}
