// Looks up the agents' pull requests and shares them for the rail's chips and the GitHub panel's
// Agents tab. The rail runs it because the rail always runs; a hidden panel's mod may not.
import {
  AGENT_PRS,
  AGENT_PR_ERRORS,
  agentPullRequests,
  loadLinkedPrs,
  type AgentPr,
  type GitHubExecutor,
  type LinkedPrs,
  type TrackedAgent,
} from "./agent-prs.ts";

// GitHub states change without a local sign, so they are looked up again this often.
export const PR_POLL_MS = 2 * 60000;

const linksKey = (agents: TrackedAgent[]) =>
  JSON.stringify(agents.map((agent) => [agent.address, agent.links]));

export class AgentPrTracker {
  gh: GitHubExecutor;
  read: (key: string) => unknown;
  write: (key: string, value: unknown) => void;
  key: string | null = null;
  polledAt = 0;
  busy = false;

  // `read` and `write` are Herdr's shared and setShared.
  constructor(
    gh: GitHubExecutor,
    read: (key: string) => unknown,
    write: (key: string, value: unknown) => void,
  ) {
    this.gh = gh;
    this.read = read;
    this.write = write;
  }

  // When the links changed or the last lookup is PR_POLL_MS old.
  due(agents: TrackedAgent[], now: number) {
    return !this.busy && (linksKey(agents) !== this.key || now - this.polledAt >= PR_POLL_MS);
  }

  // One query per repository; a repository that fails keeps its last results.
  async lookUp(agents: TrackedAgent[], now: number) {
    this.busy = true;
    this.key = linksKey(agents);
    this.polledAt = now;
    try {
      const byRepo = new Map<string, { numbers: Set<number>; branches: Set<string> }>();
      for (const link of agents.flatMap((agent) => agent.links)) {
        const wanted = byRepo.get(link.repo) ?? { numbers: new Set(), branches: new Set() };
        if (link.number !== undefined) wanted.numbers.add(link.number);
        else wanted.branches.add(link.branch);
        byRepo.set(link.repo, wanted);
      }
      const lookups = new Map<string, LinkedPrs>(),
        errors: Record<string, string> = {};
      for (const [repo, wanted] of byRepo) {
        try {
          lookups.set(
            repo,
            await loadLinkedPrs(this.gh, repo, [...wanted.numbers], [...wanted.branches]),
          );
        } catch (error) {
          errors[repo] = String((error as Error)?.message ?? error).slice(0, 300);
        }
      }
      const last = (this.read(AGENT_PRS) as Record<string, AgentPr[]> | null) ?? {};
      const result: Record<string, AgentPr[]> = {};
      for (const agent of agents) {
        const kept = (last[agent.address] ?? []).filter((pr) => !lookups.has(pr.repo));
        const prs = [...agentPullRequests(agent.links, lookups), ...kept];
        if (prs.length) result[agent.address] = prs;
      }
      this.save(AGENT_PRS, result);
      this.save(AGENT_PR_ERRORS, errors);
    } finally {
      this.busy = false;
    }
  }

  // A shared write re-renders every mod, so only a change is written.
  save(key: string, value: Record<string, unknown>) {
    if (JSON.stringify(this.read(key) ?? {}) !== JSON.stringify(value)) this.write(key, value);
  }
}
