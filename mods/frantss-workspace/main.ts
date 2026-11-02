import type { AsyncContext, Context, FocusHandle } from "gpui-kit";
// A workspace's menu in the frantss rail. Props: { folder, saved }. Keeping adds the folder to the
// workspaces the rail remembers (workspaces.ts); removing only forgets it, its spaces stay. Keys as
// in menu-list.ts.

import { View } from "gpui-kit";
import { v_flex } from "gpui-base";
import { theme, run, closeOverlay, props, setShared } from "herdr";
import { savedWorkspaces, WORKSPACES, type SavedWorkspace } from "./workspaces.ts";
import { listCommand, menuRow, selectedKey, separator } from "./menu-list.ts";

type WorkspaceAction = (folder: string, list: SavedWorkspace[]) => unknown;
type Choice = { key: string; label: string; action: WorkspaceAction };

const choices = (): Choice[] => [
  { key: "new-space", label: "New space", action: (folder) => run("space.new", { folder }) },
  props()?.saved
    ? {
        key: "remove",
        label: "Remove workspace",
        action: (folder, list) =>
          setShared(
            WORKSPACES,
            list.filter((w) => w.folder !== folder),
          ),
      }
    : {
        key: "keep",
        label: "Keep as workspace",
        action: (folder, list) => setShared(WORKSPACES, [...list, { folder }]),
      },
];

export default class Workspace extends View {
  declare handle: FocusHandle;
  declare selected: string | null;
  init(_props: unknown, cx: AsyncContext) {
    this.selected = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  act(action: WorkspaceAction) {
    closeOverlay(props()?.overlay);
    action(props()?.folder, savedWorkspaces());
  }

  render() {
    const t = theme() as Record<string, `#${string}`>;
    const list = choices();
    const keys = list.map((c) => c.key);
    const selected = selectedKey(keys, this.selected);
    const row = (c: Choice, i: number) =>
      menuRow(t, {
        id: c.key,
        label: c.label,
        selected: c.key === selected,
        choose: () => this.act(c.action),
        position: i + 1,
        size: list.length,
      });
    // A popup doesn't block presses: stop them before a click lands on what is behind it.
    return v_flex()
      .id("workspace")
      .role("menu")
      .accessibility_label("Workspace menu")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(4)
      .bg(t.popover)
      .text_size(12)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
      .on_key_down((e, cx: Context) => {
        const command = listCommand(e, keys, selected);
        if (!command) return;
        cx.stop_propagation();
        if ("close" in command) closeOverlay(props()?.overlay);
        else if ("choose" in command) this.act(list.find((c) => c.key === command.choose).action);
        else {
          this.selected = command.select;
          cx.notify();
        }
      })
      .child(row(list[0], 0))
      .child(separator(t))
      .child(row(list[1], 1));
  }
}
