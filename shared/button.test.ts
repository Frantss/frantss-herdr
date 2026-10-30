import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const palette = {
  surface: "#111111",
  foreground: "#ededed",
  muted: "#a1a1a1",
  border: "#232323",
  input: "#383838",
  hover: "#1b1b1b",
  accent: "#a78bfa",
  accent_foreground: "#0a0a0a",
};

function element() {
  const node = { styles: [], stateStyles: {}, handlers: {}, childNodes: [] };
  const proxy = new Proxy(node, {
    get(target, name) {
      if (name in target) return target[name];
      if (name === "then") return undefined;
      return (...args) => {
        if (name === "when") {
          if (args[0]) args[1](proxy);
        } else if (name === "hover" || name === "focus" || name === "active") {
          const start = node.styles.length;
          args[0](proxy);
          node.stateStyles[name] = node.styles.splice(start);
        } else if (String(name).startsWith("on_")) node.handlers[name] = args.at(-1);
        else if (name === "child") node.childNodes.push(args[0]);
        else node.styles.push([name, ...args]);
        return proxy;
      };
    },
  });
  return proxy;
}

async function load(dark = true) {
  const context = vm.createContext({});
  const natives = {
    "gpui-base": { Button: { new: element } },
    herdr: { theme: () => palette, settings: () => ({ dark }) },
  };
  const source = stripTypeScriptTypes(
    await readFile(new URL("button.ts", import.meta.url), "utf8"),
  );
  const module = new vm.SourceTextModule(source, { context });
  await module.link((id) => {
    const values = natives[id];
    return new vm.SyntheticModule(
      Object.keys(values),
      function () {
        for (const [key, value] of Object.entries(values)) this.setExport(key, value);
      },
      { context },
    );
  });
  await module.evaluate();
  return (module.namespace as { button: (...args: unknown[]) => any }).button;
}

// The last value set for a style wins, as in GPUI.
const style = (styles: unknown[][], name: string) =>
  [...styles].reverse().find(([n]) => n === name)?.[1];

test("secondary buttons match the site's surface, strong border and bottom edge", async () => {
  const button = await load();
  const node = button("save", "Save", () => {}, { size: "regular" });
  assert.equal(style(node.styles, "h"), 34);
  assert.equal(style(node.styles, "px"), 12);
  assert.equal(style(node.styles, "bg"), palette.surface);
  assert.equal(style(node.styles, "border_color"), palette.input);
  assert.equal(style(node.styles, "border_b"), 2);
  assert.equal(style(node.stateStyles.active, "border_b"), 1);
  assert.equal(style(node.stateStyles.hover, "border_color"), palette.muted);
  assert.equal(style(node.stateStyles.focus, "border_color"), palette.accent);
});

test("primary buttons use the accent with the site's darker edge in each appearance", async () => {
  for (const [dark, edge] of [
    [true, "#7c5fd6"],
    [false, "#4c1d95"],
  ] as const) {
    const node = (await load(dark))("send", "Send", () => {}, { variant: "primary" });
    assert.equal(style(node.styles, "bg"), palette.accent);
    assert.equal(style(node.styles, "text_color"), palette.accent_foreground);
    assert.equal(style(node.styles, "border_color"), edge);
    assert.ok(node.styles.some(([name]) => name === "font_bold"));
    assert.equal(style(node.stateStyles.hover, "bg"), `${palette.accent}d9`);
  }
});

test("quiet buttons are muted, transparent and underline on hover", async () => {
  const node = (await load())("help", "Help", () => {}, { variant: "quiet" });
  assert.equal(style(node.styles, "h"), 24);
  assert.equal(style(node.styles, "bg"), "#00000000");
  assert.equal(style(node.styles, "text_color"), palette.muted);
  assert.equal(style(node.styles, "border_b"), undefined);
  assert.equal(style(node.stateStyles.hover, "text_color"), palette.foreground);
  assert.ok(node.stateStyles.hover.some(([name]) => name === "underline"));
});

test("quiet icon buttons tint on hover and press instead of underlining", async () => {
  const node = (await load())("trash", "×", () => {}, {
    variant: "quiet",
    size: "dense",
    square: true,
  });
  assert.equal(style(node.styles, "w"), 20);
  assert.equal(style(node.stateStyles.hover, "bg"), `${palette.foreground}1a`);
  assert.equal(style(node.stateStyles.active, "bg"), `${palette.foreground}2e`);
  assert.ok(!node.stateStyles.hover.some(([name]) => name === "underline"));
});

test("disabled buttons drop the edge, hover and pointer", async () => {
  const node = (await load())("send", "Send", () => {}, { variant: "primary", disabled: true });
  assert.equal(style(node.styles, "bg"), palette.border);
  assert.equal(style(node.styles, "border_color"), palette.border);
  assert.equal(style(node.styles, "text_color"), palette.muted);
  assert.equal(style(node.styles, "border_b"), undefined);
  assert.equal(node.stateStyles.hover, undefined);
  assert.equal(style(node.styles, "disabled"), true);
});

test("a press and click run the action without reaching the parent", async () => {
  const node = (await load())("x", "X", (cx) => cx.ran++, { square: true, tooltip: "Close" });
  const cx = { ran: 0, stopped: 0, stop_propagation: () => cx.stopped++ };
  node.handlers.on_mouse_down({}, cx);
  node.handlers.on_click({}, cx);
  assert.deepEqual([cx.ran, cx.stopped], [1, 2]);
  assert.equal(style(node.styles, "w"), 24);
  assert.equal(style(node.styles, "accessibility_label"), "Close");
});
