import type { AsyncContext, FocusHandle } from "gpui-kit";
// Opens a workspace's folder in another app, from the frantss breadcrumb. Props: { folder }.
// Only the apps installed on this machine are listed.

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, exec, closeOverlay, props, shared, setShared } from "herdr";
import { appIcon, installedApps, INSTALLED, knownApps, openArgs, type App } from "./apps.ts";

export default class Open extends View {
  declare installed: App[];
  declare handle: FocusHandle;
  init(_props: unknown, cx: AsyncContext) {
    const known = shared(INSTALLED);
    this.installed = knownApps(known);
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async (cx) => {
      this.installed = await installedApps(exec);
      const keys = this.installed.map((a) => a.key);
      if (JSON.stringify(keys) !== JSON.stringify(known)) setShared(INSTALLED, keys);
      cx.notify();
    });
  }

  open(app: App) {
    closeOverlay(props()?.overlay);
    void exec("open", openArgs(app, props()?.folder));
  }

  // Like frantss-menu's rows: 24px, 3px corners, muted until hovered.
  row(t: Record<string, `#${string}`>, app: App) {
    return h_flex()
      .id(app.key)
      .h(24)
      .px(6)
      .gap(8)
      .rounded(3)
      .items_center()
      .flex_none()
      .cursor_pointer()
      .text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(() => this.open(app))
      .child(image(appIcon(app)).size(14).flex_none())
      .child(div().flex_1().min_w(0).truncate().child(app.name));
  }

  render() {
    const t = theme() as Record<string, `#${string}`>;
    return v_flex()
      .id("open")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(4)
      .bg(t.popover)
      .text_size(12)
      .on_key_down((e) => {
        if (e.key === "escape") closeOverlay(props()?.overlay);
      })
      .child(
        div().h(24).px(6).flex().items_center().text_size(11).text_color(t.dim).child("Open in"),
      )
      .children(this.installed.map((app) => this.row(t, app)));
  }
}
