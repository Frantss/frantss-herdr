// The agents each machine has ("" for this one), kept in shared state (persisted) so a launcher opens
// at once with last time's list while it asks again. Mods link this file as ./known-agents.ts.
import { knownAgents, setShared, shared } from "herdr";

export type KnownAgent = Awaited<ReturnType<typeof knownAgents>>[number];

const AGENTS = "frantss.agents";
const byMachine = () => (shared(AGENTS) as Record<string, KnownAgent[]> | null) ?? {};

export function cachedAgents(machine: string): KnownAgent[] {
  return byMachine()[machine] ?? [];
}

// Asks the machine again and keeps its answer next to the other machines' lists.
export async function refreshAgents(machine: string): Promise<KnownAgent[]> {
  const agents = await knownAgents({ on: machine || null });
  const known = byMachine();
  if (JSON.stringify(agents) !== JSON.stringify(known[machine]))
    setShared(AGENTS, { ...known, [machine]: agents });
  return agents;
}
