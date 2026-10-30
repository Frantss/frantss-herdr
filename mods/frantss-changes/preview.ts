const LINE_LIMIT = 1500;
const LINE_LENGTH = 4000;
const FILE_PREFIX = 400000;

function previewLines(text: string, start: number, end: number, limit: number, prefix = "") {
  const stop = end - Number(end > start && text[end - 1] === "\n");
  const lines: string[] = [];
  while (start <= stop && lines.length < limit) {
    const newline = text.indexOf("\n", start);
    const lineEnd = newline < 0 || newline > stop ? stop : newline;
    const length = lineEnd - start + prefix.length;
    const line = prefix + text.slice(start, Math.min(lineEnd, start + LINE_LENGTH - prefix.length));
    lines.push(length > LINE_LENGTH ? line + "… (line truncated)" : line);
    if (lineEnd === stop) break;
    start = lineEnd + 1;
  }
  return lines;
}

export function untrackedPreview(text: string): { add: number | null; lines: string[] } {
  if (text.includes("\0")) return { add: null, lines: ["Binary file · no text diff"] };
  let add = Number(text.length > 0 && !text.endsWith("\n"));
  for (let newline = text.indexOf("\n"); newline !== -1; newline = text.indexOf("\n", newline + 1))
    add++;
  return {
    add,
    lines: [
      `@@ -0,0 +1,${add} @@`,
      ...previewLines(text, 0, Math.min(text.length, FILE_PREFIX), LINE_LIMIT - 1, "+"),
    ],
  };
}

export function trackedPreview(text: string, binary: boolean): string[] {
  const atStart = text.startsWith("@@");
  const hunk = atStart ? 0 : text.indexOf("\n@@");
  return hunk < 0
    ? [binary ? "Binary file changed" : "No text diff available"]
    : previewLines(text, atStart ? 0 : hunk + 1, text.length, LINE_LIMIT);
}
