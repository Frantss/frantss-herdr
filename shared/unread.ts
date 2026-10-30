// Agents you marked unread. Herdr's core owns agent status and has no way to set it, so the mark is
// kept in shared state (persisted) and the frantss rail lists a marked idle agent as done (UNREAD).
// Mods can't import outside their own folder, so each mod that uses it links this file as ./unread.ts.
import { setShared, shared } from "herdr";

type Agent = { address: string; status: string; focused: boolean };

const UNREAD = "frantss.unread";
export const unreadAgents = () => (shared(UNREAD) as string[] | null) ?? [];

export function markUnread(address: string) {
  if (!unreadAgents().includes(address)) setShared(UNREAD, [...unreadAgents(), address]);
}

// The marks that stay: an agent stays unread while it is idle and until you go to it. Marking the
// agent you are on keeps it unread until you leave it and come back, as Herdr's done does.
export function keptUnread(marks: string[], list: Agent[], focusedBefore: string | null) {
  return marks.filter((address) => {
    const agent = list.find((a) => a.address === address);
    return agent?.status === "idle" && !(agent.focused && address !== focusedBefore);
  });
}

export const shownStatus = (agent: Agent, marks: string[]) =>
  agent.status === "idle" && marks.includes(agent.address) ? "done" : agent.status;

// Writes only when the marks change: a shared write re-renders every mod.
export function keepUnread(list: Agent[], focusedBefore: string | null) {
  const marks = unreadAgents();
  const kept = keptUnread(marks, list, focusedBefore);
  if (kept.length !== marks.length) setShared(UNREAD, kept);
  return kept;
}
