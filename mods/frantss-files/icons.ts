// Picks Material Icon Theme icons (material-icons.json, copied next to this mod) the way VS Code does:
// the exact name first, then the longest dotted extension. Names are matched in lower case.
type IconMap = Record<string, string>;
interface IconSet {
  fileNames?: IconMap;
  fileExtensions?: IconMap;
  folderNames?: IconMap;
  folderNamesExpanded?: IconMap;
}
export interface IconManifest extends IconSet {
  iconDefinitions: Record<string, { iconPath: string }>;
  file: string;
  folder: string;
  folderExpanded: string;
  light?: IconSet;
}

/** The icon's file name in the theme's icons folder. */
export function iconFile(
  manifest: IconManifest,
  entry: { name: string; dir: boolean; open?: boolean },
  light: boolean,
): string {
  // A light theme's variant replaces the same key's icon, without changing which key wins.
  const find = (map: keyof IconSet, key: string) =>
    (light ? manifest.light?.[map]?.[key] : undefined) ?? manifest[map]?.[key];
  const name = entry.name.toLowerCase();
  let icon: string | undefined;
  if (entry.dir)
    icon =
      find(entry.open ? "folderNamesExpanded" : "folderNames", name) ??
      (entry.open ? manifest.folderExpanded : manifest.folder);
  else {
    icon = find("fileNames", name);
    for (let dot = name.indexOf("."); !icon && dot !== -1; dot = name.indexOf(".", dot + 1))
      icon = find("fileExtensions", name.slice(dot + 1));
    icon ??= manifest.file;
  }
  return manifest.iconDefinitions[icon].iconPath.split("/").pop();
}
