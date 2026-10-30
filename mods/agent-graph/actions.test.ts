import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { menuItems } from "./actions.ts";

const actions = (card: { live: boolean; pane: boolean; reply?: boolean }) =>
  menuItems({ reply: true, ...card }).map((item) => item?.action ?? null);

test("a live agent's menu gives back its pane, or gives a sub-agent one", () => {
  assert.deepEqual(actions({ live: true, pane: true }), [
    "focus",
    "peek",
    "park",
    null,
    "reply",
    "interrupt",
    null,
    "copy-address",
    "copy-folder",
    null,
    "kill",
  ]);
  assert.equal(actions({ live: true, pane: false })[2], "keep");
  assert.ok(!actions({ live: true, pane: true, reply: false }).includes("reply"));
});

test("a finished sub-agent's menu only copies or removes it", () => {
  assert.deepEqual(actions({ live: false, pane: false }), [
    "copy-address",
    "copy-folder",
    null,
    "remove",
  ]);
});
