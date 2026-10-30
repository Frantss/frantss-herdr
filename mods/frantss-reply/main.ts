// Answers an agent without going to it. Opened as a dialog with props { terminal }: shows the last lines
// of its screen, where its question is, and sends a reply or presses Enter or Esc for you.
// Enter in the field sends, Esc closes.

import type { AsyncContext, Context, FocusHandle } from "gpui-kit";
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { agents, closeOverlay, props, theme } from "herdr";
import { hcOrToast, readQuestion, replyArgs } from "./agent-hc.ts";
import { button } from "./button.ts";

const LINES = 8;

const terminalOf = (): string => props()?.terminal ?? "";

type Theme = Record<string, `#${string}`>;

export default class Reply extends View {
  declare handle: FocusHandle;
  declare input: InputState;
  declare lines: string[] | null;
  declare text: string;

  init(_props: unknown, cx: AsyncContext) {
    this.handle = cx.focus_handle();
    this.lines = null;
    this.text = "";
    this.input = InputState.new({ placeholder: "Reply" });
    this.input.on("change", (_e, cx) => {
      this.text = this.input.value();
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.send(cx));
    this.input.focus();
    cx.spawn(async (cx) => {
      this.lines = await readQuestion(terminalOf(), LINES).catch(() => [
        "Could not read the screen",
      ]);
      cx.notify();
    });
  }

  // Closes first, then runs the hc command in the background.
  run(args: string[], failure: string, cx: Context) {
    closeOverlay(props().overlay);
    cx.spawn(() => hcOrToast(args, failure));
  }

  send(cx: Context) {
    const text = this.text.trim();
    if (text) this.run(replyArgs(terminalOf(), text), "Could not send the reply", cx);
  }

  render(_cx: Context) {
    const t = theme() as Theme;
    const terminal = terminalOf();
    const agent = agents().find((a) => a.address === terminal);
    const name = agent ? agent.title || agent.program.name : terminal;
    const key = (id: string, label: string, tooltip: string) =>
      button(id, label, (cx) => this.run(["keys", terminal, id], `Could not press ${label}`, cx), {
        tooltip,
      });
    return v_flex()
      .id("reply")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        closeOverlay(props().overlay);
        cx.stop_propagation();
      })
      .size_full()
      .min_h(0)
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(12)
      .text_color(t.foreground)
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(14).child(`Reply to ${name}`))
          .child(div().text_size(11).text_color(t.dim).child("Esc")),
      )
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .justify_end()
          .p(8)
          .rounded(3)
          .bg(t.background)
          .text_size(11)
          .text_color(t.muted)
          .children(
            (this.lines ?? ["Reading the screen…"]).map((line) =>
              div()
                .truncate()
                .child(line || " "),
            ),
          ),
      )
      .child(
        div()
          .id("reply-field")
          .h(34)
          .px(10)
          .flex()
          .items_center()
          .rounded(3)
          .border_1()
          .border_color(t.accent)
          .bg(t.background)
          .cursor_text()
          .child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)),
      )
      .child(
        h_flex()
          .gap(8)
          .child(key("enter", "Enter", "Press Enter: picks the selected choice"))
          .child(key("esc", "Esc", "Press Esc: cancels the question"))
          .child(div().flex_1())
          .child(
            button("send", "Send", (cx) => this.send(cx), {
              variant: "primary",
              disabled: !this.text.trim(),
            }),
          ),
      );
  }
}
