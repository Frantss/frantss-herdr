import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { colorRows, parseAnsi } from "./highlight.ts";

const sgr = (codes: string) => `\x1b[${codes}m`;

test("ANSI parsing maps the 16 terminal colors and resets", () => {
  assert.deepEqual(
    parseAnsi(
      `${sgr("35")}const${sgr("0")} a ${sgr("91")}=${sgr("39")} ${sgr("38;5;3")}1${sgr("")};`,
    ),
    [
      [
        { text: "const", color: 5 },
        { text: " a " },
        { text: "=", color: 9 },
        { text: " " },
        { text: "1", color: 3 },
        { text: ";" },
      ],
    ],
  );
});

test("ANSI parsing leaves unknown and 256 or true colors uncolored and merges equal spans", () => {
  assert.deepEqual(
    parseAnsi(
      `${sgr("32")}"${sgr("0")}${sgr("32")}a${sgr("1")}b${sgr("38;5;200")}c${sgr("38;2;1;2;3")}d`,
    ),
    [[{ text: '"ab', color: 2 }, { text: "cd" }]],
  );
});

test("ANSI parsing splits lines, keeps tabs and empty lines, and carries colors across lines", () => {
  assert.deepEqual(parseAnsi(`\t${sgr("32")}"a\n\nb"${sgr("0")}\n`), [
    [{ text: "\t" }, { text: '"a', color: 2 }],
    [],
    [{ text: 'b"', color: 2 }],
  ]);
  assert.deepEqual(parseAnsi(""), []);
});

test("diff rows take old colors for removals, new colors otherwise, and skip mismatches", () => {
  const old = parseAnsi(`${sgr("35")}let${sgr("0")} a\n`);
  const next = parseAnsi(`${sgr("35")}let${sgr("0")} b\n${sgr("33")}2${sgr("0")}\nplain\n`);
  const rows = [
    { kind: "@", text: "@@ -1 +1,3 @@" },
    { kind: "-", number: 1, text: "let a" },
    { kind: "+", number: 1, text: "let b" },
    { kind: " ", number: 2, text: "changed" },
    { kind: "+", number: 3, text: "plain" },
    { kind: "+", number: 9, text: "missing" },
  ];
  const colored = colorRows(rows, old, next);
  assert.deepEqual(colored[1].spans, [{ text: "let", color: 5 }, { text: " a" }]);
  assert.deepEqual(colored[2].spans, [{ text: "let", color: 5 }, { text: " b" }]);
  for (const i of [0, 3, 4, 5]) assert.equal(colored[i], rows[i]);
});

test("diff rows keep their array when nothing gains a color", () => {
  const rows = [{ kind: "+", number: 1, text: "a" }];
  assert.equal(colorRows(rows, [], parseAnsi("a\n")), rows);
  assert.equal(colorRows(rows, [], []), rows);
});
