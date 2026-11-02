import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type TurnContext = {
  cwd: string;
  sessionManager: { getSessionId(): string };
};

type TurnEvent = {
  messageType?: string;
  prompt?: string;
  aborted?: boolean;
  outcome?: "completed" | "aborted" | "error";
};

type PiTurnsAPI = {
  on(
    event: "before_agent_start" | "agent_before_settle" | "agent_settled" | "session_shutdown",
    handler: (event: TurnEvent, ctx: TurnContext) => Promise<void>,
  ): unknown;
};

type ActiveTurn = { cwd: string; session: string; prompt: string; outcome?: string };

export default function piTurns(pi: PiTurnsAPI) {
  if (!process.env.HC_TERMINAL_ID) return;
  let active: ActiveTurn | undefined;

  async function snapshot(event: string, turn: ActiveTurn, aborted = false) {
    try {
      const script = join(dirname(realpathSync(fileURLToPath(import.meta.url))), "turn-hooks.mjs");
      const payload = {
        hook_event_name: event,
        cwd: turn.cwd,
        session_id: turn.session,
        messageType: "user",
        prompt: turn.prompt,
        aborted,
        outcome: turn.outcome,
      };
      await new Promise<void>((resolve) => {
        const child = execFile(
          process.execPath,
          [script, "pi"],
          {
            timeout: event === "session_shutdown" ? 3000 : 16_000,
            killSignal: "SIGKILL",
            maxBuffer: 16 * 1024,
            windowsHide: true,
          },
          () => resolve(),
        );
        child.stdin?.on("error", () => {});
        child.stdin?.end(JSON.stringify(payload));
      });
    } catch {}
  }

  pi.on("before_agent_start", async (event, ctx) => {
    if (event.messageType !== "user" || active) return;
    try {
      active = {
        cwd: ctx.cwd,
        session: ctx.sessionManager.getSessionId(),
        prompt: event.prompt ?? "",
      };
      await snapshot("before_agent_start", active);
    } catch {}
  });
  pi.on("agent_before_settle", async (event) => {
    if (active) active.outcome = event.outcome;
  });
  pi.on("agent_settled", async (event) => {
    const turn = active;
    active = undefined;
    if (turn) await snapshot("agent_settled", turn, event.aborted);
  });
  pi.on("session_shutdown", async () => {
    const turn = active;
    active = undefined;
    if (turn) await snapshot("session_shutdown", turn, true);
  });
}
