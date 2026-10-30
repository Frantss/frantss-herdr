// The mod cannot read its own position, so it learns the pane's origin from mouse events and
// forgets it whenever the pane is resized. The browser window only shows while that origin is known.

export const CDP_PORT = 9333;
export const CONTROL_PORT = 9334;
export const TOOLBAR_HEIGHT = 28;

export interface Point {
  x: number;
  y: number;
}
export interface Size {
  width: number;
  height: number;
}
export interface Rect extends Point, Size {}

/** What the companion needs to place its window: screen coordinates of the page area. */
export interface OverlayState extends Rect {
  visible: boolean;
  herdrActive: boolean;
}

export const paneOrigin = (event: { position: Point; local_position: Point }): Point => ({
  x: event.position.x - event.local_position.x,
  y: event.position.y - event.local_position.y,
});

export const sizeChanged = (before: Size | null, after: Size) =>
  Boolean(before) && (before.width !== after.width || before.height !== after.height);

export function pageArea(pane: Size | null): Size {
  return {
    width: pane?.width ?? 0,
    height: Math.max(0, (pane?.height ?? 0) - TOOLBAR_HEIGHT),
  };
}

export function overlayState(input: {
  window: Point | null;
  origin: Point | null;
  pane: Size | null;
  shown: boolean;
  connected: boolean;
  herdrActive: boolean;
}): OverlayState {
  const { window, origin, pane } = input;
  const area = pageArea(pane);
  const placed = Boolean(window && origin && pane && input.connected);
  return {
    visible: placed && input.shown && area.width > 0 && area.height > 0,
    herdrActive: input.herdrActive,
    x: placed ? window.x + origin.x : 0,
    y: placed ? window.y + origin.y + TOOLBAR_HEIGHT : 0,
    ...area,
  };
}

interface PaneLike {
  pane: string;
  tab: string;
  mod?: string | null;
  zoomed?: boolean;
}

/** Whether the first pane showing `mod` is on screen: in the focused tab and not behind a zoom. */
export function paneShown(panes: PaneLike[], focusedTab: string | null, mod: string) {
  const own = panes.find((p) => p.mod === mod);
  if (!own || own.tab !== focusedTab) return false;
  return !panes.some((p) => p.tab === own.tab && p.zoomed && p.pane !== own.pane);
}

/** Centers a screenshot in the page area, shrinking it to fit but never enlarging it. */
export function fitSnapshot(area: Size, snapshot: Size): Rect {
  const scale = Math.min(1, area.width / snapshot.width, area.height / snapshot.height);
  const width = snapshot.width * scale;
  const height = snapshot.height * scale;
  return { x: (area.width - width) / 2, y: (area.height - height) / 2, width, height };
}
