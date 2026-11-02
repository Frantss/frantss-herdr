import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { parseWorktrees, WorktreeDiscovery, type WorktreeTarget } from "./worktrees.ts";

const target = (cwd: string, machine: string | null = null): WorktreeTarget => ({
  key: JSON.stringify([machine, cwd]),
  cwd,
  machine,
});
const record = (path: string, head = "abc", branch = "main") =>
  `worktree ${path}\0HEAD ${head}\0branch refs/heads/${branch}\0\0`;
const deferred = () => {
  let resolve: (value: string) => void;
  let reject: (reason: Error) => void;
  const promise = new Promise<string>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return {
    promise,
    resolve: (value: string) => resolve(value),
    reject: () => reject(new Error("Offline")),
  };
};

function harness() {
  let time = 0;
  const calls: { target: WorktreeTarget; result: ReturnType<typeof deferred> }[] = [];
  const notifications: unknown[] = [];
  const discovery = new WorktreeDiscovery(
    (item) => {
      const result = deferred();
      calls.push({ target: item, result });
      return result.promise;
    },
    () => time,
  );
  const changed = () => notifications.push(calls.map(({ target }) => discovery.state(target.key)));
  return { discovery, calls, notifications, changed, at: (value: number) => (time = value) };
}

test("discovery is compatible with strip-only TypeScript loading", async () => {
  const source = await readFile(new URL("worktrees.ts", import.meta.url), "utf8");
  assert.doesNotThrow(() => stripTypeScriptTypes(source));
});

test("parses NUL records, filters bare/prunable, keeps locked and detached unusual paths in path order", () => {
  const unusual = '/a space\twith\nnewlines/"quote"\\slash';
  const output = [
    record("/z", "last", "feature/nested"),
    "worktree /bare\0bare\0\0",
    "worktree /gone\0HEAD old\0detached\0prunable gitdir file points to non-existent location\0\0",
    "worktree /pruned\0HEAD old\0prunable\0\0",
    `worktree ${unusual}\0HEAD detached-head\0detached\0locked reason\0\0`,
    "worktree /locked\0HEAD locked-head\0branch refs/heads/topic\0locked\0\0",
    "worktree /incomplete\0\0",
  ].join("");
  assert.deepEqual(parseWorktrees(output), [
    { path: unusual, branch: null, head: "detached-head", main: false },
    { path: "/locked", branch: "topic", head: "locked-head", main: false },
    { path: "/z", branch: "feature/nested", head: "last", main: true },
  ]);
  assert.deepEqual(parseWorktrees(""), []);
  assert.deepEqual(parseWorktrees("worktree /last\0HEAD hash\0detached\0"), [
    { path: "/last", branch: null, head: "hash", main: true },
  ]);
});

test("an excluded raw first record does not make a linked checkout main", () => {
  for (const first of ["worktree /bare\0bare\0\0", "worktree /gone\0HEAD old\0prunable\0\0"]) {
    assert.deepEqual(parseWorktrees(first + record("/linked")), [
      { path: "/linked", branch: "main", head: "abc", main: false },
    ]);
  }
});

test("only supplied expanded targets are read, deduplicated by key, and cached across collapse", async () => {
  const h = harness();
  const a = target("/a"),
    b = target("/b");
  assert.equal(h.discovery.state(a.key), undefined);
  await h.discovery.refresh([], h.changed, a.key);
  assert.equal(h.calls.length, 0);
  const pending = h.discovery.refresh([a, { ...a }, a], h.changed);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.discovery.state(a.key), { worktrees: undefined, error: false, loading: true });
  assert.equal(h.discovery.state(b.key), undefined);
  assert.equal(h.notifications.length, 1);
  h.calls[0].result.resolve(record("/a"));
  await pending;
  assert.deepEqual(h.discovery.state(a.key), {
    worktrees: [{ path: "/a", branch: "main", head: "abc", main: true }],
    error: false,
    loading: false,
  });
  assert.equal(h.notifications.length, 2);
  h.at(50000);
  await h.discovery.refresh([], h.changed);
  assert.equal(h.calls.length, 1);
  assert.equal(h.discovery.state(a.key)?.worktrees?.length, 1);
  const expanded = h.discovery.refresh([a], h.changed);
  h.calls[1].result.resolve(record("/a"));
  await expanded;
  assert.equal(h.notifications.length, 2);
});

test("two global slots and one inflight per key apply across overlapping refresh calls, without a queue", async () => {
  const h = harness();
  const a = target("/a"),
    b = target("/b"),
    c = target("/c"),
    d = target("/d");
  const first = h.discovery.refresh([a], h.changed);
  const second = h.discovery.refresh([a, b, c], h.changed, a.key);
  await h.discovery.refresh([c, d], h.changed, d.key);
  assert.deepEqual(
    h.calls.map(({ target }) => target.key),
    [a.key, b.key],
  );
  assert.equal(h.discovery.state(c.key), undefined);
  assert.equal(h.discovery.state(d.key), undefined);
  h.calls[0].result.resolve(record("/a"));
  await first;
  assert.equal(h.calls.length, 2);
  const third = h.discovery.refresh([a, b, c, d], h.changed, b.key);
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[2].target.key, c.key);
  h.calls[1].result.resolve(record("/b"));
  await second;
  assert.equal(h.calls.length, 3);
  h.calls[2].result.resolve(record("/c"));
  await third;
  assert.equal(h.calls.length, 3);
  assert.equal(h.discovery.state(d.key), undefined);
  const fourth = h.discovery.refresh([d], h.changed);
  h.calls[3].result.resolve(record("/d"));
  await fourth;
});

test("unchanged target order makes progress at exact TTL intervals, with unqueried and oldest due first", async () => {
  const h = harness();
  const targets = ["/a", "/b", "/c", "/d", "/e"].map((cwd) => target(cwd));
  const expected = [
    ["/a", "/b"],
    ["/c", "/d"],
    ["/e", "/a"],
    ["/b", "/c"],
    ["/d", "/a"],
    ["/e", "/b"],
  ];
  for (const [cycle, paths] of expected.entries()) {
    h.at(cycle * 10000);
    const start = h.calls.length;
    const pending = h.discovery.refresh(targets, h.changed);
    const started = h.calls.slice(start);
    assert.deepEqual(
      started.map(({ target }) => target.cwd),
      paths,
    );
    for (const call of started) call.result.resolve(record(call.target.cwd));
    await pending;
    assert.equal(h.calls.length, start + 2);
  }
  for (const item of targets) {
    assert.ok(h.calls.filter(({ target }) => target.key === item.key).length >= 2);
    assert.equal(h.discovery.state(item.key)?.error, false);
  }
});

test("force gets an available slot before other due targets without bypassing the global limit", async () => {
  const h = harness();
  const recent = target("/recent"),
    first = target("/first"),
    second = target("/second");
  const initial = h.discovery.refresh([recent], h.changed);
  h.calls[0].result.resolve(record(recent.cwd));
  await initial;
  const forced = h.discovery.refresh([first, second, recent], h.changed, recent.key);
  assert.deepEqual(
    h.calls.slice(1).map(({ target }) => target.key),
    [recent.key, first.key],
  );
  await h.discovery.refresh([second], h.changed, second.key);
  assert.equal(h.calls.length, 3);
  h.calls[1].result.resolve(record(recent.cwd));
  h.calls[2].result.resolve(record(first.cwd));
  await forced;
  assert.equal(h.discovery.state(second.key), undefined);
  assert.equal(h.calls.length, 3);
});

test("TTL starts at completion; unchanged periodic reads are silent and force bypasses TTL", async () => {
  const h = harness(),
    a = target("/a");
  const first = h.discovery.refresh([a], h.changed);
  h.at(20000);
  h.calls[0].result.resolve(record("/z") + record("/a"));
  await first;
  const original = h.discovery.state(a.key);
  h.at(29999);
  await h.discovery.refresh([a], h.changed);
  assert.equal(h.calls.length, 1);
  h.at(30000);
  const periodic = h.discovery.refresh([a], h.changed);
  assert.equal(h.calls.length, 2);
  assert.equal(h.notifications.length, 2);
  assert.equal(h.discovery.state(a.key)?.loading, false);
  h.calls[1].result.resolve(record("/z") + record("/a"));
  await periodic;
  assert.equal(h.notifications.length, 2);
  assert.equal(h.discovery.state(a.key), original);
  const forced = h.discovery.refresh([a], h.changed, a.key);
  assert.equal(h.calls.length, 3);
  h.calls[2].result.resolve(record("/a", "new", "topic"));
  await forced;
  assert.equal(h.notifications.length, 3);
  assert.equal(h.discovery.state(a.key)?.worktrees?.[0].branch, "topic");
});

test("errors retain results, back off 30 then 60 seconds from completion, and reset after recovery", async () => {
  const h = harness(),
    a = target("/a");
  const initial = h.discovery.refresh([a], h.changed);
  h.calls[0].result.resolve(record("/a"));
  await initial;
  const saved = h.discovery.state(a.key)?.worktrees;
  h.at(10000);
  const failure = h.discovery.refresh([a], h.changed);
  h.at(15000);
  h.calls[1].result.reject();
  await failure;
  assert.deepEqual(h.discovery.state(a.key), { worktrees: saved, error: true, loading: false });
  assert.equal(h.discovery.state(a.key)?.worktrees, saved);
  assert.equal(h.notifications.length, 3);
  h.at(44999);
  await h.discovery.refresh([a], h.changed);
  assert.equal(h.calls.length, 2);
  h.at(45000);
  const repeated = h.discovery.refresh([a], h.changed);
  h.calls[2].result.reject();
  await repeated;
  assert.equal(h.notifications.length, 3);
  h.at(104999);
  await h.discovery.refresh([a], h.changed);
  assert.equal(h.calls.length, 3);
  h.at(105000);
  const recovered = h.discovery.refresh([a], h.changed);
  h.calls[3].result.resolve(record("/a"));
  await recovered;
  assert.equal(h.notifications.length, 4);
  assert.equal(h.discovery.state(a.key)?.error, false);
  const failedAgain = h.discovery.refresh([a], h.changed, a.key);
  h.calls[4].result.reject();
  await failedAgain;
  h.at(134999);
  await h.discovery.refresh([a], h.changed);
  assert.equal(h.calls.length, 5);
  h.at(135000);
  const retried = h.discovery.refresh([a], h.changed);
  h.calls[5].result.resolve("");
  await retried;
  assert.deepEqual(h.discovery.state(a.key)?.worktrees, []);
});

test("initial failures expose loading/error transitions and force bypasses error backoff", async () => {
  const h = harness(),
    a = target("/a");
  const first = h.discovery.refresh([a], h.changed);
  h.calls[0].result.reject();
  await first;
  assert.deepEqual(h.discovery.state(a.key), { worktrees: undefined, error: true, loading: false });
  assert.equal(h.notifications.length, 2);
  await h.discovery.refresh([a], h.changed);
  assert.equal(h.calls.length, 1);
  const forced = h.discovery.refresh([a], h.changed, a.key);
  assert.deepEqual(h.discovery.state(a.key), { worktrees: undefined, error: true, loading: true });
  await h.discovery.refresh([a], h.changed, a.key);
  assert.equal(h.calls.length, 2);
  h.calls[1].result.resolve("");
  await forced;
  assert.deepEqual(h.discovery.state(a.key), { worktrees: [], error: false, loading: false });
  assert.equal(h.notifications.length, 4);
});

test("same cwd on different machines has independent keys, results, failures and reads", async () => {
  const h = harness();
  const local = target("/repo"),
    remote = target("/repo", "build");
  const first = h.discovery.refresh([local, remote], h.changed);
  assert.deepEqual(
    h.calls.map(({ target }) => target),
    [local, remote],
  );
  h.calls[0].result.resolve(record("/local", "local-head"));
  h.calls[1].result.reject();
  await first;
  assert.equal(h.discovery.state(local.key)?.worktrees?.[0].path, "/local");
  assert.equal(h.discovery.state(local.key)?.error, false);
  assert.equal(h.discovery.state(remote.key)?.error, true);
  const retry = h.discovery.refresh([local, remote], h.changed, remote.key);
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[2].target.machine, "build");
  h.calls[2].result.resolve(record("/remote", "remote-head"));
  await retry;
  assert.equal(h.discovery.state(remote.key)?.worktrees?.[0].head, "remote-head");
  assert.equal(h.discovery.state(local.key)?.worktrees?.[0].head, "local-head");
});

test("discovery instances do not share slots or cache", async () => {
  const first = harness(),
    second = harness();
  const targets = [target("/a"), target("/b")];
  const reads = [
    first.discovery.refresh(targets, first.changed),
    second.discovery.refresh(targets, second.changed),
  ];
  assert.equal(first.calls.length, 2);
  assert.equal(second.calls.length, 2);
  for (const h of [first, second]) for (const call of h.calls) call.result.resolve("");
  await Promise.all(reads);
});
