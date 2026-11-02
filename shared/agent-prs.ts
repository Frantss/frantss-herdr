// The pull requests each agent created or pushed a branch for. scripts/pr-hooks.mjs labels the
// agent's terminal; the rail keeps those labels in its closed-agent records, and the GitHub mod looks
// the pull requests up and shares their states. Mods can't import outside their own folder, so each
// mod that shows agents' pull requests links this file as ./agent-prs.ts.

// What a label says: a pull request the agent created, or a branch it pushed.
export type PrLink = {
  repo: string;
  number?: number;
  branch?: string;
  source: "created" | "pushed" | "panel";
};
export type PrState =
  | "failing"
  | "changes"
  | "conflicts"
  | "comments"
  | "pending"
  | "ready"
  | "open"
  | "merged"
  | "closed";
export type AgentPr = {
  repo: string;
  number: number;
  title: string;
  url: string;
  branch: string;
  source: PrLink["source"];
  state: PrState;
};

// The agents' pull requests by terminal address, which the GitHub mod shares.
export const AGENT_PRS = "frantss.agentPrs";
// `{ address, at }`: the agent whose pull requests the rail asked the GitHub panel to show.
export const SHOW_AGENT_PRS = "frantss.showAgentPrs";
// The rail's agent records; their `prs` keep a closed agent's links.
export const CLOSED_AGENTS = "frantss.closedAgents";

const CREATED = "frantss.pr.",
  PUSHED = "frantss.branch.",
  // The GitHub panel's label on the agents it starts.
  PANEL = "herdr.pr";

// The links in a terminal's labels: `frantss.pr.owner/repo#12`, `frantss.branch.owner/repo:feat`
// and `herdr.pr=owner/repo#12`.
export function prLinks(labels: Record<string, string> | undefined): PrLink[] {
  const links: PrLink[] = [];
  const pr = (text: string, source: PrLink["source"]) => {
    const match = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(text);
    if (match) links.push({ repo: match[1], number: Number(match[2]), source });
  };
  for (const [key, value] of Object.entries(labels ?? {})) {
    if (key.startsWith(CREATED)) pr(key.slice(CREATED.length), "created");
    else if (key === PANEL) pr(value, "panel");
    else if (key.startsWith(PUSHED)) {
      const match = /^([\w.-]+\/[\w.-]+):(.+)$/.exec(key.slice(PUSHED.length));
      if (match) links.push({ repo: match[1], branch: match[2], source: "pushed" });
    }
  }
  return links;
}

// Most urgent first.
export const URGENCY: PrState[] = [
  "failing",
  "changes",
  "conflicts",
  "comments",
  "pending",
  "ready",
  "open",
  "merged",
  "closed",
];
export const isOpen = (pr: AgentPr) => pr.state !== "merged" && pr.state !== "closed";
export const mostUrgentPr = (prs: AgentPr[]): PrState | null =>
  URGENCY.find((state) => prs.some((pr) => pr.state === state)) ?? null;

export const PR_STATES: Record<PrState, { label: string; color: string }> = {
  failing: { label: "Checks failed", color: "blocked" },
  changes: { label: "Changes requested", color: "blocked" },
  conflicts: { label: "Conflicts", color: "blocked" },
  comments: { label: "Open comments", color: "done" },
  pending: { label: "Checks running", color: "idle" },
  ready: { label: "Ready to merge", color: "working" },
  open: { label: "Open", color: "muted" },
  merged: { label: "Merged", color: "accent" },
  closed: { label: "Closed", color: "dim" },
};
