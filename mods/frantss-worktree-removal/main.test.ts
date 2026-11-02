import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

async function harness(
  paths = ["/repo/feature-a", "/repo/feature-b"],
  skipped = [{ path: "/repo/main", reason: "Error: Main checkout is protected." }],
  checking = false,
) {
  const events: unknown[][] = [];
  const handles: { focus(): void; is_focused(): boolean }[] = [];
  let focused = -1;
  const tasks: ((cx: unknown) => Promise<void>)[] = [];
  let send: (command: string) => void;
  const p = {
    ...(checking ? { token: "42" } : {}),
    overlay: "removal-overlay",
    paths,
    skipped,
    command: { name: "frantss.remove-worktrees:42" },
  };
  const element = (id?: string) => {
    const node: any = { elementId: id, childNodes: [], styles: [], handlers: {}, parent: null };
    const append = (child) => {
      if (child && typeof child === "object" && "childNodes" in child) {
        assert.equal(child.parent, null, "Elements can have only one parent");
        child.parent = node;
      }
      node.childNodes.push(child);
    };
    const proxy = new Proxy(node, {
      get(target, key) {
        if (key in target) return target[key];
        if (key === "then") return undefined;
        return (...args) => {
          if (key === "child") append(args[0]);
          else if (key === "children") args[0].forEach(append);
          else if (key === "when") {
            if (args[0]) args[1](proxy);
          } else if (key === "id") target.elementId = args[0];
          else if (String(key).startsWith("on_")) target.handlers[key] = args.at(-1);
          else target.styles.push([key, ...args]);
          return proxy;
        };
      },
    });
    return proxy;
  };
  const context = vm.createContext({});
  const natives = {
    "gpui-kit": { View: class {}, div: () => element() },
    "gpui-base": {
      h_flex: () => element(),
      v_flex: () => element(),
      Button: { new: (id) => element(id) },
    },
    herdr: {
      props: () => p,
      nextCommand: () =>
        new Promise<string>((resolve) => {
          send = resolve;
        }),
      theme: () => ({
        popover: "#111111",
        foreground: "#ededed",
        muted: "#a1a1a1",
        border: "#232323",
        accent: "#a78bfa",
        accent_foreground: "#0a0a0a",
        input: "#383838",
        surface: "#111111",
      }),
      settings: () => ({ dark: true }),
      closeOverlay: (...args) => events.push(["close", ...args]),
      run: (...args) => events.push(["run", ...args]),
    },
  };
  const module = new vm.SourceTextModule(
    stripTypeScriptTypes(await readFile(new URL("main.ts", import.meta.url), "utf8")),
    { context },
  );
  await module.link(async (name) => {
    if (name === "./button.ts")
      return new vm.SourceTextModule(
        stripTypeScriptTypes(await readFile(new URL("button.ts", import.meta.url), "utf8")),
        { context },
      );
    const values = natives[name];
    assert.ok(values, `Unexpected import: ${name}`);
    return new vm.SyntheticModule(
      Object.keys(values),
      function () {
        for (const [key, value] of Object.entries(values)) this.setExport(key, value);
      },
      { context },
    );
  });
  await module.evaluate();
  const view = new (module.namespace as any).default();
  const cx = {
    focus_handle: () => {
      const index = handles.length;
      const handle = {
        focus: () => {
          focused = index;
        },
        is_focused: () => focused === index,
      };
      handles.push(handle);
      return handle;
    },
    stop_propagation: () => {},
    spawn: (task) => {
      tasks.push(task);
    },
    notify: () => {},
  };
  view.init({}, cx);
  const tree = view.render();
  const key = (key: string, shift = false) =>
    tree.handlers.on_key_down({ key, modifiers: { shift } }, cx);
  return {
    view,
    tree,
    events,
    handles,
    cx,
    key,
    tasks,
    render: () => view.render(),
    deliver: async (command: string) => {
      send(command);
      await new Promise(setImmediate);
    },
    focused: () => focused,
  };
}

const descendants = (node): any[] =>
  node && typeof node === "object" ? [node, ...node.childNodes.flatMap(descendants)] : [];
const byId = (tree, id: string) => descendants(tree).find((node) => node.elementId === id);
const text = (node): string =>
  typeof node === "string" ? node : (node?.childNodes?.map(text).join("") ?? "");

test("dialog separates removal and kept lists, displays names above full paths, and cleans error prefixes", async () => {
  const h = await harness();
  const content = text(h.tree);
  assert.match(content, /Remove 2 worktrees\?/);
  assert.match(
    content,
    /Checkout folders and ignored files will be deleted. Git branches are kept./,
  );
  assert.match(
    content,
    /Will remove \(2\).*feature-a\/repo\/feature-a.*feature-b\/repo\/feature-b/,
  );
  assert.match(content, /Will keep \(1\).*main\/repo\/main.*Main checkout is protected./);
  assert.doesNotMatch(content, /Error:/);
  assert.equal(text(byId(h.tree, "confirm-removal")), "Remove 2 worktrees");
  const lists = byId(h.tree, "worktree-removal-lists");
  assert.ok(lists.styles.some(([name]) => name === "overflow_y_scrollbar"));
  assert.equal(byId(lists, "confirm-removal"), undefined);
  assert.equal(byId(lists, "cancel-removal"), undefined);
});

test("Cancel is focused initially and Enter or Escape cancels without running removal", async () => {
  for (const key of ["enter", "space", "escape"]) {
    const h = await harness();
    assert.equal(h.focused(), 2);
    h.key(key);
    assert.deepEqual(h.events, [["close", "removal-overlay"]]);
  }
});

test("Tab and Shift+Tab stay inside the dialog and confirmation is explicit and single-use", async () => {
  const h = await harness();
  h.key("tab");
  assert.equal(h.focused(), 3);
  h.key("tab");
  assert.equal(h.focused(), 1);
  h.key("enter");
  assert.deepEqual(h.events, []);
  h.key("tab", true);
  assert.equal(h.focused(), 3);
  h.key("enter");
  h.key("enter");
  assert.deepEqual(h.events, [
    ["close", "removal-overlay"],
    ["run", "frantss.remove-worktrees:42"],
  ]);
});

test("both buttons work by click and cancellation cannot later run a stale confirmation", async () => {
  for (const remove of [false, true]) {
    const h = await harness();
    byId(h.tree, remove ? "confirm-removal" : "cancel-removal").handlers.on_click({}, h.cx);
    h.view.finish(true);
    assert.deepEqual(
      h.events,
      remove
        ? [
            ["close", "removal-overlay"],
            ["run", "frantss.remove-worktrees:42"],
          ]
        : [["close", "removal-overlay"]],
    );
  }
});

test("empty candidates disable removal and show an explicit empty state", async () => {
  const h = await harness([], []);
  assert.match(text(h.tree), /No eligible worktrees./);
  assert.match(text(h.tree), /No worktrees were skipped./);
  assert.ok(
    byId(h.tree, "confirm-removal").styles.some(([name, value]) => name === "disabled" && value),
  );
  h.key("tab");
  h.key("enter");
  assert.deepEqual(h.events, []);
  h.view.finish(true);
  assert.deepEqual(h.events, []);
});

const resultCommand = (result) => `result:${encodeURIComponent(JSON.stringify(result))}`;

test("checking dialog subscribes before requesting inspection and enables removal only after matching results", async () => {
  const h = await harness(undefined, undefined, true);
  assert.match(text(h.tree), /Checking worktrees…/);
  assert.doesNotMatch(text(h.tree), /Will remove|Will keep/);
  assert.ok(
    byId(h.tree, "confirm-removal").styles.some(([name, value]) => name === "disabled" && value),
  );
  h.view.finish(true);
  assert.deepEqual(h.events, []);
  void h.tasks[0](h.cx);
  assert.deepEqual(h.events, [["run", "frantss.inspect-worktrees:42"]]);
  await h.deliver(resultCommand({ token: "older", paths: ["/wrong"], skipped: [] }));
  assert.match(text(h.render()), /Checking worktrees…/);
  await h.deliver(resultCommand({ token: "42", paths: ["/correct"], skipped: [] }));
  const tree = h.render();
  assert.match(text(tree), /Remove 1 worktree\?/);
  assert.match(text(tree), /\/correct/);
  assert.ok(
    byId(tree, "confirm-removal").styles.some(([name, value]) => name === "disabled" && !value),
  );
  h.view.finish(true);
  assert.deepEqual(h.events.at(-1), ["run", "frantss.remove-worktrees:42"]);
});

test("cancellation during inspection invalidates its token and ignores late or malformed results", async () => {
  const h = await harness(undefined, undefined, true);
  h.key("escape");
  assert.deepEqual(h.events, [
    ["close", "removal-overlay"],
    ["run", "frantss.cancel-worktrees:42"],
  ]);
  assert.equal(
    h.view.receive(resultCommand({ token: "42", paths: ["/late"], skipped: [] })),
    false,
  );
  assert.equal(h.view.receive("result:bad-json"), false);
  assert.equal(h.view.paths, null);
});

test("external dismissal cancels inspection and ignores late results without closing twice", async () => {
  const h = await harness(undefined, undefined, true);
  h.view.close();
  h.view.close();
  assert.deepEqual(h.events, [["run", "frantss.cancel-worktrees:42"]]);
  assert.equal(
    h.view.receive(resultCommand({ token: "42", paths: ["/late"], skipped: [] })),
    false,
  );
});

test("inspection errors stay in the dialog with removal disabled and cancellation available", async () => {
  const h = await harness(undefined, undefined, true);
  assert.equal(h.view.receive("result:bad-json"), false);
  assert.equal(
    h.view.receive(resultCommand({ token: "42", error: "Error: Remote offline" })),
    true,
  );
  const tree = h.render();
  assert.match(text(tree), /Could not check worktrees.*Remote offline/);
  assert.doesNotMatch(text(tree), /Error:|Will remove/);
  h.view.finish(true);
  assert.deepEqual(h.events, []);
  byId(tree, "cancel-removal").handlers.on_click({}, h.cx);
  assert.equal(h.events[0][0], "close");
});

test("large inventories preserve all paths, unusual names and kept reasons without truncation", async () => {
  const paths = Array.from(
    { length: 80 },
    (_, index) => `/repo/${"long-directory/".repeat(8)}feature-${index}`,
  );
  paths.push("C:\\repo\\windows-checkout", "/repo/unix\\literal");
  const h = await harness(paths);
  for (const path of paths) assert.ok(text(h.tree).includes(path));
  assert.match(text(h.tree), /windows-checkoutC:\\repo\\windows-checkout/);
  assert.match(text(h.tree), /unix\\literal\/repo\/unix\\literal/);
  assert.equal(
    descendants(h.tree).some((node) => node.styles.some(([name]) => name === "truncate")),
    false,
  );
});
