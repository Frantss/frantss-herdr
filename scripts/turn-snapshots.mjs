import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
const agents = new Set(["pi", "omp", "claude-code", "codex"]);
const statuses = new Set(["recording", "complete", "interrupted", "error"]);
const treeId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const recordName = /^[a-f0-9]{64}-[a-f0-9-]{36}\.json$/;

async function git(cwd, args, options = {}) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...options.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_PREFIX", "GIT_NAMESPACE"])
    delete env[name];
  if (!options.env?.GIT_INDEX_FILE) delete env.GIT_INDEX_FILE;
  const execution = execute(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.splitIndex=false",
      ...args,
    ],
    {
      cwd,
      env,
      encoding: options.binary ? "buffer" : "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 15_000,
    },
  );
  execution.child.stdin.on("error", () => {});
  execution.child.stdin.end(options.input);
  const { stdout } = await execution;
  return typeof stdout === "string" && stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
}

async function repository(cwd) {
  if (typeof cwd !== "string" || !cwd) throw new Error("cwd is required");
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const gitDir = await git(root, ["rev-parse", "--absolute-git-dir"]);
  return { root, gitDir, directory: join(gitDir, "frantss-turns") };
}

function sessionKey(agent, session) {
  if (!agents.has(agent)) throw new Error("Unsupported turn agent");
  if (typeof session !== "string" || !session.trim() || session.length > 4096)
    throw new Error("session must be a nonempty string of at most 4096 characters");
  return createHash("sha256")
    .update(JSON.stringify([agent, session]))
    .digest("hex");
}

function validateTerminal(terminal) {
  if (terminal !== undefined && (typeof terminal !== "string" || terminal.length > 4096))
    throw new Error("terminal must be a string of at most 4096 characters");
}

function promptTitle(prompt) {
  for (const line of prompt.split(/\r?\n/)) {
    const normalized = line
      .replace(/\s+/gu, " ")
      .replace(/\p{Cc}/gu, "")
      .trim();
    if (normalized) return Array.from(normalized).slice(0, 160).join("");
  }
  return "";
}

async function records(directory, key) {
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const found = [];
  for (const name of names) {
    if (!recordName.test(name) || (key && !name.startsWith(`${key}-`))) continue;
    try {
      const record = JSON.parse(await readFile(join(directory, name), "utf8"));
      if (
        !record ||
        typeof record !== "object" ||
        record.id !== name.slice(0, -5) ||
        !agents.has(record.agent) ||
        typeof record.session !== "string" ||
        typeof record.title !== "string" ||
        typeof record.startedAt !== "string" ||
        !statuses.has(record.status) ||
        (record.before !== undefined && !treeId.test(record.before)) ||
        (record.after !== undefined && !treeId.test(record.after))
      )
        continue;
      found.push(record);
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
  }
  return found.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

async function save(directory, record) {
  const temporary = join(directory, `${record.id}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { flag: "wx" });
    await rename(temporary, join(directory, `${record.id}.json`));
  } finally {
    await rm(temporary, { force: true });
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function locked(repo, action) {
  await mkdir(repo.directory, { recursive: true });
  const key = createHash("sha256").update(repo.gitDir).digest("hex");
  const ref = `refs/frantss/turn-locks/${key}`;
  const owner = await git(repo.root, ["hash-object", "-w", "--stdin"], {
    input: JSON.stringify({ pid: process.pid, host: hostname(), token: randomUUID() }),
  });
  const zero = "0".repeat(owner.length);
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      await git(repo.root, ["update-ref", ref, owner, zero]);
      break;
    } catch (error) {
      let current;
      try {
        current = await git(repo.root, ["rev-parse", "--verify", "--quiet", ref]);
      } catch (readError) {
        if (readError.code !== 1) throw readError;
      }
      if (current) {
        const previous = JSON.parse(await git(repo.root, ["cat-file", "blob", current]));
        if (previous.host === hostname() && !processAlive(previous.pid)) {
          await git(repo.root, ["update-ref", "-d", ref, current]).catch(() => {});
        }
      } else if (!String(error.stderr).includes("cannot lock ref")) {
        throw error;
      }
      if (Date.now() >= deadline)
        throw new Error("Timed out waiting for turn snapshot writer", { cause: error });
      await setTimeout(20);
    }
  }
  try {
    for (const name of await readdir(repo.directory)) {
      if (
        /^\.capture-[A-Za-z0-9]{6}$/.test(name) ||
        /^[a-f0-9]{64}-[a-f0-9-]{36}\.[a-f0-9-]{36}\.tmp$/.test(name)
      )
        await rm(join(repo.directory, name), { recursive: true, force: true });
    }
    return await action();
  } finally {
    await git(repo.root, ["update-ref", "-d", ref, owner]);
  }
}

async function capture(repo, id, side) {
  const temporary = await mkdtemp(join(repo.directory, ".capture-"));
  const index = join(temporary, "index");
  const env = { GIT_INDEX_FILE: index };
  try {
    try {
      await copyFile(join(repo.gitDir, "index"), index);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await git(repo.root, ["read-tree", "--empty"], { env });
    }
    await git(repo.root, ["update-index", "--no-split-index"], { env });
    const tracked = await git(repo.root, ["ls-files", "--cached", "-z"], { env, binary: true });
    if (tracked.length)
      for (const flag of ["--no-assume-unchanged", "--no-skip-worktree"])
        await git(repo.root, ["update-index", flag, "-z", "--stdin"], { env, input: tracked });
    await git(repo.root, ["add", "--all", "--", "."], { env });
    const tree = await git(repo.root, ["write-tree"], { env });
    if (!treeId.test(tree)) throw new Error("Git returned an invalid snapshot tree");
    await git(repo.root, ["update-ref", `refs/frantss/turns/${id}/${side}`, tree]);
    return tree;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function retain(repo) {
  const completed = (await records(repo.directory)).filter(
    (record) => record.status !== "recording",
  );
  for (const record of completed.slice(100)) {
    for (const side of ["before", "after"])
      await git(repo.root, ["update-ref", "-d", `refs/frantss/turns/${record.id}/${side}`]);
    await rm(join(repo.directory, `${record.id}.json`), { force: true });
  }
}

async function failed(repo, record, error) {
  record.status = "error";
  record.endedAt = new Date().toISOString();
  record.error = Array.from(error instanceof Error ? error.message : String(error))
    .slice(0, 2048)
    .join("");
  await save(repo.directory, record);
  await retain(repo);
}

export async function beginTurn({
  cwd,
  agent,
  session,
  title,
  terminal,
  replaceActive = false,
  request,
}) {
  const key = sessionKey(agent, session);
  if (
    request !== undefined &&
    (typeof request !== "string" || !request.trim() || request.length > 4096)
  )
    throw new Error("request must be a nonempty string of at most 4096 characters");
  if (typeof replaceActive !== "boolean") throw new Error("replaceActive must be a boolean");
  if (typeof title !== "string") throw new Error("title is required");
  validateTerminal(terminal);
  const repo = await repository(cwd);
  return locked(repo, async () => {
    const matching = await records(repo.directory, key);
    const duplicate =
      request === undefined ? undefined : matching.find((record) => record.request === request);
    if (duplicate) return duplicate;
    const active = matching.find((record) => record.status === "recording");
    if (active?.before && !replaceActive) return active;
    let baseline;
    if (active) {
      if (active.before) {
        try {
          baseline = await capture(repo, active.id, "after");
          active.after = baseline;
        } catch (error) {
          await failed(repo, active, error);
          throw error;
        }
      } else active.error = "Before snapshot was interrupted";
      active.status = "interrupted";
      active.endedAt = new Date().toISOString();
      await save(repo.directory, active);
    }
    const record = {
      id: `${key}-${randomUUID()}`,
      agent,
      session,
      ...(terminal === undefined ? {} : { terminal }),
      ...(request === undefined ? {} : { request }),
      title: promptTitle(title),
      startedAt: new Date().toISOString(),
      status: "recording",
    };
    await save(repo.directory, record);
    try {
      if (baseline) {
        await git(repo.root, ["update-ref", `refs/frantss/turns/${record.id}/before`, baseline]);
        record.before = baseline;
      } else record.before = await capture(repo, record.id, "before");
    } catch (error) {
      await failed(repo, record, error);
      throw error;
    }
    await save(repo.directory, record);
    await retain(repo);
    return record;
  });
}

export async function endTurn({
  cwd,
  agent,
  session,
  terminal,
  status = "complete",
  continued = false,
}) {
  const key = sessionKey(agent, session);
  validateTerminal(terminal);
  if (typeof continued !== "boolean") throw new Error("continued must be a boolean");
  if (!statuses.has(status) || status === "recording") throw new Error("Invalid final turn status");
  const repo = await repository(cwd);
  return locked(repo, async () => {
    const matching = await records(repo.directory, key);
    const active = matching.find((candidate) => candidate.status === "recording");
    const record =
      active ??
      (continued
        ? matching.find((candidate) => terminal === undefined || candidate.terminal === terminal)
        : matching[0]);
    if (!record || (!active && (!continued || record.status !== "complete"))) return record;
    if (terminal !== undefined) record.terminal = terminal;
    try {
      if (record.before) record.after = await capture(repo, record.id, "after");
      else {
        status = "interrupted";
        record.error = "Before snapshot was interrupted";
      }
    } catch (error) {
      await failed(repo, record, error);
      throw error;
    }
    record.status = status;
    record.endedAt = new Date().toISOString();
    await save(repo.directory, record);
    await retain(repo);
    return record;
  });
}

export async function listTurns(cwd) {
  const repo = await repository(cwd);
  return records(repo.directory);
}
