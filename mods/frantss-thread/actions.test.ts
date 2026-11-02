import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

type ThreadProps = { folder: string; machine?: string | null; space?: string; overlay: string };
type Agent = { key: string; name: string; icon: string; tint: boolean; run: string[] | null };
const terminal: Agent = {
  key: "terminal",
  name: "Terminal",
  icon: "icons/shell.svg",
  tint: true,
  run: null,
};

async function local(props: ThreadProps, agent: Agent = terminal) {
  const events: unknown[][] = [];
  const unused = () => assert.fail("Unexpected native call");
  const context = vm.createContext({});
  const natives = {
    "gpui-kit": { View: class {}, div: unused, svg: unused, image: unused },
    "gpui-base": { h_flex: unused, v_flex: unused },
    herdr: {
      props: () => props,
      closeOverlay: (...args: unknown[]) => events.push(["closeOverlay", ...args]),
      run: (...args: unknown[]) => events.push(["run", ...args]),
      theme: unused,
      knownAgents: unused,
      openOverlay: unused,
      shared: unused,
      setShared: unused,
    },
  };
  const module = new vm.SourceTextModule(
    stripTypeScriptTypes(await readFile(new URL("main.ts", import.meta.url), "utf8")),
    { context },
  );
  await module.link(async (name) => {
    if (name.startsWith("./")) {
      assert.equal(name, "./agent-launch.ts");
      return new vm.SourceTextModule(
        stripTypeScriptTypes(await readFile(new URL(name, import.meta.url), "utf8")),
        { context },
      );
    }
    const values = natives[name];
    assert.ok(values, `Unexpected native module: ${name}`);
    return new vm.SyntheticModule(
      Object.keys(values),
      function () {
        for (const [key, value] of Object.entries(values)) this.setExport(key, value);
      },
      { context },
    );
  });
  await module.evaluate();
  const Thread = (module.namespace as { default: new () => { local(agent: Agent): unknown } })
    .default;
  new Thread().local(agent);
  return JSON.parse(JSON.stringify(events));
}

const baseProps = { folder: "/checkout with spaces", overlay: "thread-popup" };

test("Local creates a space on the supplied remote machine when no space exists", async () => {
  assert.deepEqual(await local({ ...baseProps, machine: "build" }), [
    ["closeOverlay", "thread-popup"],
    ["run", "space.new", { folder: baseProps.folder, machine: "build" }],
  ]);
});

test("Local passes explicit empty-string machine for null, omitted and empty local machines", async () => {
  for (const props of [baseProps, { ...baseProps, machine: null }, { ...baseProps, machine: "" }]) {
    assert.deepEqual(await local(props), [
      ["closeOverlay", "thread-popup"],
      ["run", "space.new", { folder: baseProps.folder, machine: "" }],
    ]);
  }
});

test("Local with an existing space selects it and opens a tab instead of another space", async () => {
  assert.deepEqual(await local({ ...baseProps, machine: "build", space: "space-1" }), [
    ["closeOverlay", "thread-popup"],
    ["run", "space.select", { id: "space-1" }],
    ["run", "tab.new", { space: "space-1" }],
  ]);
});

test("Codex launch argv keeps --no-daemon for new spaces and existing-space tabs", async () => {
  for (const run of [
    ["codex", "--model", "example"],
    ["codex", "--no-daemon", "--model", "example"],
  ]) {
    const agent = { ...terminal, key: "codex", name: "Codex", run };
    const argv = ["codex", "--no-daemon", "--model", "example"];
    assert.deepEqual(await local({ ...baseProps, machine: "build" }, agent), [
      ["closeOverlay", "thread-popup"],
      ["run", "space.new", { folder: baseProps.folder, machine: "build", argv }],
    ]);
    assert.deepEqual(await local({ ...baseProps, machine: "build", space: "space-1" }, agent), [
      ["closeOverlay", "thread-popup"],
      ["run", "space.select", { id: "space-1" }],
      ["run", "tab.new", { space: "space-1", argv }],
    ]);
  }
});

test("non-Codex agent argv is preserved without Codex-only flags", async () => {
  const argv = ["claude", "--resume"];
  assert.deepEqual(await local({ ...baseProps, machine: "build" }, { ...terminal, run: argv }), [
    ["closeOverlay", "thread-popup"],
    ["run", "space.new", { folder: baseProps.folder, machine: "build", argv }],
  ]);
});
