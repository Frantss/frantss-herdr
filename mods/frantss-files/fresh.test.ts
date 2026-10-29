import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { daemonName, daemonRunning, freshConfig, freshTheme } from "./fresh.ts";

test("each folder gets its own stable daemon name", () => {
  assert.equal(daemonName("/a/app"), daemonName("/a/app"));
  assert.notEqual(daemonName("/a/app"), daemonName("/b/app"));
  assert.match(daemonName("/Users/me/my.project"), /^herdr-my-project-[0-9a-z]+$/);
});

test("the daemon list is read one name per line", () => {
  const list = "Running daemons:\n  herdr-app-1\n  local-2\n\nAttach with: fresh -a [NAME]\n";
  assert.ok(daemonRunning(list, "herdr-app-1"));
  assert.ok(!daemonRunning(list, "herdr-app"));
});

// Herdr's theme() as the old preview read it: flat keys, the palette as ansi0 to ansi15.
const herdrTheme = (file: string) => {
  const { ansi, colors, ...rest } = JSON.parse(
    readFileSync(new URL(`../../themes/${file}`, import.meta.url), "utf8"),
  );
  return {
    ...rest,
    ...colors,
    ...Object.fromEntries(ansi.map((c: string, i: number) => [`ansi${i}`, c])),
  };
};

test("both frantss themes give a Fresh color for every mapped key", () => {
  for (const [file, light] of [
    ["frantss-dark.json", false],
    ["frantss-light.json", true],
  ] as const) {
    const theme = freshTheme(herdrTheme(file), light);
    assert.equal(theme.extends, light ? "builtin://light" : "builtin://dark");
    for (const section of ["editor", "ui", "search", "diagnostic", "syntax"] as const)
      for (const [key, color] of Object.entries(theme[section]))
        assert.ok(
          color.length === 3 && color.every((c) => Number.isInteger(c) && c >= 0 && c <= 255),
          `${file} ${section}.${key}`,
        );
  }
  assert.deepEqual(freshTheme(herdrTheme("frantss-dark.json"), false).editor.bg, [17, 17, 17]);
});

test("the Fresh config uses the theme file and turns off the welcome tab", () => {
  assert.deepEqual(freshConfig(), {
    theme: "herdr-frantss.json",
    plugins: { welcome_screen: { enabled: false } },
  });
});
