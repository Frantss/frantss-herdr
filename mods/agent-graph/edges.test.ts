import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

async function harness(width = 3000, childCount = 7) {
  const paints: any[] = [];
  const calls: any[] = [];
  const palette = { border: "#111111", input: "#222222", working: "#333333", blocked: "#444444" };
  const statuses = ["blocked", "working", "idle", "finished", "done", null, "error"];
  const records = [
    { address: "parent", state: "live", status: "working", created_ms: 0 },
    ...Array.from({ length: childCount }, (_, index) => ({
      address: `child-${index}`,
      parent: "parent",
      state: statuses[index % statuses.length] === "finished" ? "finished" : "live",
      status: statuses[index % statuses.length],
      created_ms: index + 1,
      finished_ms: Date.now(),
    })),
  ];
  function element() {
    const node: any = { childNodes: [], styles: [], handlers: {} };
    const proxy = new Proxy(node, {
      get(target, name) {
        if (name in target) return target[name];
        if (name === "then") return undefined;
        return (...args) => {
          if (name === "when") {
            if (args[0]) args[1](proxy);
          } else if (name === "child") node.childNodes.push(args[0]);
          else if (name === "children") node.childNodes.push(...args[0]);
          else if (name === "id") node.id = args[0];
          else if (String(name).startsWith("on_")) node.handlers[name] = args.at(-1);
          else node.styles.push([name, ...args]);
          return proxy;
        };
      },
    });
    return proxy;
  }
  function path(width) {
    const result = {
      width,
      dash: undefined,
      commands: [],
      dash_array(value) {
        this.dash = Array.from(value);
        return this;
      },
      move_to(x, y) {
        this.commands.push(["move", x, y]);
        return this;
      },
      line_to(x, y) {
        this.commands.push(["line", x, y]);
        return this;
      },
      build() {
        return { width: this.width, dash: this.dash, commands: this.commands };
      },
    };
    return result;
  }
  const context = vm.createContext({
    window: {
      paint_path(path, color) {
        const node = element();
        paints.push({ path, color, node });
        return node;
      },
    },
  });
  const natives = {
    "gpui-kit": {
      View: class {},
      div: element,
      image: element,
      svg: element,
      PathBuilder: { stroke: path },
    },
    "gpui-base": { v_flex: element, h_flex: element },
    herdr: {
      agents: () => [],
      terminals: () => records.filter((record) => record.state === "live"),
      panes: () => [],
      focused: () => ({ terminal: "parent" }),
      run: (...args) => calls.push(args),
      hc: () => assert.fail("Unexpected hc call"),
      settings: () => ({ zoom: 1 }),
      shared: () => null,
      theme: () => palette,
      layout: () => null,
    },
  };
  const module = new vm.SourceTextModule(
    stripTypeScriptTypes(await readFile(new URL("main.ts", import.meta.url), "utf8")),
    { context },
  );
  await module.link((name) => {
    const values = natives[name];
    return new vm.SyntheticModule(
      Object.keys(values),
      function () {
        for (const [key, value] of Object.entries(values)) this.setExport(key, value);
      },
      { context },
    );
  });
  await module.evaluate();
  const Graph = (module.namespace as { default: new () => any }).default;
  const graph = new Graph();
  Object.assign(graph, {
    scope: "all",
    folded: new Set(),
    size: { width, height: 600 },
    ended: new Map(
      records.filter((record) => record.state !== "live").map((record) => [record.address, record]),
    ),
  });
  const cx = { notify: () => calls.push(["notify"]), stop_propagation: () => calls.push(["stop"]) };
  return { graph, paints, palette, records, calls, cx, render: () => graph.render(cx) };
}

function byId(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.childNodes ?? []) {
    const found = byId(child, id);
    if (found) return found;
  }
  return null;
}
const style = (node, name) => node.styles.find(([key]) => key === name)?.[1];
const plain = (value) => JSON.parse(JSON.stringify(value));

for (const width of [3000, 366]) {
  test(`agent edges retain geometry, styles, layer order, and clicks at width ${width}`, async () => {
    const h = await harness(width);
    const tree = h.render();
    assert.equal(h.paints.length, 4);
    assert.deepEqual(
      h.paints.map((paint) => paint.color),
      Object.values(h.palette),
    );
    const canvas = byId(tree, "graph").childNodes[0];
    const canvasWidth = style(canvas, "w"),
      canvasHeight = style(canvas, "h");
    const parent = byId(tree, "card-parent");
    const outline = width === 366;
    assert.equal(h.graph.outline, outline);
    const px = (x) => `${(x / canvasWidth) * 100}%`;
    const py = (y) => `${(y / canvasHeight) * 100}%`;
    const expected = Array.from({ length: 4 }, () => []);
    for (const record of h.records.slice(1)) {
      const child = byId(tree, `card-${record.address}`);
      const status = record.status;
      const order =
        status === "finished"
          ? 0
          : status === "working"
            ? 2
            : status === "blocked" || status === "error"
              ? 3
              : 1;
      const from = {
        x: style(parent, "left") + (outline ? 14 : style(parent, "w") / 2),
        y: style(parent, "top") + 52,
      };
      const to = {
        x: style(child, "left") + (outline ? 0 : style(child, "w") / 2),
        y: style(child, "top") + (outline ? 26 : 0),
      };
      const mid = (from.y + to.y) / 2;
      expected[order].push(["move", px(from.x), py(from.y)]);
      if (outline) expected[order].push(["line", px(from.x), py(to.y)]);
      else expected[order].push(["line", px(from.x), py(mid)], ["line", px(to.x), py(mid)]);
      expected[order].push(["line", px(to.x), py(to.y)]);
    }
    for (const [order, paint] of h.paints.entries()) {
      assert.deepEqual(paint.path.commands, expected[order]);
      assert.equal(paint.path.width, order === 3 ? 2 : 1.5);
      assert.deepEqual(paint.path.dash, order === 0 ? [4, 4] : undefined);
      const layer = canvas.childNodes.find((node) => node.childNodes.includes(paint.node));
      assert.deepEqual(
        plain(layer.styles.filter(([name]) => name === "loop")),
        order === 2 ? [["loop", "opacity", { from: 0.35, to: 1, period: 1400 }]] : [],
      );
    }
    parent.handlers.on_click({}, h.cx);
    assert.deepEqual(plain(h.calls), [["terminal.peek", { terminal: "parent" }]]);
    byId(tree, "fold-parent").handlers.on_click({}, h.cx);
    assert.equal(h.graph.folded.has("parent"), true);
    assert.deepEqual(h.calls.slice(1), [["stop"], ["notify"]]);
    h.paints.length = 0;
    h.render();
    assert.equal(h.paints.length, 0);
  });
}

test("a thousand agent edges use at most four native path painters", async () => {
  const h = await harness(366, 1000);
  h.render();
  assert.equal(h.paints.length, 4);
  assert.equal(
    h.paints.flatMap((paint) => paint.path.commands).filter(([kind]) => kind === "move").length,
    1000,
  );
});
