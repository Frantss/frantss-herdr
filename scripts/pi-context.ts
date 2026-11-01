type PiContext = {
  getContextUsage(): { tokens: number | null; contextWindow: number } | undefined;
  sessionManager?: {
    getBranch(): { type: string; message?: { role: string; content: unknown } }[];
  };
};

const CONTEXT_EVENTS = [
  "session_start",
  "session_compact",
  "session_tree",
  "model_select",
  "agent_start",
  "turn_end",
  "agent_end",
] as const;

type PiExtension = {
  on(
    event: (typeof CONTEXT_EVENTS)[number] | "session_shutdown" | "before_agent_start",
    handler: (event: { messageType?: string; prompt?: string }, ctx: PiContext) => Promise<void>,
  ): unknown;
  getSessionName(): string | undefined;
  setSessionName(name: string): void;
  exec(command: string, args: string[], options: { timeout: number }): Promise<unknown>;
};

export default function piContext(pi: PiExtension) {
  const terminal = process.env.HC_TERMINAL_ID;
  if (!terminal) return;

  function nameSession(ctx: PiContext, prompt?: string) {
    if (pi.getSessionName()) return;
    const first = ctx.sessionManager
      ?.getBranch()
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
    if (name) pi.setSessionName(name);
  }

  async function label(value: string) {
    await pi
      .exec("hc", ["label", terminal, `frantss.context=${value}`], { timeout: 1000 })
      .catch(() => {});
  }

  async function update(_event: unknown, ctx: PiContext) {
    nameSession(ctx);
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
    } catch {
      // An unavailable Pi API must not interrupt the agent or leave old context visible.
    }
    await label(value);
  }

  for (const event of CONTEXT_EVENTS) pi.on(event, update);
  pi.on("before_agent_start", async (event, ctx) => {
    if (event.messageType === "user") nameSession(ctx, event.prompt);
  });
  pi.on("session_shutdown", async () => label(""));
}
