import { hc, notify } from "herdr";
import { hcOrToast } from "./agent-hc.ts";

export async function markUnread(address: string) {
  const failure = "Could not mark the agent unread";
  try {
    // Read at action time: AgentInfo.seq is recency, not the core turn counter.
    const result = await hc(["get", address]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || "Could not read the terminal");
    const terminal = JSON.parse(result.stdout);
    if (
      terminal?.address !== address ||
      terminal.state !== "live" ||
      !["idle", "done"].includes(terminal.status?.state) ||
      !Number.isSafeInteger(terminal.turn) ||
      terminal.turn < 0
    )
      throw new Error("The terminal is no longer an idle agent or its turn is unavailable.");
    if (terminal.turn === 0) return;
    await hcOrToast(["label", address, `herdr.seen=${terminal.turn - 1}`], failure);
  } catch (error) {
    notify({ title: failure, body: String(error), level: "error" });
  }
}
