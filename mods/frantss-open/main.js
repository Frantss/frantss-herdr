// Opens a workspace's folder in another app, from the frantss breadcrumb. Props: { folder }.
// Only the apps installed on this machine are listed.

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, exec, closeOverlay, props, shared, setShared } from "herdr";

// `app`: the name `open -a` takes.
const APPS = [
  { key: "finder", name: "Finder", app: "Finder" },
  { key: "terminal", name: "Terminal", app: "Terminal" },
  { key: "ghostty", name: "Ghostty", app: "Ghostty" },
  { key: "vscode", name: "VS Code", app: "Visual Studio Code" },
  { key: "zed", name: "Zed", app: "Zed" },
];

// The keys of the apps found last time, kept in shared state (persisted) so the menu opens at once
// while it looks again.
const INSTALLED = "frantss.apps";

export default class Open extends View {
  init(_props, cx) {
    const known = shared(INSTALLED) ?? [];
    this.installed = APPS.filter((a) => known.includes(a.key));
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async (cx) => {
      // `open -Ra` finds an app without opening it, and fails when there is none.
      const found = await Promise.all(
        APPS.map((a) =>
          exec("open", ["-Ra", a.app]).then(
            (r) => r.code === 0,
            () => false,
          ),
        ),
      );
      this.installed = APPS.filter((_a, i) => found[i]);
      const keys = this.installed.map((a) => a.key);
      if (JSON.stringify(keys) !== JSON.stringify(known)) setShared(INSTALLED, keys);
      cx.notify();
    });
  }

  open(app) {
    closeOverlay(props()?.overlay);
    exec("open", ["-a", app.app, props()?.folder]);
  }

  // Like frantss-menu's rows: 24px, 3px corners, muted until hovered.
  row(t, app) {
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
      .child(image(`mods/frantss-open/icons/${app.key}.png`).size(14).flex_none())
      .child(div().flex_1().min_w(0).truncate().child(app.name));
  }

  render() {
    const t = theme();
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
