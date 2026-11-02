import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Message = { role: string; content?: unknown; stopReason?: string };
type OmpContext = {
  agent: { kind: "main" | "sub" };
  cwd: string;
  getContextUsage(): { tokens: number; contextWindow: number } | undefined;
  setInterval(callback: () => Promise<void>, milliseconds: number): unknown;
  clearTimer(timer: unknown): void;
  sessionManager: {
    getSessionId(): string;
    getBranch(): { type: string; message?: Message }[];
  };
};
type OmpEvent = {
  reason?: string;
  text?: string;
  prompt?: string;
  willContinue?: boolean;
  messages?: Message[];
};
type OmpAPI = {
  on(event: string, handler: (event: OmpEvent, ctx: OmpContext) => Promise<void>): unknown;
  getSessionName(): string | undefined;
  setSessionName(name: string): Promise<void>;
  exec(command: string, args: string[], options: { timeout: number }): Promise<unknown>;
};
type ActiveTurn = { cwd: string; session: string; prompt: string };

export default function ompHerdr(omp: OmpAPI) {
  const terminal = process.env.HC_TERMINAL_ID;
  if (!terminal) return;
  let active: ActiveTurn | undefined;
  let finishing: ActiveTurn | undefined;
  let snapshots = Promise.resolve();
  let labels = Promise.resolve();
  let lastLabel: string | undefined;
  let contextTimer: unknown;
  let shuttingDown = false;
  let captureChild: ReturnType<typeof execFile> | undefined;

  function label(value: string) {
    labels = labels.then(async () => {
      if (value === lastLabel || (shuttingDown && value !== "")) return;
      try {
        await omp.exec("hc", ["label", terminal, `frantss.context=${value}`], { timeout: 250 });
        lastLabel = value;
      } catch {}
    });
    return labels;
  }

  async function context(ctx: OmpContext) {
    if (shuttingDown) return;
    let value = "";
    try {
      const usage = ctx.getContextUsage();
      if (
        Number.isFinite(usage?.tokens) &&
        usage.tokens >= 0 &&
        Number.isFinite(usage?.contextWindow) &&
        usage.contextWindow > 0
      )
        value = JSON.stringify({ tokens: usage.tokens, window: usage.contextWindow });
    } catch {}
    await label(value);
  }

  async function nameSession(ctx: OmpContext, prompt?: string) {
    try {
      if (omp.getSessionName()) return;
      const first = ctx.sessionManager
        .getBranch()
        .find((entry) => entry.type === "message" && entry.message?.role === "user")?.message;
      const content = first?.content ?? prompt ?? "";
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join(" ")
            : "";
      const line = text.split(/\r?\n/).find((line) => line.trim()) ?? "";
      const name = Array.from(
        line
          .replace(/\s+/g, " ")
          .replace(/\p{Cc}/gu, "")
          .trim(),
      )
        .slice(0, 80)
        .join("");
      if (name) await omp.setSessionName(name);
    } catch {}
  }

  function snapshot(event: string, turn: ActiveTurn, outcome?: string) {
    snapshots = snapshots.then(async () => {
      if (shuttingDown && event !== "session_shutdown") return;
      try {
        const script = join(
          dirname(realpathSync(fileURLToPath(import.meta.url))),
          "turn-hooks.mjs",
        );
        await new Promise<void>((resolve) => {
          // OMP's process.execPath is its bundled executable, not a Node.js runner.
          const child = execFile(
            "node",
            [script, "omp"],
            {
              timeout: event === "session_shutdown" ? 1500 : 16_000,
              killSignal: "SIGKILL",
              maxBuffer: 16 * 1024,
              windowsHide: true,
            },
            () => {
              captureChild = undefined;
              resolve();
            },
          );
          captureChild = child;
          child.stdin?.on("error", () => {});
          child.stdin?.end(
            JSON.stringify({
              hook_event_name: event,
              cwd: turn.cwd,
              session_id: turn.session,
              messageType: "user",
              prompt: turn.prompt,
              outcome,
              aborted: outcome === "aborted",
            }),
          );
        });
      } catch {}
    });
    return snapshots;
  }

  async function interrupt() {
    const turn = active ?? finishing;
    active = undefined;
    finishing = undefined;
    if (turn) await snapshot("session_shutdown", turn, "aborted");
  }

  function on(eventName: string, handler: (event: OmpEvent, ctx: OmpContext) => Promise<void>) {
    omp.on(eventName, async (event, ctx) => {
      if (ctx.agent.kind !== "main" || (shuttingDown && eventName !== "session_shutdown")) return;
      await handler(event, ctx);
    });
  }

  for (const event of ["session_start", "session_switch", "session_branch", "session_tree"]) {
    on(event, async (_event, ctx) => {
      await interrupt();
      await nameSession(ctx);
      await context(ctx);
      if (event === "session_start") {
        if (contextTimer !== undefined) ctx.clearTimer(contextTimer);
        // OMP has no extension model-change event; the timer catches idle switches.
        contextTimer = ctx.setInterval(() => context(ctx), 5000);
      }
    });
  }
  on("input", async (event, ctx) => {
    if (!event.text?.trim().startsWith("/")) await nameSession(ctx, event.text);
  });
  on("before_agent_start", async (event, ctx) => {
    if (event.reason !== "prompt") return;
    await snapshots;
    if (shuttingDown) return;
    await nameSession(ctx, event.prompt);
    if (active) return;
    try {
      active = {
        cwd: ctx.cwd,
        session: ctx.sessionManager.getSessionId(),
        prompt: event.prompt ?? "",
      };
      await snapshot("before_agent_start", active);
    } catch {}
  });
  on("agent_end", async (event, ctx) => {
    if (!event.willContinue) {
      const turn = active;
      active = undefined;
      const last = event.messages
        ?.slice()
        .reverse()
        .find((message) => message.role === "assistant");
      const outcome =
        last?.stopReason === "aborted"
          ? "aborted"
          : last?.stopReason === "error"
            ? "error"
            : "completed";
      if (turn) {
        finishing = turn;
        await snapshot("agent_settled", turn, outcome);
        if (finishing === turn) finishing = undefined;
      }
    }
    await context(ctx);
  });
  for (const event of ["agent_start", "turn_end", "session_compact", "auto_compaction_end"]) {
    on(event, async (_event, ctx) => context(ctx));
  }
  on("session_shutdown", async (_event, ctx) => {
    shuttingDown = true;
    captureChild?.kill("SIGKILL");
    if (contextTimer !== undefined) ctx.clearTimer(contextTimer);
    await Promise.all([interrupt(), label("")]);
  });
}
