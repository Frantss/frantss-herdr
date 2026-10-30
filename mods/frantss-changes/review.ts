import type { Program } from "herdr";
import type { DiffRow } from "./highlight.ts";

export type Side = "old" | "new";
export interface ReviewComment {
  path: string;
  side: Side;
  number: number;
  // The line's text when the comment was written.
  quote: string;
  text: string;
}

export function lineSide(row: DiffRow): Side | null {
  if (row.number === undefined) return null;
  return row.kind === "-" ? "old" : row.kind === "+" || row.kind === " " ? "new" : null;
}

export const DEFAULT_NOTE = "Address all comments above.";

export function reviewMessage(comments: ReviewComment[], note: string) {
  const parts = ["Review comments:"];
  for (const { path, side, number, quote, text } of comments)
    parts.push(
      [`${path}:${number}${side === "old" ? " (removed line)" : ""}`, `> ${quote}`, text].join(
        "\n",
      ),
    );
  if (note.trim()) parts.push(note.trim());
  return parts.join("\n\n");
}

interface Agent {
  address: string;
  space: string;
  seq: number;
}

// This space's agents first, each group most recently changed first.
export function agentChoices<A extends Agent>(agents: A[], space: string | undefined): A[] {
  return [...agents].sort(
    (a, b) => Number(b.space === space) - Number(a.space === space) || b.seq - a.seq,
  );
}

// The chosen agent while it lives, else this space's most recently changed one.
export function pickAgent<A extends Agent>(
  agents: A[],
  space: string | undefined,
  chosen: string | null = null,
): A | null {
  const first = agentChoices(agents, space)[0];
  return (
    agents.find((agent) => agent.address === chosen) ?? (first?.space === space ? first : null)
  );
}

// Comment rows follow the line they quote. Comments whose line changed or left the diff are
// outdated and follow the last row.
export function withComments(rows: DiffRow[], comments: ReviewComment[], path: string | null) {
  const own = comments.flatMap((comment, index) =>
    comment.path === path ? [{ comment, index }] : [],
  );
  if (!own.length) return rows;
  const placed = new Set<number>(),
    shown: DiffRow[] = [];
  for (const row of rows) {
    shown.push(row);
    const side = lineSide(row);
    if (!side) continue;
    for (const { comment, index } of own)
      if (comment.side === side && comment.number === row.number && comment.quote === row.text) {
        placed.add(index);
        shown.push({ kind: "#", text: comment.text, comment: index });
      }
  }
  for (const { comment, index } of own)
    if (!placed.has(index))
      shown.push({ kind: "#", text: comment.text, comment: index, outdated: true });
  return shown;
}

export type Target = Omit<ReviewComment, "text"> & { index: number | null };

// The comment box takes the place of the comment it edits, or follows the line it comments on.
export function withComposer(rows: DiffRow[], target: Target | null) {
  if (!target) return rows;
  const compose = { kind: "compose", text: "" },
    at =
      target.index === null
        ? rows.findIndex(
            (row) =>
              row.kind !== "#" && row.number === target.number && lineSide(row) === target.side,
          )
        : rows.findIndex((row) => row.comment === target.index);
  if (at < 0) return [...rows, compose];
  const shown = [...rows];
  if (target.index === null) shown.splice(at + 1, 0, compose);
  else shown[at] = compose;
  return shown;
}

// The frantss rail's thread title (a mod can't import another's code): what a program says it is
// doing in its terminal title, spinner glyphs gone; null for paths, user@host or its own name.
function threadTitle(title: string, program: Program) {
  const live = (title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
  const telling =
    live &&
    live !== program?.name &&
    live.toLowerCase() !== program?.key &&
    !/^[~/]|^[A-Za-z]:\\/.test(live) &&
    !live.includes("@");
  return telling ? live : null;
}

// An agent goes by its tab's name as the rail shows it: the name given, else its thread, else
// its program, in lower case.
export function agentName(
  agent: { title: string; program: Program },
  tab: { name: string; named: boolean } | undefined,
) {
  if (tab?.named) return tab.name;
  return (threadTitle(agent.title, agent.program) ?? agent.program?.name ?? "agent").toLowerCase();
}
