// What an agent card's menu offers.

export type MenuAction =
  | "focus"
  | "peek"
  | "reply"
  | "interrupt"
  | "keep"
  | "park"
  | "copy-address"
  | "copy-folder"
  | "kill"
  | "remove";
export interface MenuItem {
  action: MenuAction;
  label: string;
  icon: string;
}

const chrome = (name: string) => `mods/workspace-chrome/${name}.svg`;
export const PEEK_ICON = "mods/github/eye.svg";
export const INTERRUPT_ICON = chrome("square");

// null separates groups. A finished terminal can only be copied or removed. A live one with a pane
// can give it back; one without (a sub-agent) can get one. Only outline cards have room for a reply.
export function menuItems(card: {
  live: boolean;
  pane: boolean;
  reply: boolean;
}): (MenuItem | null)[] {
  const item = (action: MenuAction, label: string, icon: string) => ({ action, label, icon });
  const copy = [
    item("copy-address", "Copy address", chrome("files")),
    item("copy-folder", "Copy folder", chrome("folder")),
  ];
  if (!card.live) return [...copy, null, item("remove", "Remove", "mods/frantss-files/trash.svg")];
  return [
    item("focus", "Go to", chrome("terminal")),
    item("peek", "Peek", PEEK_ICON),
    card.pane
      ? item("park", "Send back", chrome("pin-off"))
      : item("keep", "Keep as tab", chrome("pin")),
    null,
    ...(card.reply ? [item("reply", "Reply…", "mods/github/message.svg")] : []),
    item("interrupt", "Interrupt", INTERRUPT_ICON),
    null,
    ...copy,
    null,
    item("kill", "Kill", chrome("x")),
  ];
}
