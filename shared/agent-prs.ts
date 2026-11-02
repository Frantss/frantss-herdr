// The pull requests each agent created or pushed a branch for. scripts/pr-hooks.mjs labels the
// agent's terminal; the rail keeps those labels in its closed-agent records, looks the pull requests
// up (agent-pr-tracker.ts) and shares their states, which the GitHub panel's Agents tab shows.
// Mods can't import outside their own folder, so each mod that uses them links this file as
// ./agent-prs.ts.

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
// Each repository's last lookup error, which the GitHub panel shows.
export const AGENT_PR_ERRORS = "frantss.agentPrErrors";
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

// An agent with links: live, or closed and kept in the rail's records.
export interface TrackedAgent {
  address: string;
  name: string;
  status: string | null;
  closed: number | null;
  cwd: string | null;
  app: string | null;
  links: PrLink[];
}
type TerminalLike = {
  address: string;
  state: string;
  cwd?: string;
  labels?: Record<string, string>;
  program?: { name?: string };
};
type AgentLike = {
  address: string;
  title?: string;
  status?: string;
  app?: string | null;
  program?: { name?: string };
};
type RecordLike = {
  address: string;
  title: string | null;
  program?: { name?: string };
  app: string | null;
  cwd?: string;
  closed?: number;
  prs?: PrLink[];
};

// Local agents with links: the live ones from their terminals' labels, the closed ones from the
// rail's records (`terminals()`, `agents()` and the CLOSED_AGENTS records).
export function trackedAgents(
  terminals: TerminalLike[],
  agents: AgentLike[],
  records: RecordLike[],
): TrackedAgent[] {
  const byAddress = new Map(agents.map((a) => [a.address, a]));
  const tracked: TrackedAgent[] = terminals.flatMap((t) => {
    const links = prLinks(t.labels),
      agent = byAddress.get(t.address);
    if (t.state !== "live" || t.address.includes("/") || !links.length) return [];
    return [
      {
        address: t.address,
        name: agent?.title || agent?.program?.name || t.program?.name || t.address,
        status: agent?.status ?? null,
        closed: null,
        cwd: t.cwd ?? null,
        app: agent?.app ?? null,
        links,
      },
    ];
  });
  const live = new Set(tracked.map((a) => a.address));
  for (const record of records)
    if (record.closed !== undefined && record.prs?.length && !live.has(record.address))
      tracked.push({
        address: record.address,
        name: record.title ?? record.program?.name ?? record.address,
        status: null,
        closed: record.closed,
        cwd: record.cwd ?? null,
        app: record.app,
        links: record.prs,
      });
  return tracked;
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

// Runs `gh` with these arguments, as Herdr's exec does.
export type GitHubExecutor = (
  args: string[],
) => Promise<{ code: number; stdout?: string; stderr?: string }>;
// Check rollup states.
const FAILED = new Set(["FAILURE", "ERROR"]),
  PENDING = new Set(["PENDING", "EXPECTED"]);

interface LinkedNode {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  headRefName: string;
  isDraft: boolean;
  reviewDecision: string | null;
  mergeable?: string;
  commits: { nodes: { commit: { statusCheckRollup?: { state: string } | null } }[] };
  reviewThreads: { nodes: { isResolved: boolean; isOutdated: boolean }[] };
}

// A pull request's most urgent state, in the inbox's terms.
export function prState(node: LinkedNode): PrState {
  if (node.state === "MERGED") return "merged";
  if (node.state === "CLOSED") return "closed";
  const checks = node.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null;
  if (FAILED.has(checks)) return "failing";
  if (node.reviewDecision === "CHANGES_REQUESTED") return "changes";
  if (node.mergeable === "CONFLICTING") return "conflicts";
  if (node.reviewThreads.nodes.some((t) => !t.isResolved && !t.isOutdated)) return "comments";
  if (PENDING.has(checks)) return "pending";
  if (!node.isDraft && node.reviewDecision === "APPROVED" && checks === "SUCCESS") return "ready";
  return "open";
}

const LINKED_FIELDS = `fragment F on PullRequest {
  number title url state headRefName isDraft reviewDecision mergeable
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  reviewThreads(first: 100) { nodes { isResolved isOutdated } }
}`;

export type LinkedPr = Omit<AgentPr, "source">;
export interface LinkedPrs {
  byNumber: Map<number, LinkedPr>;
  byBranch: Map<string, LinkedPr[]>;
}

// One query for a repository's linked pull requests: by number, and the open or merged ones whose
// head is a linked branch other than the default branch.
export async function loadLinkedPrs(
  gh: GitHubExecutor,
  repo: string,
  numbers: number[],
  branches: string[],
): Promise<LinkedPrs> {
  const [owner, name] = repo.split("/");
  const fields = [
    ...numbers.map((n) => `n${n}: pullRequest(number: ${n}) { ...F }`),
    ...branches.map(
      (_, i) =>
        `b${i}: pullRequests(headRefName: $b${i}, first: 3, states: [OPEN, MERGED], orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ...F } }`,
    ),
  ];
  const variables = branches.map((_, i) => `, $b${i}: String!`).join("");
  const query = `query($owner: String!, $name: String!${variables}) {
  repository(owner: $owner, name: $name) { defaultBranchRef { name } ${fields.join("\n")} }
}
${LINKED_FIELDS}`;
  const result = await gh([
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    ...branches.flatMap((branch, i) => ["-f", `b${i}=${branch}`]),
  ]);
  // A missing pull request fails only its own field: gh exits 1 but still prints the rest.
  let repository: Record<string, unknown> | null = null;
  try {
    repository = JSON.parse(result.stdout ?? "").data?.repository ?? null;
  } catch {
    /* Reported below. */
  }
  if (!repository)
    throw new Error(result.stderr?.trim() || `Couldn't look up pull requests in ${repo}.`);
  const linked = (node: LinkedNode): LinkedPr => ({
    repo,
    number: node.number,
    title: node.title,
    url: node.url,
    branch: node.headRefName,
    state: prState(node),
  });
  const base = (repository.defaultBranchRef as { name?: string } | null)?.name;
  const byNumber = new Map<number, LinkedPr>();
  for (const n of numbers) {
    const node = repository[`n${n}`] as LinkedNode | null;
    if (node) byNumber.set(n, linked(node));
  }
  const byBranch = new Map<string, LinkedPr[]>();
  branches.forEach((branch, i) => {
    const nodes = (repository[`b${i}`] as { nodes: LinkedNode[] } | null)?.nodes ?? [];
    if (branch !== base) byBranch.set(branch, nodes.map(linked));
  });
  return { byNumber, byBranch };
}

// An agent's pull requests from its links, each once, most urgent first. A pull request it created
// counts as created even when it also pushed the branch.
export function agentPullRequests(links: PrLink[], lookups: Map<string, LinkedPrs>): AgentPr[] {
  const found = new Map<string, AgentPr>();
  const add = (pr: LinkedPr | undefined, source: PrLink["source"]) => {
    const key = `${pr?.repo}#${pr?.number}`;
    if (pr && (!found.has(key) || found.get(key).source === "pushed"))
      found.set(key, { ...pr, source });
  };
  for (const link of links) {
    const lookup = lookups.get(link.repo);
    if (link.number !== undefined) add(lookup?.byNumber.get(link.number), link.source);
    else for (const pr of lookup?.byBranch.get(link.branch) ?? []) add(pr, link.source);
  }
  return [...found.values()].sort(
    (a, b) => URGENCY.indexOf(a.state) - URGENCY.indexOf(b.state) || b.number - a.number,
  );
}
