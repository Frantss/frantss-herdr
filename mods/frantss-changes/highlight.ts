export interface Span {
  text: string;
  color?: number;
}
export interface DiffRow {
  kind: string;
  // A hunk header's is the new file's line its hunk starts at.
  number?: number;
  text: string;
  spans?: Span[];
  // Unchanged lines hidden above a hunk header.
  gap?: number;
}

// The ansi theme uses only the 16 terminal colors, so the Herdr theme resolves them; tabs stay
// tabs, so the text equals the diff's.
const BAT =
  'head -c 400000 | bat --color=always --style=plain --paging=never --wrap=never --tabs=0 --theme=ansi --file-name "$1"';
// `$1` is the path; `$2` is `HEAD:`, or `:` for the index of a repository without commits.
export const OLD_SOURCE = `git show "$2$1" | ${BAT}`;
export const NEW_SOURCE = `cat -- "$1" | ${BAT}`;

function sgrColor(codes: number[], color: number | undefined) {
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (code === 0 || code === 39) color = undefined;
    else if (code >= 30 && code <= 37) color = code - 30;
    else if (code >= 90 && code <= 97) color = code - 82;
    else if (code === 38 && codes[i + 1] === 5) {
      color = codes[i + 2] < 16 ? codes[i + 2] : undefined;
      i += 2;
    } else if (code === 38 && codes[i + 1] === 2) {
      color = undefined;
      i += 4;
    }
  }
  return color;
}

export function parseAnsi(text: string): Span[][] {
  const lines: Span[][] = [];
  let line: Span[] = [],
    color: number | undefined,
    start = 0;
  const add = (end: number) => {
    if (end <= start) return;
    const part = text.slice(start, end),
      last = line.at(-1);
    if (last && last.color === color) last.text += part;
    else line.push(color === undefined ? { text: part } : { text: part, color });
  };
  // oxlint-disable-next-line no-control-regex -- bat's color codes start with ESC.
  const pattern = /\x1b\[([0-9;]*)m|\n/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    add(match.index);
    if (match[0] === "\n") {
      lines.push(line);
      line = [];
    } else color = sgrColor(match[1].split(";").map(Number), color);
    start = pattern.lastIndex;
  }
  add(text.length);
  if (line.length) lines.push(line);
  return lines;
}

// Removed rows take the old file's colors and the others the new file's, by line number. A line
// whose colored text differs from the diff's stays plain.
export function colorRows(rows: DiffRow[], old: Span[][], next: Span[][]): DiffRow[] {
  let changed = false;
  const colored = rows.map((row) => {
    const source = row.kind === "-" ? old : row.kind === "+" || row.kind === " " ? next : null;
    const spans = row.number ? source?.[row.number - 1] : undefined;
    if (
      !spans?.some((span) => span.color !== undefined) ||
      spans.map((span) => span.text).join("") !== row.text
    )
      return row;
    changed = true;
    return { ...row, spans };
  });
  return changed ? colored : rows;
}
