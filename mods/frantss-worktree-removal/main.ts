import type { AsyncContext, FocusHandle } from "gpui-kit";
import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { closeOverlay, nextCommand, props, run, theme } from "herdr";
import { button } from "./button.ts";

type RemovalProps = {
  overlay: string;
  token?: string;
  paths?: string[];
  skipped?: { path: string; reason: string }[];
  command: { name: string };
};

export default class WorktreeRemoval extends View {
  declare dialogFocus: FocusHandle;
  declare listFocus: FocusHandle;
  declare cancelFocus: FocusHandle;
  declare removeFocus: FocusHandle;
  finished = false;
  paths: string[] | null = null;
  skipped: { path: string; reason: string }[] = [];
  error: string | null = null;

  init(_props: unknown, cx: AsyncContext) {
    this.dialogFocus = cx.focus_handle();
    this.listFocus = cx.focus_handle();
    this.cancelFocus = cx.focus_handle();
    this.removeFocus = cx.focus_handle();
    this.cancelFocus.focus();
    const p = (props() ?? {}) as RemovalProps;
    this.paths = p.token ? null : (p.paths ?? []);
    this.skipped = p.skipped ?? [];
    if (p.token)
      cx.spawn(async (cx) => {
        let next = nextCommand();
        run(`frantss.inspect-worktrees:${p.token}`);
        for (;;) {
          const command = await next;
          if (this.receive(command)) cx.notify();
          next = nextCommand();
        }
      });
  }

  receive(command: string): boolean {
    if (this.finished || !command.startsWith("result:")) return false;
    try {
      const result = JSON.parse(decodeURIComponent(command.slice("result:".length)));
      if (!result.token || result.token !== props()?.token) return false;
      this.paths = result.paths ?? [];
      this.skipped = result.skipped ?? [];
      this.error = result.error ?? null;
      return true;
    } catch {
      return false;
    }
  }

  finish(remove: boolean) {
    if (this.finished || (remove && (!this.paths?.length || this.error))) return;
    this.finished = true;
    const p = props() as RemovalProps;
    closeOverlay(p.overlay);
    if (remove) run(p.command.name);
    else if (p.token) run(`frantss.cancel-worktrees:${p.token}`);
  }

  close() {
    if (this.finished) return;
    this.finished = true;
    const token = props()?.token;
    if (token) run(`frantss.cancel-worktrees:${token}`);
  }

  render() {
    const t = theme() as Record<string, `#${string}`>;
    const checking = this.paths === null;
    const count = this.paths?.length ?? 0;
    const label =
      checking || this.error ? "worktrees" : `${count} worktree${count === 1 ? "" : "s"}`;
    const title = checking
      ? "Checking worktrees…"
      : this.error
        ? "Could not check worktrees"
        : count
          ? `Remove ${label}?`
          : "No eligible worktrees";
    const row = (path: string, reason?: string) => {
      const windows = /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\");
      const normalized = windows ? path.replace(/\\/g, "/") : path;
      const name = normalized.replace(/\/+$/, "").split("/").pop() || path;
      return v_flex()
        .min_w(0)
        .py(10)
        .gap(4)
        .border_b_1()
        .border_color(t.border)
        .child(div().font_medium().child(name))
        .child(div().min_w(0).text_size(11).text_color(t.muted).whitespace_normal().child(path))
        .when(Boolean(reason), (e) =>
          e.child(
            div()
              .text_size(12)
              .text_color(t.muted)
              .child(reason?.replace(/^Error:\s*/, "")),
          ),
        );
    };
    return v_flex()
      .id("worktree-removal-dialog")
      .role("alert_dialog")
      .accessibility_label(title)
      .track_focus(this.dialogFocus)
      .on_key_down((event, cx) => {
        if (event.key === "escape") this.finish(false);
        else if (event.key === "tab") {
          const order =
            checking || this.error
              ? [this.cancelFocus]
              : [this.listFocus, this.cancelFocus, ...(count ? [this.removeFocus] : [])];
          const index = order.findIndex((handle) => handle.is_focused());
          order[(index + (event.modifiers.shift ? -1 : 1) + order.length) % order.length].focus();
        } else if (event.key === "enter" || event.key === "space") {
          if (this.cancelFocus.is_focused()) this.finish(false);
          else if (this.removeFocus.is_focused() && count) this.finish(true);
          else return;
        } else return;
        cx.stop_propagation();
      })
      .size_full()
      .min_h(0)
      .p(24)
      .gap(18)
      .bg(t.popover)
      .text_color(t.foreground)
      .text_size(13)
      .child(
        v_flex()
          .flex_none()
          .gap(10)
          .child(div().text_size(18).font_semibold().child(title))
          .child(
            div().child(
              "Checkout folders and ignored files will be deleted. Git branches are kept.",
            ),
          ),
      )
      .child(
        v_flex()
          .id("worktree-removal-lists")
          .flex_1()
          .min_h(0)
          .min_w(0)
          .overflow_y_scrollbar()
          .when(!checking && !this.error, (e) => e.tab_index(0))
          .track_focus(this.listFocus)
          .accessibility_label("Worktrees to remove and keep")
          .focus((e) => e.border_1().border_color(t.accent))
          .gap(20)
          .when(checking, (e) =>
            e.child(
              div()
                .role("status")
                .text_color(t.muted)
                .child("Checking which worktrees can be removed. You can cancel while this runs."),
            ),
          )
          .when(Boolean(this.error), (e) =>
            e.child(
              div()
                .role("alert")
                .child(this.error?.replace(/^Error:\s*/, "")),
            ),
          )
          .when(!checking && !this.error, (e) =>
            e.child(
              v_flex()
                .min_w(0)
                .child(div().font_semibold().child(`Will remove (${count})`))
                .when(!count, (e) =>
                  e.child(div().py(10).text_color(t.muted).child("No eligible worktrees.")),
                )
                .children((this.paths ?? []).map((path) => row(path))),
            ),
          )
          .when(!checking && !this.error, (e) =>
            e.child(
              v_flex()
                .min_w(0)
                .child(div().font_semibold().child(`Will keep (${this.skipped.length})`))
                .when(!this.skipped.length, (e) =>
                  e.child(div().py(10).text_color(t.muted).child("No worktrees were skipped.")),
                )
                .children(this.skipped.map((item) => row(item.path, item.reason))),
            ),
          ),
      )
      .child(
        v_flex()
          .flex_none()
          .gap(14)
          .child(
            div()
              .text_size(12)
              .text_color(t.muted)
              .child(
                "Each checkout is checked again before removal. Protected or changed checkouts are skipped.",
              ),
          )
          .child(
            h_flex()
              .justify_end()
              .gap(8)
              .child(
                button("cancel-removal", "Cancel", () => this.finish(false), {
                  size: "regular",
                }).track_focus(this.cancelFocus),
              )
              .child(
                button("confirm-removal", `Remove ${label}`, () => this.finish(true), {
                  size: "regular",
                  variant: "primary",
                  disabled: checking || Boolean(this.error) || !count,
                }).track_focus(this.removeFocus),
              ),
          ),
      );
  }
}
