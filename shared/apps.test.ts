import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { APPS, installedApps, knownApps, openArgs } from "./apps.ts";

const app = (key: string) => APPS.find((app) => app.key === key);

test("folders open in every app", () => {
  for (const each of APPS) assert.deepEqual(openArgs(each, "/repo"), ["-a", each.app, "/repo"]);
});

test("files open in editors, reveal in Finder, and open their folder in terminals", () => {
  assert.deepEqual(openArgs(app("zed"), "/repo/src", "/repo/src/a.ts"), [
    "-a",
    "Zed",
    "/repo/src/a.ts",
  ]);
  assert.deepEqual(openArgs(app("finder"), "/repo/src", "/repo/src/a.ts"), [
    "-R",
    "/repo/src/a.ts",
  ]);
  assert.deepEqual(openArgs(app("ghostty"), "/repo/src", "/repo/src/a.ts"), [
    "-a",
    "Ghostty",
    "/repo/src",
  ]);
});

test("known apps follow the stored keys in list order and ignore anything else", () => {
  assert.deepEqual(
    knownApps(["zed", "finder", "gone"]).map((app) => app.key),
    ["finder", "zed"],
  );
  assert.deepEqual(knownApps(null), []);
});

test("apps are found once by asking open for each one, and a failure counts as missing", async () => {
  const asked: string[] = [];
  const exec = (async (_command: string, args: string[]) => {
    asked.push(args[1]);
    if (args[1] === "Zed") throw new Error("no open");
    return { code: args[1] === "Finder" || args[1] === "Ghostty" ? 0 : 1, stdout: "", stderr: "" };
  }) as never;
  const found = await installedApps(exec);
  assert.equal(await installedApps(exec), found);
  assert.deepEqual(
    asked,
    APPS.map((app) => app.app),
  );
  assert.deepEqual(
    found.map((app) => app.key),
    ["finder", "ghostty"],
  );
});
