export type Worktree = { path: string; branch: string | null; head: string; main: boolean };
export type WorktreeTarget = { key: string; cwd: string; machine: string | null };

type WorktreeState = { worktrees: Worktree[] | undefined; error: boolean; loading: boolean };
type Entry = { state: WorktreeState; retryAt: number; failures: number; inflight: boolean };

export function parseWorktrees(output: string): Worktree[] {
  const worktrees: Worktree[] = [];
  for (const [index, record] of output.split("\0\0").entries()) {
    let path: string | undefined;
    let head: string | undefined;
    let branch: string | null = null;
    let excluded = false;
    for (const field of record.split("\0")) {
      if (field.startsWith("worktree ")) path = field.slice(9);
      else if (field.startsWith("HEAD ")) head = field.slice(5);
      else if (field.startsWith("branch ")) branch = field.slice(7).replace(/^refs\/heads\//, "");
      else if (field === "bare" || field === "prunable" || field.startsWith("prunable "))
        excluded = true;
    }
    if (path && head && !excluded) worktrees.push({ path, branch, head, main: index === 0 });
  }
  return worktrees.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export class WorktreeDiscovery {
  private entries = new Map<string, Entry>();
  private active = 0;
  private read: (target: WorktreeTarget) => Promise<string>;
  private now: () => number;

  constructor(read: (target: WorktreeTarget) => Promise<string>, now: () => number = Date.now) {
    this.read = read;
    this.now = now;
  }

  state(key: string): WorktreeState | undefined {
    return this.entries.get(key)?.state;
  }

  async refresh(targets: WorktreeTarget[], changed: () => void, forceKey?: string): Promise<void> {
    const seen = new Set<string>();
    const queries: Promise<void>[] = [];
    const candidates = targets.filter((target) => {
      if (seen.has(target.key)) return false;
      seen.add(target.key);
      return true;
    });
    candidates.sort((a, b) => {
      const forceOrder = Number(b.key === forceKey) - Number(a.key === forceKey);
      if (forceOrder) return forceOrder;
      const first = this.entries.get(a.key)?.retryAt ?? -Infinity;
      const second = this.entries.get(b.key)?.retryAt ?? -Infinity;
      return first === second ? 0 : first < second ? -1 : 1;
    });
    for (const target of candidates) {
      let entry = this.entries.get(target.key);
      if (
        this.active >= 2 ||
        entry?.inflight ||
        (entry && target.key !== forceKey && this.now() < entry.retryAt)
      )
        continue;
      if (!entry) {
        entry = {
          state: { worktrees: undefined, error: false, loading: false },
          retryAt: 0,
          failures: 0,
          inflight: false,
        };
        this.entries.set(target.key, entry);
      }
      entry.inflight = true;
      this.active++;
      queries.push(this.query(target, entry, changed));
    }
    await Promise.all(queries);
  }

  private async query(target: WorktreeTarget, entry: Entry, changed: () => void): Promise<void> {
    if (entry.state.worktrees === undefined) {
      entry.state = { ...entry.state, loading: true };
      changed();
    }
    let next: WorktreeState;
    try {
      const worktrees = parseWorktrees(await this.read(target));
      next = { worktrees, error: false, loading: false };
      entry.failures = 0;
      entry.retryAt = this.now() + 10000;
    } catch {
      next = { ...entry.state, error: true, loading: false };
      entry.failures++;
      entry.retryAt = this.now() + (entry.failures === 1 ? 30000 : 60000);
    }
    entry.inflight = false;
    this.active--;
    if (
      entry.state.error !== next.error ||
      entry.state.loading !== next.loading ||
      JSON.stringify(entry.state.worktrees) !== JSON.stringify(next.worktrees)
    ) {
      entry.state = next;
      changed();
    }
  }
}
