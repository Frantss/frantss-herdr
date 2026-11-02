// The workspaces the frantss rail remembers: folders on this machine, kept in shared state
// (persisted). Mods link this file as ./workspaces.ts.
import { shared } from "herdr";

export type SavedWorkspace = { folder: string };

export const WORKSPACES = "frantss.workspaces";

export function savedWorkspaces(): SavedWorkspace[] {
  return (shared(WORKSPACES) as SavedWorkspace[] | null) ?? [];
}
