import type { AsyncContext, FocusHandle } from "gpui-kit";
// A new thread in a workspace, as Codex starts one: Local runs it in the workspace's own checkout (a
// new tab there), Worktree in a new git worktree of it (Herdr's worktree dialog, which opens it as a
// space). Props: { space, folder, machine, repo } — repo: the folder is in git, so Worktree is offered;
// no space: a workspace with nothing open, so Local opens a space in its folder.

import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agentArgv } from "./agent-launch.ts";
import {
  theme,
  knownAgents,
  run,
  openOverlay,
  closeOverlay,
  props,
  shared,
  setShared,
} from "herdr";

// The agents each machine has ("" for this one), kept in shared state (persisted) so this opens at once
// with last time's list while it asks again; frantss-new-menu and frantss-thread share it.
type KnownAgent = Awaited<ReturnType<typeof knownAgents>>[number];
type ThreadAgent = Pick<KnownAgent, "key" | "name" | "icon" | "tint"> & { run: string[] | null };
type Theme = Record<string, `#${string}`>;

const AGENTS = "frantss.agents";
async function refreshAgents(machine: string) {
  const agents = await knownAgents({ on: machine || null });
  const known = (shared(AGENTS) as Record<string, KnownAgent[]> | null) ?? {};
  if (JSON.stringify(agents) !== JSON.stringify(known[machine]))
    setShared(AGENTS, { ...known, [machine]: agents });
  return agents;
}

const TERMINAL: ThreadAgent = {
  key: "terminal",
  name: "Terminal",
  icon: "icons/shell.svg",
  tint: true,
  run: null,
};

export default class Thread extends View {
  declare agents: KnownAgent[];
  declare handle: FocusHandle;
  declare failed: boolean;
  init(_props: unknown, cx: AsyncContext) {
    const machine = props()?.machine ?? "";
    this.agents = ((shared(AGENTS) as Record<string, KnownAgent[]> | null)?.[machine] ?? []).filter(
      (a) => a.installed,
    );
    this.handle = cx.focus_handle();
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

  local(agent: ThreadAgent) {
    const { space, folder } = props(),
      argv = agent.run ? { argv: agentArgv(agent.run) } : {};
    closeOverlay(props().overlay);
    if (!space) return run("space.new", { folder, ...argv });
    run("space.select", { id: space });
    run("tab.new", { space, ...argv });
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

  // Like frantss-menu's rows: 24px, 3px corners, muted until hovered.
  row(t: Theme, id: string, agent: ThreadAgent, action: (agent: ThreadAgent) => unknown) {
    const icon = agent.tint
      ? svg(agent.icon).size(13).text_color(t.dim)
      : image(agent.icon).size(13);
    return h_flex()
      .id(id)
      .h(24)
      .px(6)
      .gap(8)
      .rounded(3)
      .items_center()
      .flex_none()
      .cursor_pointer()
      .text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(() => action(agent))
      .child(div().w(10).flex_none())
      .child(icon)
      .child(div().flex_1().min_w(0).truncate().child(agent.name));
  }

  section(t: Theme, title: string, kind: string, action: (agent: ThreadAgent) => unknown) {
    return v_flex()
      .gap(2)
      .child(div().px(6).pt(6).pb(2).text_size(10).text_color(t.dim).child(title))
      .children([TERMINAL, ...this.agents].map((a) => this.row(t, `${kind}-${a.key}`, a, action)));
  }

  render() {
    const t = theme() as Record<string, `#${string}`>;
    // A popup doesn't block presses: stop them before a click lands on what is behind it.
    return v_flex()
      .id("thread")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(4)
      .bg(t.popover)
      .text_size(12)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
      .on_key_down((e) => {
        if (e.key === "escape") closeOverlay(props()?.overlay);
      })
      .child(this.section(t, "LOCAL", "local", (a) => this.local(a)))
      .when(Boolean(props()?.repo), (el) =>
        el
          .child(div().h(1).mx(4).my(4).bg(t.border))
          .child(this.section(t, "WORKTREE", "worktree", (a) => this.worktree(a))),
      )
      .when(this.failed && !this.agents.length, (el) =>
        el.child(div().px(6).py(6).text_color(t.dim).child("Could not load agents")),
      );
  }
}
