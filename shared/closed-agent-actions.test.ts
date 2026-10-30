import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

type Space = { id: string; folder: string; machine?: string | null; tabs: { id: string }[] };
type Pane = { tab: string; cwd?: string | null };
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

async function load(spaces: Space[] = [], panes: Pane[] = []) {
  const context = vm.createContext({});
  const opened: Record<string, unknown>[] = [];
  const commands: unknown[][] = [];
  const herdr = {
    openOverlay: (spec: Record<string, unknown>) => (opened.push(spec), "o1"),
    spaces: () => spaces,
    panes: () => panes,
    run: (...args: unknown[]) => commands.push(args),
    hc: () => assert.fail("Confirmation must not delete history before the person confirms"),
    setShared: () => assert.fail("Confirmation must not remove the saved agent"),
  };
  const source = stripTypeScriptTypes(
    await readFile(new URL("closed-agent-actions.ts", import.meta.url), "utf8"),
  );
  const module = new vm.SourceTextModule(source, { context });
  await module.link(
    () =>
      new vm.SyntheticModule(
        Object.keys(herdr),
        function () {
          for (const [key, value] of Object.entries(herdr)) this.setExport(key, value);
        },
        { context },
      ),
  );
  await module.evaluate();
  const { openAgentTab, confirmForgetHistory } =
    module.namespace as typeof import("./closed-agent-actions.ts");
  return { openAgentTab, confirmForgetHistory, opened, commands };
}

test("closed agents open in the local space whose first live folder matches", async () => {
  const h = await load(
    [
      { id: "remote", machine: "build", folder: "/project/live", tabs: [{ id: "remote/t1" }] },
      { id: "local", folder: "/project/original", tabs: [{ id: "t1" }, { id: "t2" }] },
    ],
    [
      { tab: "remote/t1", cwd: "/project/live" },
      { tab: "t1", cwd: "" },
      { tab: "unrelated", cwd: "/elsewhere" },
      { tab: "t2", cwd: "/project/live" },
      { tab: "t1", cwd: "/project/later" },
    ],
  );
  const argv = ["hc", "read", "t8", "--lines", "100000"];
  h.openAgentTab("/project/live", argv, "Fix API history");
  assert.deepEqual(plain(h.commands), [
    ["space.select", { id: "local" }],
    ["tab.new", { space: "local", folder: "/project/live", argv, name: "Fix API history" }],
  ]);
  assert.equal(h.opened.length, 0);
});

test("a live folder supersedes the space's original folder", async () => {
  const h = await load(
    [{ id: "local", folder: "/project/original", tabs: [{ id: "t1" }, { id: "t2" }] }],
    [
      { tab: "t1", cwd: "/project/live" },
      { tab: "t2", cwd: "/project/original" },
    ],
  );
  h.openAgentTab("/project/original", ["codex", "resume"], "Resume Codex");
  assert.deepEqual(plain(h.commands), [
    ["space.new", { folder: "/project/original", argv: ["codex", "resume"], tab: "Resume Codex" }],
  ]);
});

test("a space without a live pane folder uses its original folder", async () => {
  const h = await load(
    [{ id: "local", folder: "/project", tabs: [{ id: "t1" }, { id: "t2" }] }],
    [
      { tab: "t1", cwd: "" },
      { tab: "t2", cwd: null },
    ],
  );
  h.openAgentTab("/project", ["claude", "--resume"]);
  assert.deepEqual(plain(h.commands), [
    ["space.select", { id: "local" }],
    ["tab.new", { space: "local", folder: "/project", argv: ["claude", "--resume"] }],
  ]);
});

test("a matching remote space cannot receive a closed local agent", async () => {
  const h = await load(
    [{ id: "remote", machine: "build", folder: "/project", tabs: [{ id: "remote/t1" }] }],
    [{ tab: "remote/t1", cwd: "/project" }],
  );
  h.openAgentTab("/project", ["codex", "resume"]);
  assert.deepEqual(plain(h.commands), [
    ["space.new", { folder: "/project", argv: ["codex", "resume"] }],
  ]);
});

test("forgetting history asks first and targets the encoded terminal address", async () => {
  const h = await load();
  const address = "build/agent:task 1%";
  h.confirmForgetHistory(address, "Fix API");
  assert.deepEqual(plain(h.opened), [
    {
      mod: "confirm",
      kind: "dialog",
      width: 400,
      height: 170,
      props: {
        title: "Forget Fix API history?",
        detail: "This removes the retained terminal history. It cannot be undone.",
        command: { name: `frantss.forget-history:${encodeURIComponent(address)}` },
      },
    },
  ]);
  assert.deepEqual(h.commands, []);
});
