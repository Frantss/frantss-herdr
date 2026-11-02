// When each agent's status last changed, by address. Done and idle count as one, as in Herdr's agents
// list: looking at a done agent makes it idle, and looking isn't the agent doing anything.
export type StatusStamps = Record<string, { status: string; at: number }>;

const FORGET_AFTER_MS = 30 * 86_400_000;

// The stamps with every changed agent stamped `now`, or null when none changed. Agents no longer
// listed are dropped only once old: the list is empty for a moment after a start.
export function stampStatuses(
  stamps: StatusStamps,
  agents: { address: string; status: string }[],
  now: number,
): StatusStamps | null {
  const next = { ...stamps };
  let changed = false;
  for (const agent of agents) {
    const status = agent.status === "done" ? "idle" : agent.status;
    if (next[agent.address]?.status === status) continue;
    next[agent.address] = { status, at: now };
    changed = true;
  }
  if (!changed) return null;
  const listed = new Set(agents.map((agent) => agent.address));
  for (const [address, stamp] of Object.entries(next))
    if (!listed.has(address) && now - stamp.at > FORGET_AFTER_MS) delete next[address];
  return next;
}
