import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { SUBSCRIPTION_LAUNCH, SUBSCRIPTION_READER } from "./subscription-reader.ts";

const execute = promisify(execFile);

test("shell startup output cannot corrupt usage JSON or interpret script arguments", async () => {
  await fixture(async (directory) => {
    await symlink(process.execPath, join(directory, "node"));
    const shell = join(directory, "shell");
    await writeFile(
      shell,
      '#!/bin/sh\necho startup-noise\necho startup-warning >&2\nshift\nexec /bin/sh -c "$@"\n',
      { mode: 0o700 },
    );
    const literal = "quotes \" ' $() `command`\nnew line";
    const script = `process.stdout.write(JSON.stringify({ value: process.argv[1] }));`;
    const result = await execute(
      "/bin/sh",
      ["-c", SUBSCRIPTION_LAUNCH, "herdr-usage", "--input-type=module", "-e", script, literal],
      {
        env: { ...process.env, SHELL: shell, PATH: directory },
        timeout: 5000,
      },
    );
    assert.deepEqual(JSON.parse(result.stdout), { value: literal });
    assert.equal(result.stderr, "");
  });
});

async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "herdr-subscription-"));
  try {
    await writeFile(join(directory, "security"), "#!/bin/sh\nexit 44\n", { mode: 0o700 });
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function read(provider: string, directory: string, setup = "") {
  const script = `${setup}\nawait import(${JSON.stringify(`data:text/javascript;base64,${Buffer.from(SUBSCRIPTION_READER).toString("base64")}`)});`;
  const result = await execute(process.execPath, ["--input-type=module", "-e", script, provider], {
    env: {
      ...process.env,
      PATH: directory,
      CLAUDE_CONFIG_DIR: directory,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: directory,
      CLAUDE_CODE_OAUTH_TOKEN: "",
    },
    timeout: 25_000,
  });
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

test("Codex reads account limits without creating a model turn", async () => {
  await fixture(async (directory) => {
    const requests = join(directory, "requests.jsonl");
    await writeFile(
      join(directory, "codex"),
      `#!${process.execPath}
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  appendFileSync(${JSON.stringify(requests)}, line + '\\n');
  if (request.method === 'initialize') console.log(JSON.stringify({ id: request.id, result: {} }));
  if (request.method === 'account/rateLimits/read') console.log(JSON.stringify({ id: request.id, result: { rateLimits: {
    primary: { usedPercent: 37.5, windowDurationMins: 300, resetsAt: 1900000000 },
    secondary: { usedPercent: 81, windowDurationMins: 10080, resetsAt: 1900500000 }
  } } }));
});
`,
      { mode: 0o700 },
    );
    assert.deepEqual(await read("codex", directory), {
      windows: [
        { label: "5h", usedPercent: 37.5, resetsAt: 1900000000 },
        { label: "7d", usedPercent: 81, resetsAt: 1900500000 },
      ],
    });
    const methods = (await readFile(requests, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).method);
    assert.deepEqual(methods, ["initialize", "initialized", "account/rateLimits/read"]);
  });
});

test("Claude reads live quota percentages and does not expose OAuth credentials", async () => {
  await fixture(async (directory) => {
    await writeFile(
      join(directory, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "fixture-secret", expiresAt: Date.now() + 60_000 },
      }),
    );
    const setup = `globalThis.fetch = async (url, options) => {
      if (url !== 'https://api.anthropic.com/api/oauth/usage') throw Error('Unexpected URL');
      if (options.headers.Authorization !== 'Bearer fixture-secret') throw Error('Missing auth');
      if (options.headers['anthropic-beta'] !== 'oauth-2025-04-20') throw Error('Missing beta');
      return { ok: true, status: 200, json: async () => ({
        five_hour: { utilization: 23.5, resets_at: '2030-03-17T17:46:40Z' },
        seven_day: { utilization: 41.2, resets_at: '2030-03-23T12:40:00Z' }
      }) };
    };`;
    assert.deepEqual(await read("claude", directory, setup), {
      windows: [
        { label: "5h", usedPercent: 23.5, resetsAt: 1900000000 },
        { label: "7d", usedPercent: 41.2, resetsAt: 1900500000 },
      ],
    });
  });
});

test("Claude reports expired authentication without making a network call", async () => {
  await fixture(async (directory) => {
    await writeFile(
      join(directory, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "private-secret", expiresAt: 1 } }),
    );
    const result = await read(
      "claude",
      directory,
      "globalThis.fetch = () => { throw Error('Must not fetch'); };",
    );
    assert.deepEqual(result, { windows: [], error: "Open Claude Code and sign in again." });
    assert.ok(!JSON.stringify(result).includes("private-secret"));
  });
});

test("provider failures return safe messages without raw server errors", async () => {
  await fixture(async (directory) => {
    const result = await read("codex", directory);
    assert.deepEqual(result, { windows: [], error: "Install Codex CLI to read usage." });
    assert.deepEqual(await read("unknown", directory), {
      windows: [],
      error: "Unknown subscription provider.",
    });
  });
});

test("Claude prefers current Keychain credentials and respects the configured service suffix", async () => {
  if (process.platform !== "darwin") return;
  await fixture(async (directory) => {
    const service =
      "Claude Code-credentials-" + createHash("sha256").update(directory).digest("hex").slice(0, 8);
    await writeFile(
      join(directory, "security"),
      `#!${process.execPath}
if (process.argv.at(-1) !== ${JSON.stringify(service)}) process.exit(1);
console.log(JSON.stringify({ claudeAiOauth: { accessToken: 'keychain-secret', expiresAt: Date.now() + 60000 } }));
`,
      { mode: 0o700 },
    );
    await writeFile(
      join(directory, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "old-secret", expiresAt: 1 } }),
    );
    const setup = `globalThis.fetch = async (_url, options) => {
      if (options.headers.Authorization !== 'Bearer keychain-secret') throw Error('Wrong credential');
      return { ok: true, status: 200, json: async () => ({ five_hour: { utilization: 0, resets_at: '2030-03-17T17:46:40Z' } }) };
    };`;
    assert.deepEqual(await read("claude", directory, setup), {
      windows: [{ label: "5h", usedPercent: 0, resetsAt: 1900000000 }],
    });
  });
});

test("Claude rejects invalid percentages and reports authentication failures safely", async () => {
  await fixture(async (directory) => {
    await writeFile(
      join(directory, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "sensitive-secret" } }),
    );
    assert.deepEqual(
      await read(
        "claude",
        directory,
        `globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'sensitive-secret' });`,
      ),
      { windows: [], error: "Open Claude Code and sign in again." },
    );
    assert.deepEqual(
      await read(
        "claude",
        directory,
        `globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ five_hour: { utilization: 101 }, seven_day: { utilization: '40' } }) });`,
      ),
      { windows: [], error: "Claude did not report subscription limits." },
    );
  });
});

test("Codex timeout kills its reader process", async () => {
  await fixture(async (directory) => {
    const pidFile = join(directory, "pid");
    await writeFile(
      join(directory, "codex"),
      `#!${process.execPath}
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`,
      { mode: 0o700 },
    );
    const setup =
      "const realSetTimeout = globalThis.setTimeout; globalThis.setTimeout = (callback, ms, ...args) => realSetTimeout(callback, ms === 20000 ? 1500 : ms, ...args);";
    assert.deepEqual(await read("codex", directory, setup), {
      windows: [],
      error: "Codex usage timed out. Try refreshing.",
    });
    const pid = Number(await readFile(pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });
});
