import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  TOOLBAR_HEIGHT,
  fitSnapshot,
  overlayState,
  paneOrigin,
  paneShown,
  sizeChanged,
} from "./placement.ts";

const placed = {
  window: { x: 0, y: 34 },
  origin: { x: 600, y: 120 },
  pane: { width: 400, height: 800 },
  shown: true,
  connected: true,
  herdrActive: true,
};

test("the pane origin is the pointer's window position minus its local position", () => {
  assert.deepEqual(
    paneOrigin({ position: { x: 700, y: 300 }, local_position: { x: 100, y: 180 } }),
    {
      x: 600,
      y: 120,
    },
  );
});

test("the overlay covers the page area below the toolbar, in screen coordinates", () => {
  assert.deepEqual(overlayState(placed), {
    visible: true,
    herdrActive: true,
    x: 600,
    y: 34 + 120 + TOOLBAR_HEIGHT,
    width: 400,
    height: 800 - TOOLBAR_HEIGHT,
  });
});

test("the overlay hides until the origin is known, while hidden, and without a browser", () => {
  assert.equal(overlayState({ ...placed, origin: null }).visible, false);
  assert.equal(overlayState({ ...placed, shown: false }).visible, false);
  assert.equal(overlayState({ ...placed, connected: false }).visible, false);
  assert.equal(
    overlayState({ ...placed, pane: { width: 400, height: TOOLBAR_HEIGHT } }).visible,
    false,
  );
});

test("only a real resize forgets the origin", () => {
  assert.equal(sizeChanged(null, { width: 1, height: 1 }), false);
  assert.equal(sizeChanged({ width: 1, height: 1 }, { width: 1, height: 1 }), false);
  assert.equal(sizeChanged({ width: 1, height: 1 }, { width: 2, height: 1 }), true);
});

test("the pane is shown only in the focused tab and not behind another pane's zoom", () => {
  const browser = { pane: "p1", tab: "t1", mod: "frantss-browser" };
  const terminal = { pane: "p2", tab: "t1", mod: null };
  assert.equal(paneShown([terminal, browser], "t1", "frantss-browser"), true);
  assert.equal(paneShown([terminal, browser], "t2", "frantss-browser"), false);
  assert.equal(paneShown([{ ...terminal, zoomed: true }, browser], "t1", "frantss-browser"), false);
  assert.equal(paneShown([terminal, { ...browser, zoomed: true }], "t1", "frantss-browser"), true);
  assert.equal(paneShown([terminal], "t1", "frantss-browser"), false);
});

test("a snapshot shrinks to fit and is centered, but is never enlarged", () => {
  assert.deepEqual(fitSnapshot({ width: 200, height: 400 }, { width: 400, height: 400 }), {
    x: 0,
    y: 100,
    width: 200,
    height: 200,
  });
  assert.deepEqual(fitSnapshot({ width: 600, height: 600 }, { width: 400, height: 200 }), {
    x: 100,
    y: 200,
    width: 400,
    height: 200,
  });
});
