// The agents the rail has seen, kept so it can list them after their tab closes. Herdr's core keeps
// a closed tab's terminals as "finished" with their history, but forgets which agent ran in them.
import type { Program } from "herdr";

export type AgentRecord = {
  address: string;
  app: string | null;
  program: Program;
  // The agent's latest telling terminal title ("Fix tab width"), else null.
  title: string | null;
  cwd?: string;
  // When the rail found its terminal finished.
  closed?: number;
};
export type LiveAgent = Pick<AgentRecord, "address" | "app" | "program" | "title">;
// A terminal as `hc ls --all --json` lists it.
export type CoreTerminal = { address: string; state: string; cwd?: string };

export const CLOSED_LIMIT = 20;

// Adds the agents it hasn't seen and keeps each one's latest program and telling title.
export function recordAgents(records: AgentRecord[], live: LiveAgent[]): AgentRecord[] {
  const byAddress = new Map(records.map((record) => [record.address, record]));
  for (const agent of live) {
    const known = byAddress.get(agent.address);
    byAddress.set(agent.address, {
      ...known,
      ...agent,
      title: agent.title ?? known?.title ?? null,
    });
  }
  return [...byAddress.values()];
}

// Drops the agents the core no longer knows, notes when each one finished, and keeps only the
// latest closed ones.
export function settleAgents(
  records: AgentRecord[],
  terminals: CoreTerminal[],
  now: number,
): AgentRecord[] {
  const byAddress = new Map(terminals.map((terminal) => [terminal.address, terminal]));
  const known = records.flatMap((record): AgentRecord[] => {
    const terminal = byAddress.get(record.address);
    if (!terminal) return [];
    const { closed, ...open } = record;
    const cwd = terminal.cwd ?? record.cwd;
    return [
      terminal.state === "finished" ? { ...open, cwd, closed: closed ?? now } : { ...open, cwd },
    ];
  });
  const kept = new Set(closedAgents(known).slice(0, CLOSED_LIMIT));
  return known.filter((record) => record.closed === undefined || kept.has(record));
}

// The closed agents, the latest first.
export const closedAgents = (records: AgentRecord[]) =>
  records
    .filter((record) => record.closed !== undefined)
    .sort((left, right) => right.closed - left.closed);

const RESUME: Record<string, string[]> = {
  pi: ["pi", "--resume"],
  "claude-code": ["claude", "--resume"],
  codex: ["codex", "--no-daemon", "resume"],
};
// The agent's own session picker, or null for an agent that has none.
export const resumeArgv = (app: string | null) => RESUME[app] ?? null;

// The whole history the core kept (it keeps about a thousand lines).
export const historyArgv = (address: string) => ["hc", "read", address, "--lines", "100000"];

// How long ago, in the largest whole unit: "now", "5m", "3h", "2d".
export function age(milliseconds: number) {
  const minutes = Math.floor(milliseconds / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}
