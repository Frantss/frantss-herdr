import type { AsyncContext, Color, Context } from "gpui-kit";
import type { Point, Size } from "./placement.ts";

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, panes, focused, appHome, exec } from "herdr";
import { WebSocket } from "websocket";
import * as fs from "fs/promises";
import { Buffer } from "buffer";
import { CdpSession, pageSocketUrl, type CdpEvent } from "./cdp.ts";
import {
  CDP_PORT,
  CONTROL_PORT,
  TOOLBAR_HEIGHT,
  fitSnapshot,
  overlayState,
  pageArea,
  paneOrigin,
  paneShown,
  sizeChanged,
} from "./placement.ts";

// The page itself is a Chromium window (companion/main.ts) kept over this pane's page area.
// While that window is away, the page area shows the last screenshot of the page.

type Theme = Record<string, Color>;

const MOD = "frantss-browser";
const SNAPSHOTS = "data/frantss-browser-snapshots";
const RECONNECT_MS = 2000;
const REPORT_MS = 100;

/** The checkout this mod was installed from, which holds the companion and Electron. */
async function checkout() {
  const dist = await fs.readFile(`${appHome()}/mods/${MOD}/.frantss-herdr`, "utf8");
  return dist.trim().replace(/\/dist\/?$/, "");
}

async function startCompanion() {
  const root = await checkout();
  // How the electron package itself finds its binary.
  const binary = await fs.readFile(`${root}/node_modules/electron/path.txt`, "utf8");
  await exec("/bin/sh", [
    "-c",
    'nohup "$0" "$1" >/dev/null 2>&1 &',
    `${root}/node_modules/electron/dist/${binary.trim()}`,
    `${root}/mods/${MOD}/companion/main.ts`,
  ]);
}

export default class Browser extends View {
  declare cdp: CdpSession | null;
  declare url: string;
  declare loading: boolean;
  declare origin: Point | null;
  declare pane: Size | null;
  declare snapshot: { path: string; size: Size } | null;
  declare snapshotCount: number;
  declare wasVisible: boolean;
  declare reported: string;
  declare starting: boolean;

  init(_props: unknown, cx: AsyncContext) {
    this.cdp = null;
    this.url = "";
    this.loading = false;
    this.origin = null;
    this.pane = null;
    this.snapshot = null;
    this.snapshotCount = 0;
    this.wasVisible = false;
    this.reported = "";
    this.starting = false;
    cx.timer.every(REPORT_MS, (cx) => this.report(cx));
    cx.spawn((cx) => this.connect(cx));
  }

  async close() {
    await fetch(`http://127.0.0.1:${CONTROL_PORT}/state`, {
      method: "POST",
      body: JSON.stringify({ visible: false }),
    }).catch(() => {});
  }

  async connect(cx: AsyncContext) {
    await fs.mkdir(`${appHome()}/${SNAPSHOTS}`, { recursive: true });
    let started = false;
    for (;;) {
      try {
        const page = await pageSocketUrl(CDP_PORT);
        if (!page) throw new Error("No page");
        const socket = await WebSocket.connect(page.socket);
        this.cdp = new CdpSession(socket, (event) => this.onPageEvent(event, cx));
        this.url = page.url;
        this.starting = false;
        cx.notify();
        void this.cdp.send("Page.enable");
        void this.capture(cx);
        for (;;) {
          const raw = await socket.read();
          this.cdp.receive(typeof raw === "string" ? raw : Buffer.from(raw).toString());
        }
      } catch {
        this.cdp?.close();
        this.cdp = null;
        if (!started) {
          started = true;
          void this.start(cx);
        }
        cx.notify();
        await cx.sleep(RECONNECT_MS);
      }
    }
  }

  async start(cx: AsyncContext | Context) {
    this.starting = true;
    cx.notify();
    await startCompanion().catch(() => {
      this.starting = false;
    });
  }

  onPageEvent(event: CdpEvent, cx: AsyncContext) {
    if (event.method === "Page.frameNavigated" && !event.params.frame.parentId)
      this.url = event.params.frame.url;
    else if (event.method === "Page.frameStartedLoading") this.loading = true;
    else if (event.method === "Page.frameStoppedLoading") {
      this.loading = false;
      void this.capture(cx);
    } else return;
    cx.notify();
  }

  async capture(cx: AsyncContext) {
    const metrics = await this.cdp?.send("Page.getLayoutMetrics");
    const shot = await this.cdp?.send("Page.captureScreenshot", { format: "jpeg", quality: 70 });
    if (!metrics || !shot?.data) return;
    // A new name each time, because images are cached by path.
    const path = `${SNAPSHOTS}/snapshot-${++this.snapshotCount}.jpg`;
    await fs.writeFile(`${appHome()}/${path}`, Buffer.from(shot.data, "base64"));
    const previous = this.snapshot?.path;
    const viewport = metrics.cssVisualViewport;
    this.snapshot = { path, size: { width: viewport.clientWidth, height: viewport.clientHeight } };
    if (previous) fs.unlink(`${appHome()}/${previous}`).catch(() => {});
    cx.notify();
  }

  async go(delta: number) {
    const history = await this.cdp?.send("Page.getNavigationHistory");
    const entry = history?.entries[history.currentIndex + delta];
    if (entry) void this.cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id });
  }

  report(cx: AsyncContext) {
    let bounds: Point | null = null;
    let herdrActive = false;
    try {
      // The generated ElementBounds type loses the x and y it inherits from Point.
      bounds = window.bounds() as unknown as Point;
      herdrActive = window.is_window_active();
    } catch {
      return;
    }
    const state = overlayState({
      window: bounds,
      origin: this.origin,
      pane: this.pane,
      shown: paneShown(panes(), focused()?.tab ?? null, MOD),
      connected: Boolean(this.cdp),
      herdrActive,
    });
    if (this.wasVisible && !state.visible) void this.capture(cx);
    this.wasVisible = state.visible;
    const body = JSON.stringify(state);
    if (body === this.reported) return;
    this.reported = body;
    fetch(`http://127.0.0.1:${CONTROL_PORT}/state`, { method: "POST", body }).catch(() => {});
  }

  button(t: Theme, id: string, icon: string, onClick: () => unknown) {
    return div()
      .id(id)
      .p(4)
      .rounded(4)
      .flex_none()
      .text_color(this.cdp ? t.dim : t.border)
      .when(Boolean(this.cdp), (el) =>
        el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)),
      )
      .on_click((_event, cx) => {
        cx.stop_propagation();
        if (this.cdp) onClick();
      })
      .child(svg(`mods/${MOD}/${icon}.svg`).size(13));
  }

  toolbar(t: Theme) {
    return h_flex()
      .h(TOOLBAR_HEIGHT)
      .flex_none()
      .px(6)
      .gap(2)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .text_size(12)
      .child(this.button(t, "back", "back", () => this.go(-1)))
      .child(this.button(t, "forward", "forward", () => this.go(1)))
      .child(this.button(t, "reload", "reload", () => this.cdp.send("Page.reload")))
      .child(
        div()
          .flex_1()
          .truncate()
          .px(6)
          .text_color(this.cdp ? t.foreground : t.dim)
          .child(this.cdp ? this.url : "Browser not running"),
      )
      .when(this.loading, (el) => el.child(div().flex_none().size(7).rounded(4).bg(t.working)));
  }

  notRunning(t: Theme) {
    return div()
      .flex_1()
      .flex()
      .flex_col()
      .items_center()
      .justify_center()
      .gap(10)
      .text_size(12)
      .text_color(t.dim)
      .child(svg(`mods/${MOD}/globe.svg`).size(28).text_color(t.border))
      .child(this.starting ? "Starting the browser…" : "The browser is not running")
      .when(!this.starting, (el) =>
        el.child(
          div()
            .id("start")
            .px(10)
            .py(4)
            .rounded(6)
            .border_1()
            .border_color(t.border)
            .text_color(t.foreground)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_click((_event, cx) => void this.start(cx))
            .child("Start browser"),
        ),
      )
      .child(div().text_size(11).child(`Agents connect with agent-browser --cdp ${CDP_PORT}`));
  }

  page(t: Theme) {
    if (!this.cdp) return this.notRunning(t);
    const area = pageArea(this.pane);
    const fit = this.snapshot && fitSnapshot(area, this.snapshot.size);
    return div()
      .flex_1()
      .relative()
      .overflow_hidden()
      .when(Boolean(fit), (el) =>
        el.child(
          image(this.snapshot.path)
            .absolute()
            .left(fit.x)
            .top(fit.y)
            .w(fit.width)
            .h(fit.height)
            .opacity(0.55),
        ),
      )
      .child(
        div()
          .absolute()
          .inset_0()
          .flex()
          .items_center()
          .justify_center()
          .child(
            div()
              .px(10)
              .py(4)
              .rounded(12)
              .bg(t.raised)
              .border_1()
              .border_color(t.border)
              .text_size(11)
              .text_color(t.foreground)
              .child("Point here to resume"),
          ),
      );
  }

  render() {
    const t = theme() as Theme;
    return div()
      .id("browser")
      .size_full()
      .flex()
      .flex_col()
      .bg(t.background)
      .on_size_change((size, cx) => {
        if (sizeChanged(this.pane, size)) this.origin = null;
        this.pane = size;
        cx.notify();
      })
      .on_mouse_move((event, cx) => {
        const origin = paneOrigin(event);
        if (origin.x === this.origin?.x && origin.y === this.origin?.y) return;
        this.origin = origin;
        cx.notify();
      })
      .child(this.toolbar(t))
      .child(this.page(t));
  }
}
