// A workspace's menu in the frantss rail. Props: { folder, saved }. Keeping adds the folder to the
// workspaces the rail remembers (shared "frantss.workspaces"); removing only forgets it, its spaces stay.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, run, closeOverlay, props, shared, setShared } from "herdr";

const WORKSPACES = "frantss.workspaces";

export default class Workspace extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  act(action) {
    closeOverlay(props()?.overlay);
    action(props()?.folder, shared(WORKSPACES) ?? []);
  }

  // Like frantss-menu's rows: 24px, 3px corners, muted until hovered.
  row(t, id, text, action) {
    return h_flex().id(id).h(24).px(6).gap(8).rounded(3).items_center().flex_none().cursor_pointer()
      .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(() => this.act(action))
      .child(div().w(10).flex_none())
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  render() {
    const t = theme();
    return v_flex().id("workspace").track_focus(this.handle).w_full().min_h(0).p(4).bg(t.popover).text_size(12)
      .on_key_down((e) => { if (e.key === "escape") closeOverlay(props()?.overlay); })
      .child(this.row(t, "new-space", "New space", (folder) => run("space.new", { folder })))
      .child(div().h(1).mx(4).my(4).bg(t.border))
      .child(props()?.saved
        ? this.row(t, "remove", "Remove workspace", (folder, list) => setShared(WORKSPACES, list.filter((w) => w.folder !== folder)))
        : this.row(t, "keep", "Keep as workspace", (folder, list) => setShared(WORKSPACES, [...list, { folder }])));
  }
}
