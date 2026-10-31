export const SUBSCRIPTION_REFRESH_MS = 5 * 60 * 1000;
export const SUBSCRIPTIONS = ["claude", "codex"] as const;
export type Subscription = (typeof SUBSCRIPTIONS)[number];
export type UsageWindow = { label: string; usedPercent: number; resetsAt: number };
export type UsageSnapshot = { windows: UsageWindow[]; updatedAt?: number; error?: string };

function readSnapshot(text: string): { windows: UsageWindow[]; error?: string } {
  const result = JSON.parse(text);
  if (typeof result.error === "string" && result.error) return { windows: [], error: result.error };
  if (!Array.isArray(result.windows) || !result.windows.length) throw new Error("Missing windows");
  for (const window of result.windows)
    if (
      !window ||
      typeof window.label !== "string" ||
      !window.label ||
      !Number.isFinite(window.usedPercent) ||
      window.usedPercent < 0 ||
      window.usedPercent > 100 ||
      !Number.isFinite(window.resetsAt) ||
      window.resetsAt <= 0
    )
      throw new Error("Invalid window");
  return { windows: result.windows };
}

export class SubscriptionUsage {
  data: Record<Subscription, UsageSnapshot> = { claude: { windows: [] }, codex: { windows: [] } };
  refreshing = false;

  async refresh(
    read: (provider: Subscription) => Promise<string>,
    now = () => Date.now(),
    changed = () => {},
  ) {
    if (this.refreshing) return;
    this.refreshing = true;
    changed();
    try {
      await Promise.all(
        SUBSCRIPTIONS.map(async (provider) => {
          try {
            const result = readSnapshot(await read(provider));
            this.data[provider] = result.error
              ? { ...this.data[provider], error: result.error }
              : { windows: result.windows, updatedAt: now() };
          } catch {
            this.data[provider] = {
              ...this.data[provider],
              error: "Could not read usage. Refresh to retry.",
            };
          }
          changed();
        }),
      );
    } finally {
      this.refreshing = false;
      changed();
    }
  }
}

export function usageWindow(window: UsageWindow, snapshot: UsageSnapshot, now: number) {
  const expired = window.resetsAt * 1000 <= now;
  return {
    percent: expired ? "—" : `${Math.round(window.usedPercent)}%`,
    stale:
      Boolean(snapshot.error) ||
      now - (snapshot.updatedAt ?? 0) > 2 * SUBSCRIPTION_REFRESH_MS ||
      expired,
    expired,
  };
}

export function resetTime(resetsAt: number, now: number) {
  const minutes = Math.ceil((resetsAt * 1000 - now) / 60000);
  if (minutes <= 0) return "Reset passed. Refresh usage.";
  if (minutes < 60) return `Resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Resets in ${hours}h ${minutes % 60}m`;
  return `Resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}
