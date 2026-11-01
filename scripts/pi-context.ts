type PiContext = {
  getContextUsage(): { tokens: number | null; contextWindow: number } | undefined;
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
    event: (typeof CONTEXT_EVENTS)[number] | "session_shutdown",
    handler: (event: unknown, ctx: PiContext) => Promise<void>,
  ): unknown;
  exec(command: string, args: string[], options: { timeout: number }): Promise<unknown>;
};

export default function piContext(pi: PiExtension) {
  const terminal = process.env.HC_TERMINAL_ID;
  if (!terminal) return;

  async function label(value: string) {
    await pi
      .exec("hc", ["label", terminal, `frantss.context=${value}`], { timeout: 1000 })
      .catch(() => {});
  }

  async function update(_event: unknown, ctx: PiContext) {
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
  pi.on("session_shutdown", async () => label(""));
}
