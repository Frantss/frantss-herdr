// The frantss popup menus' rows and keys: Up/Down move (wrapping), Home/End jump, Enter/Space
// choose, Escape closes. The selection is a row's key, so it stays on the same row when rows load
// or move. Mods link this file as ./menu-list.ts.
import type { Color, Context, Element, KeyEvent } from "gpui-kit";
import type { VirtualListScrollHandle } from "gpui-base";
import { div } from "gpui-kit";
import { h_flex, v_flex, v_virtual_list, Scrollbar } from "gpui-base";

export type ListCommand = { select: string } | { choose: string } | { close: true };

// The selected row's key, else the first row's (null: no rows).
export function selectedKey(keys: string[], selected: string | null): string | null {
  return selected !== null && keys.includes(selected) ? selected : (keys[0] ?? null);
}

// What a key press does to a list of choosable rows; null for a key the list leaves alone.
export function listCommand(
  event: Pick<KeyEvent, "key"> & { modifiers?: Partial<KeyEvent["modifiers"]> },
  keys: string[],
  selected: string | null,
): ListCommand | null {
  const held = event.modifiers;
  if (held?.control || held?.platform || held?.alt) return null;
  if (event.key === "escape") return { close: true };
  const current = selectedKey(keys, selected);
  if (current === null) return null;
  if (event.key === "enter" || event.key === "space") return { choose: current };
  const at = keys.indexOf(current),
    last = keys.length - 1;
  const next =
    event.key === "down"
      ? at === last
        ? 0
        : at + 1
      : event.key === "up"
        ? at === 0
          ? last
          : at - 1
        : event.key === "home"
          ? 0
          : event.key === "end"
            ? last
            : -1;
  return next < 0 ? null : { select: keys[next] };
}

export const ROW_HEIGHT = 24;
export const SEPARATOR_HEIGHT = 9;

// A line between groups of rows, SEPARATOR_HEIGHT tall.
export const separator = (t: Record<string, Color>) => div().mx(4).my(4).h(1).bg(t.border);

export type MenuRow = {
  id: string;
  label: string;
  selected: boolean;
  // Omitted inside a menuList, whose rows take no handlers: the list reports the press.
  choose?: (cx: Context) => unknown;
  // One-based place among the choosable rows, announced as "2 of 5".
  position: number;
  size: number;
  icon?: Element;
  hint?: string;
};

// ROW_HEIGHT, 3px corners, muted until hovered or selected; ❯ marks the selected row.
export function menuRow(t: Record<string, Color>, row: MenuRow) {
  return h_flex()
    .id(row.id)
    .role("menu_item")
    .accessibility_label(row.label)
    .set_position(row.position, row.size)
    .when(row.selected, (el) => el.aria_active_descendant().bg(t.selected))
    .h(ROW_HEIGHT)
    .px(6)
    .gap(8)
    .rounded(3)
    .items_center()
    .flex_none()
    .cursor_pointer()
    .text_color(row.selected ? t.foreground : t.muted)
    .hover((s) => s.bg(t.hover).text_color(t.foreground))
    .when(Boolean(row.choose), (el) => el.on_click((_e, cx) => row.choose(cx)))
    .child(
      div()
        .w(10)
        .flex_none()
        .text_color(t.accent)
        .child(row.selected ? "❯" : ""),
    )
    .when(Boolean(row.icon), (el) => el.child(row.icon))
    .child(div().flex_1().min_w(0).truncate().child(row.label))
    .when(Boolean(row.hint), (el) =>
      el.child(div().flex_none().text_size(11).text_color(t.dim).child(row.hint)),
    );
}

// One entry of a menuList: `draw` builds what fills `height` px (a row, a heading, a separator).
export type ListEntry = { key: string; height: number; draw: () => Element };

// A popup's entries in a native virtual list, as tall as they are up to `maxHeight`, then scrolling.
// GPUI draws its rows lazily and they take no handlers, so a press reaches `choose(key)` from the
// list itself. `scroll` is the view's own handle: made in init, released in close.
export function menuList(
  id: string,
  entries: ListEntry[],
  maxHeight: number,
  scroll: VirtualListScrollHandle,
  choose: (key: string, cx: Context) => unknown,
) {
  const height = Math.min(
    maxHeight,
    entries.reduce((sum, entry) => sum + entry.height, 0),
  );
  return v_flex()
    .relative()
    .flex_none()
    .h(height)
    .child(
      v_virtual_list(
        id,
        entries.length,
        entries.map((entry) => entry.height),
        (index) => entries[index].key,
        (range) =>
          entries
            .slice(range.start, range.end)
            .map((entry) => v_flex().h(entry.height).flex_none().child(entry.draw())),
      )
        .size_full()
        .track_scroll(scroll)
        .on_item_click((key, cx) => choose(key, cx)),
    )
    .child(Scrollbar.vertical(id).absolute().inset_0());
}

// Brings the newly selected entry on screen, at the list's near edge (scroll_to_item's "top").
export function scrollToKey(scroll: VirtualListScrollHandle, entries: ListEntry[], key: string) {
  const index = entries.findIndex((entry) => entry.key === key);
  if (index >= 0) scroll.scroll_to_item(index);
}
