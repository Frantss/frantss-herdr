import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { SubscriptionUsage, peakWindow, resetIn, usageWindow } from "./subscriptions.ts";

const payload = (percent = 42) =>
  JSON.stringify({ windows: [{ label: "5h", usedPercent: percent, resetsAt: 2000 }] });

test("refresh reads both subscriptions, suppresses overlaps and preserves each last success", async () => {
  const usage = new SubscriptionUsage();
  let finish: (value: string) => void;
  const pending = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const calls: string[] = [];
  const refresh = usage.refresh(
    async (provider) => {
      calls.push(provider);
      return provider === "claude" ? pending : payload(75);
    },
    () => 1000000,
  );
  await usage.refresh(async () => assert.fail("Overlapping request"));
  assert.equal(usage.refreshing, true);
  finish(payload());
  await refresh;
  assert.deepEqual(calls, ["claude", "codex"]);
  assert.equal(usage.data.claude.updatedAt, 1000000);
  assert.equal(usage.data.codex.windows[0].usedPercent, 75);

  await usage.refresh(
    async (provider) => {
      if (provider === "claude")
        return JSON.stringify({ windows: [], error: "Sign in to Claude Code" });
      return payload(80);
    },
    () => 1100000,
  );
  assert.equal(usage.data.claude.error, "Sign in to Claude Code");
  assert.equal(usage.data.claude.windows[0].usedPercent, 42);
  assert.equal(usage.data.claude.updatedAt, 1000000);
  assert.equal(usage.data.codex.windows[0].usedPercent, 80);
  assert.equal(usage.refreshing, false);
});

test("malformed, missing and failed reads never become zero usage", async () => {
  for (const response of [
    "invalid",
    "{}",
    '{"windows":[]}',
    payload(-1),
    payload(101),
    '{"windows":[{"label":"5h","usedPercent":null,"resetsAt":2000}]}',
    '{"windows":[{"label":"5h","usedPercent":1,"resetsAt":"2000"}]}',
  ]) {
    const usage = new SubscriptionUsage();
    await usage.refresh(async () => response);
    assert.equal(usage.data.claude.windows.length, 0);
    assert.ok(usage.data.claude.error);
  }
  const usage = new SubscriptionUsage();
  await usage.refresh(async () => {
    throw new Error("private provider response");
  });
  assert.equal(usage.data.codex.error, "Could not read usage. Refresh to retry.");
});

test("expired windows hide their old percentage and stale reads are marked", () => {
  const snapshot = { windows: [], updatedAt: 1000000 };
  const window = { label: "5h", usedPercent: 42, resetsAt: 2000 };
  assert.deepEqual(usageWindow(window, snapshot, 1100000), {
    percent: "42%",
    stale: false,
    expired: false,
  });
  assert.equal(usageWindow(window, snapshot, 1700000).stale, true);
  assert.equal(usageWindow(window, { ...snapshot, error: "Offline" }, 1100000).stale, true);
  assert.equal(usageWindow(window, snapshot, 2000000).percent, "—");
  assert.equal(resetIn(2000, 1100000), "15m");
  assert.equal(resetIn(2000 + 7800, 1100000), "2h 25m");
  assert.equal(resetIn(2000 + 97200, 1100000), "1d 3h");
  assert.equal(resetIn(2000, 2000000), null);
});

test("the peak window is the most used window that has not reset", () => {
  const snapshot = {
    windows: [
      { label: "5h", usedPercent: 40, resetsAt: 2000 },
      { label: "7d", usedPercent: 95, resetsAt: 1000 },
      { label: "30d", usedPercent: 60, resetsAt: 3000 },
    ],
    updatedAt: 900000,
  };
  assert.equal(peakWindow(snapshot, 1100000)?.label, "30d");
  assert.equal(peakWindow(snapshot, 3000000), null);
  assert.equal(peakWindow({ windows: [] }, 1100000), null);
});
