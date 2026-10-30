export type MenuAction =
  | "preview"
  | "fresh"
  | "toggle"
  | "copy"
  | "copy-relative"
  | "open-in"
  | "new-file"
  | "new-folder"
  | "rename"
  | "trash";
export interface MenuItem {
  action: MenuAction;
  label: string;
  icon: string;
}

const chrome = (name: string) => `mods/workspace-chrome/${name}.svg`;

// null separates groups. Other apps open only what is on this Mac.
export function menuItems(
  row: { dir: boolean; open: boolean },
  local: boolean,
): (MenuItem | null)[] {
  const item = (action: MenuAction, label: string, icon: string) => ({ action, label, icon });
  return [
    ...(row.dir
      ? [
          item(
            "toggle",
            row.open ? "Collapse" : "Expand",
            chrome(row.open ? "chevron-down" : "chevron-right"),
          ),
        ]
      : [
          item("preview", "Preview", chrome("file-text")),
          item("fresh", "Open in Fresh", chrome("square-pen")),
        ]),
    null,
    item("copy", "Copy path", chrome("files")),
    item("copy-relative", "Copy relative path", chrome("files")),
    ...(local ? [item("open-in", "Open in", chrome("folder"))] : []),
    null,
    item("new-file", "New file…", chrome("plus")),
    item("new-folder", "New folder…", chrome("folder-plus")),
    item("rename", "Rename…", chrome("square-pen")),
    item("trash", "Move to Trash", "mods/frantss-files/trash.svg"),
  ];
}

export const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

export function checkName(name: string, siblings: string[]) {
  const trimmed = name.trim();
  if (!trimmed) return "Enter a name";
  if (trimmed.includes("/")) return "A name cannot contain /";
  if (trimmed === "." || trimmed === "..") return "That name is reserved";
  if (siblings.includes(trimmed)) return `${trimmed} already exists`;
  return null;
}
