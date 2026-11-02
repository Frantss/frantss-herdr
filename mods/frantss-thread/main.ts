import type { AsyncContext, FocusHandle } from "gpui-kit";
// A new thread in a workspace, as Codex starts one: Local runs it in the workspace's own checkout (a
// new tab there), Worktree in a new git worktree of it (Herdr's worktree dialog, which opens it as a
// space). Props: { space, folder, machine, repo, targetLabel, checkout } — repo: the folder is in git,
// so Worktree is offered; no space: a workspace with nothing open, so Local opens a space in its
// folder; targetLabel (else checkout) names the folder shown above the choices. Keys as in
// menu-list.ts.

import type { VirtualListScrollHandle as ScrollHandle } from "gpui-base";
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, VirtualListScrollHandle } from "gpui-base";
import { agentArgv } from "./agent-launch.ts";
import { cachedAgents, refreshAgents, type KnownAgent } from "./known-agents.ts";
import {
  listCommand,
  menuList,
  menuRow,
  scrollToKey,
  selectedKey,
  separator,
  ROW_HEIGHT,
  SEPARATOR_HEIGHT,
  type ListEntry,
} from "./menu-list.ts";
import { theme, run, openOverlay, closeOverlay, props } from "herdr";

// The popup's most (the rail opens it this tall).
const THREAD_HEIGHT = 420;
const TARGET_HEIGHT = 36;
const HEADING_HEIGHT = 22;

type ThreadAgent = Pick<KnownAgent, "key" | "name" | "icon" | "tint"> & { run: string[] | null };
type Theme = Record<string, `#${string}`>;
type Choice = { key: string; agent: ThreadAgent; action: (agent: ThreadAgent) => unknown };

const TERMINAL: ThreadAgent = {
  key: "terminal",
  name: "Terminal",
  icon: "icons/shell.svg",
  tint: true,
  run: null,
};

const CHECKOUT_LABELS: Record<string, string> = {
  main: "Main checkout",
  linked: "Linked worktree",
};

export default class Thread extends View {
  declare agents: KnownAgent[];
  declare handle: FocusHandle;
  declare failed: boolean;
  // The selected row's key ("local-codex"), so the selection stays put when the agents load.
  declare selected: string | null;
  declare scroll: ScrollHandle;
  init(_props: unknown, cx: AsyncContext) {
    const machine = props()?.machine ?? "";
    this.agents = cachedAgents(machine).filter((a) => a.installed);
    this.selected = null;
    this.handle = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    this.handle.focus();
    cx.spawn(async (cx) => {
      try {
        this.agents = (await refreshAgents(machine)).filter((a) => a.installed);
      } catch {
        this.failed = true;
      }
      cx.notify();
    });
  }

  async close() {
    this.scroll?.release();
  }

  local(agent: ThreadAgent) {
    const { space, folder, machine } = props(),
      argv = agent.run ? { argv: agentArgv(agent.run) } : {};
    closeOverlay(props().overlay);
    if (!space) return run("space.new", { folder, machine: machine ?? "", ...argv });
    run("space.select", { id: space });
    // The shown folder, not wherever the space's focused pane is.
    run("tab.new", { space, ...(folder ? { folder } : {}), ...argv });
  }

  worktree(agent: ThreadAgent) {
    const { space, folder, machine } = props();
    closeOverlay(props().overlay);
    // The worktree dialog takes a space, or a folder and machine for a repo without one.
    openOverlay({
      mod: "worktree",
      kind: "dialog",
      width: 460,
      height: 280,
      props: {
        ...(space ? { space } : { machine: machine ?? null }),
        folder,
        action: "new",
        ...(agent.run ? { argv: agentArgv(agent.run) } : {}),
      },
    });
  }

  sections() {
    const agents = [TERMINAL, ...this.agents];
    const section = (kind: string, action: Choice["action"]) =>
      agents.map((agent): Choice => ({ key: `${kind}-${agent.key}`, agent, action }));
    return {
      local: section("local", (a) => this.local(a)),
      worktree: props()?.repo ? section("worktree", (a) => this.worktree(a)) : [],
    };
  }

  // Where Local starts the thread: the target's name, its folder, and its machine when remote, in
  // TARGET_HEIGHT; cut-off text is whole in the tooltip and the accessible name.
  target(t: Theme) {
    const { folder, machine, targetLabel, checkout } = props() ?? {};
    const label = targetLabel ?? CHECKOUT_LABELS[checkout];
    const name = [label, machine && `on ${machine}`].filter(Boolean).join(" ");
    if (!folder && !name) return null;
    const whole = [name, folder].filter(Boolean).join(": ");
    return v_flex()
      .id("thread-target")
      .h(TARGET_HEIGHT)
      .flex_none()
      .px(6)
      .justify_center()
      .gap(1)
      .role("label")
      .accessibility_label(whole)
      .tooltip(whole)
      .when(Boolean(name), (el) =>
        el.child(div().text_size(11).text_color(t.foreground).min_w(0).truncate().child(name)),
      )
      .when(Boolean(folder), (el) =>
        el.child(
          div()
            .text_size(11)
            .text_color(t.dim)
            .min_w(0)
            .overflow_hidden()
            .whitespace_nowrap()
            .text_ellipsis_start()
            .child(folder),
        ),
      );
  }

  render() {
    const t = theme() as Theme;
    const { local, worktree } = this.sections();
    const choices = [...local, ...worktree];
    const keys = choices.map((c) => c.key);
    const selected = selectedKey(keys, this.selected);
    const target = this.target(t);
    const heading = (title: string): ListEntry => ({
      key: `heading-${title}`,
      height: HEADING_HEIGHT,
      draw: () =>
        h_flex()
          .h(HEADING_HEIGHT)
          .px(6)
          .pb(2)
          .items_end()
          .text_size(10)
          .text_color(t.dim)
          .role("heading")
          .accessibility_label(title)
          .child(title),
    });
    const rows = (section: Choice[]) =>
      section.map((c): ListEntry => ({
        key: c.key,
        height: ROW_HEIGHT,
        draw: () =>
          menuRow(t, {
            id: c.key,
            label: c.agent.name,
            selected: c.key === selected,
            position: keys.indexOf(c.key) + 1,
            size: keys.length,
            icon: c.agent.tint
              ? svg(c.agent.icon).size(13).text_color(t.dim)
              : image(c.agent.icon).size(13),
          }),
      }));
    const entries: ListEntry[] = [
      heading("LOCAL"),
      ...rows(local),
      ...(worktree.length
        ? [
            { key: "separator", height: SEPARATOR_HEIGHT, draw: () => separator(t) },
            heading("WORKTREE"),
            ...rows(worktree),
          ]
        : []),
      ...(this.failed && !this.agents.length
        ? [
            {
              key: "failed",
              height: ROW_HEIGHT,
              draw: () =>
                h_flex()
                  .h(ROW_HEIGHT)
                  .px(6)
                  .items_center()
                  .text_color(t.dim)
                  .child("Could not load agents"),
            },
          ]
        : []),
    ];
    const choose = (key: string) => {
      const choice = choices.find((c) => c.key === key);
      choice?.action(choice.agent);
    };
    // A popup doesn't block presses: stop them before a click lands on what is behind it.
    return (
      v_flex()
        .id("thread")
        .role("menu")
        .accessibility_label("New thread")
        .track_focus(this.handle)
        .w_full()
        .min_h(0)
        .p(4)
        .bg(t.popover)
        .text_size(12)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
        .on_key_down((e, cx) => {
          const command = listCommand(e, keys, selected);
          if (!command) return;
          cx.stop_propagation();
          if ("close" in command) closeOverlay(props()?.overlay);
          else if ("choose" in command) choose(command.choose);
          else {
            this.selected = command.select;
            scrollToKey(this.scroll, entries, command.select);
            cx.notify();
          }
        })
        .when(Boolean(target), (el) => el.child(target).child(separator(t)))
        // Taller than the popup (many agents), the choices scroll.
        .child(
          menuList(
            "thread-choices",
            entries,
            THREAD_HEIGHT - 2 * 4 - (target ? TARGET_HEIGHT + SEPARATOR_HEIGHT : 0),
            this.scroll,
            choose,
          ),
        )
    );
  }
}
