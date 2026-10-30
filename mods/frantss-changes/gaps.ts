import type { DiffRow } from "./highlight.ts";
import { LINE_LENGTH, TRUNCATED } from "./preview.ts";

export function fileLines(text: string) {
  const lines = text.split("\n");
  if (!text || text.endsWith("\n")) lines.pop();
  return lines;
}

const clip = (line: string) =>
  line.length > LINE_LENGTH ? line.slice(0, LINE_LENGTH) + TRUNCATED : line || " ";

// Hunk headers count the unchanged lines hidden above them, and a last header offers the rest of
// the file. Expanded gaps show those lines from the new file in place of their header.
export function expandGaps(
  rows: DiffRow[],
  lines: string[] | null,
  expanded: ReadonlySet<number>,
): DiffRow[] {
  if (!lines) return rows;
  const shownRows: DiffRow[] = [];
  let shown = 0;
  for (const row of [...rows, { kind: "@", number: lines.length + 1, text: "" }]) {
    if (row.kind !== "@" || row.number === undefined) {
      shownRows.push(row);
      if (row.kind === "+" || row.kind === " ") shown = row.number;
      continue;
    }
    const gap = row.number - 1 - shown;
    if (gap > 0 && expanded.has(row.number)) {
      for (let number = shown + 1; number < row.number; number++)
        shownRows.push({ kind: " ", number, text: clip(lines[number - 1] ?? "") });
    } else if (gap > 0) shownRows.push({ ...row, gap });
    else if (row.text) shownRows.push(row);
    shown = row.number - 1;
  }
  return shownRows;
}
