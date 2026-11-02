import type { ChangedFile } from "./status.ts";
import { parseNumstat } from "./status.ts";
import { trackedPreview } from "./preview.ts";

export interface Turn {
  id: string;
  agent: "pi" | "omp" | "claude-code" | "codex";
  session: string;
  terminal?: string;
  title: string;
  startedAt: string;
  endedAt?: string;
  status: "recording" | "complete" | "interrupted" | "error";
  before?: string;
  after?: string;
  error?: string;
}
export interface TurnPlace {
  root: string;
  gitDir: string;
  on: string | null;
}
type Execute = (
  command: string,
  args: string[],
  options: { cwd: string; on: string | null },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const validTurnId = (id: unknown): id is string =>
  typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(id);
export const validTreeOid = (oid: unknown): oid is string =>
  typeof oid === "string" && /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(oid);
const date = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

export function parseTurn(value: unknown): Turn | null {
  if (!value || typeof value !== "object") return null;
  const turn = value as Turn;
  if (
    !validTurnId(turn.id) ||
    !["pi", "omp", "claude-code", "codex"].includes(turn.agent) ||
    typeof turn.session !== "string" ||
    !turn.session ||
    typeof turn.title !== "string" ||
    !date(turn.startedAt) ||
    !["recording", "complete", "interrupted", "error"].includes(turn.status) ||
    (turn.terminal !== undefined && typeof turn.terminal !== "string") ||
    (turn.endedAt !== undefined && !date(turn.endedAt)) ||
    (turn.before !== undefined && !validTreeOid(turn.before)) ||
    (turn.after !== undefined && !validTreeOid(turn.after)) ||
    (turn.error !== undefined && typeof turn.error !== "string")
  )
    return null;
  return turn;
}

// NUL frames separate records; raw NUL bytes become invalid JSON, not extra frames.
export const READ_TURNS = `
LC_ALL=C
export LC_ALL
case "$1" in /*) ;; *) echo 'Git directory must be absolute' >&2; exit 1 ;; esac
if [ ! -d "$1" ] || [ ! -r "$1" ] || [ ! -x "$1" ]; then
  echo 'Cannot read Git directory' >&2; exit 1
fi
dir="$1/frantss-turns"
if [ ! -e "$dir" ] && [ ! -L "$dir" ]; then exit 0; fi
if [ ! -d "$dir" ] || [ ! -r "$dir" ] || [ ! -x "$dir" ]; then
  echo 'Cannot read recorded turn directory' >&2; exit 1
fi
command -v head >/dev/null && command -v tr >/dev/null || exit 1
for file in "$dir"/*.json; do
  name=\${file##*/}
  id=\${name%.json}
  case "$id" in ''|[!A-Za-z0-9]*|*[!A-Za-z0-9_-]*) continue ;; esac
  [ \${#id} -le 200 ] || continue
  content=
  if [ -f "$file" ] && [ ! -L "$file" ] && [ -r "$file" ]; then
    content=$(head -c 65537 "$file" | tr '\\000' '\\001'; printf '.')
    content=\${content%.}
    [ \${#content} -le 65536 ] || content=
  fi
  printf '%s\\000%s\\000' "$name" "$content"
done
`;

export async function loadTurns(execute: Execute, place: TurnPlace) {
  const result = await execute("sh", ["-c", READ_TURNS, "turns", place.gitDir], {
    cwd: place.root,
    on: place.on,
  });
  if (result.code !== 0) throw new Error(result.stderr.trim() || "Cannot read recorded turns");
  const records = result.stdout.split("\0");
  if (records.pop() !== "" || records.length % 2) throw new Error("Invalid recorded turn list");
  const turns: Turn[] = [];
  let skipped = 0;
  for (let i = 0; i < records.length; i += 2) {
    try {
      const turn = parseTurn(JSON.parse(records[i + 1]));
      if (!turn || records[i] !== `${turn.id}.json`) skipped++;
      else turns.push(turn);
    } catch {
      skipped++;
    }
  }
  turns.sort(
    (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.id.localeCompare(b.id),
  );
  return { turns: turns.slice(-100), skipped };
}

export function turnLabel(turn: Turn) {
  const agent = {
    pi: "Pi",
    omp: "OMP",
    "claude-code": "Claude Code",
    codex: "Codex",
  }[turn.agent];
  const started = new Date(turn.startedAt).toISOString().slice(5, 19).replace("T", " ") + "Z";
  return [
    turn.terminal,
    agent,
    started,
    turn.title || turn.id,
    turn.status === "complete" ? null : turn.status,
  ]
    .filter(Boolean)
    .join(" · ");
}

function trees(turn: Turn) {
  if (!validTurnId(turn.id) || !validTreeOid(turn.before) || !validTreeOid(turn.after))
    throw new Error("No before/after snapshot recorded for this turn");
  return [turn.before, turn.after];
}
const validPath = (path: string) =>
  path.length > 0 &&
  !path.includes("\0") &&
  !path.startsWith("/") &&
  !path.split("/").some((part) => part === ".." || part === "." || !part);
const gitDiff = async (execute: Execute, place: TurnPlace, turn: Turn, args: string[]) => {
  const result = await execute(
    "git",
    [
      "--literal-pathspecs",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--no-renames",
      ...args,
      ...trees(turn),
      "--",
    ],
    { cwd: place.root, on: place.on },
  );
  if (result.code !== 0) throw new Error(result.stderr.trim() || "Cannot read saved snapshots");
  return result.stdout;
};

export async function turnFiles(
  execute: Execute,
  place: TurnPlace,
  turn: Turn,
): Promise<ChangedFile[]> {
  const [names, numbers] = await Promise.all([
    gitDiff(execute, place, turn, ["--name-status", "-z"]),
    gitDiff(execute, place, turn, ["--numstat", "-z"]),
  ]);
  const tokens = names.split("\0"),
    stats = parseNumstat(numbers),
    files: ChangedFile[] = [];
  if (tokens.pop() !== "" || tokens.length % 2) throw new Error("Invalid saved file list");
  for (let i = 0; i < tokens.length; i += 2) {
    const status = tokens[i],
      path = tokens[i + 1];
    if (!/^[AMDTUXB]$/.test(status) || !validPath(path))
      throw new Error("Invalid saved file path or status");
    files.push({
      section: "unstaged",
      status,
      path,
      fresh: false,
      ...(stats[path] ?? { add: 0, del: 0 }),
    });
  }
  return files;
}

export async function turnDiff(execute: Execute, place: TurnPlace, turn: Turn, file: ChangedFile) {
  if (!validPath(file.path)) throw new Error("Invalid saved file path");
  const result = await execute(
    "git",
    [
      "--literal-pathspecs",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--no-renames",
      ...trees(turn),
      "--",
      file.path,
    ],
    { cwd: place.root, on: place.on },
  );
  if (result.code !== 0) throw new Error(result.stderr.trim() || "Cannot read saved diff");
  return trackedPreview(result.stdout, Boolean(file.binary));
}
