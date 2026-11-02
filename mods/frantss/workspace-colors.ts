// Theme color names, so workspaces follow the light and dark themes. Green, yellow and red are left
// out: the rail's status dots use them.
export const WORKSPACE_PALETTE = ["accent", "ansi4", "ansi6", "ansi13"];

// Each workspace's color name by key: kept ones stay, gone ones and ones no longer in the palette are
// dropped, new ones take the least used color. Null when nothing changed.
export function assignColors(
  colors: Record<string, string>,
  keys: string[],
): Record<string, string> | null {
  const wanted = new Set(keys);
  const next = Object.fromEntries(
    Object.entries(colors).filter(
      ([key, color]) => wanted.has(key) && WORKSPACE_PALETTE.includes(color),
    ),
  );
  const uses = (color: string) => Object.values(next).filter((each) => each === color).length;
  for (const key of wanted)
    next[key] ??= WORKSPACE_PALETTE.reduce((best, color) =>
      uses(color) < uses(best) ? color : best,
    );
  const same =
    Object.keys(next).length === Object.keys(colors).length &&
    Object.entries(next).every(([key, color]) => colors[key] === color);
  return same ? null : next;
}
