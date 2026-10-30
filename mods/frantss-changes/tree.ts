// The changed files as a folder tree, flattened to the rows a list draws.
export type TreeRow<File> =
  | {
      kind: "folder";
      path: string;
      name: string;
      depth: number;
      open: boolean;
      // The lines added and deleted across every file the folder holds.
      add: number;
      del: number;
    }
  | { kind: "file"; file: File; depth: number };

interface Folder<File> {
  folders: Map<string, Folder<File>>;
  files: File[];
  add: number;
  del: number;
}
interface Counted {
  path: string;
  add: number;
  del: number;
}

const byName = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

// Folders come before files, each sorted by name. A folder that holds only one folder joins it in
// one row ("src/lib"), so deep paths do not take a row per level. Collapsed paths start with
// `keyPrefix`, so lists that share one set keep their folders apart.
export function treeRows<File extends Counted>(
  files: File[],
  collapsed: ReadonlySet<string>,
  keyPrefix = "",
): TreeRow<File>[] {
  const emptyFolder = (): Folder<File> => ({ folders: new Map(), files: [], add: 0, del: 0 });
  const root = emptyFolder();
  for (const file of files) {
    let current = root;
    for (const name of file.path.split("/").slice(0, -1)) {
      let next = current.folders.get(name);
      if (!next) current.folders.set(name, (next = emptyFolder()));
      next.add += file.add;
      next.del += file.del;
      current = next;
    }
    current.files.push(file);
  }
  const rows: TreeRow<File>[] = [];
  const walk = (folder: Folder<File>, prefix: string, depth: number) => {
    for (const name of [...folder.folders.keys()].sort(byName)) {
      let shown = name,
        inner = folder.folders.get(name)!;
      while (!inner.files.length && inner.folders.size === 1) {
        const [[next, only]] = inner.folders;
        shown += `/${next}`;
        inner = only;
      }
      const path = prefix + shown,
        open = !collapsed.has(keyPrefix + path);
      rows.push({ kind: "folder", path, name: shown, depth, open, add: inner.add, del: inner.del });
      if (open) walk(inner, `${path}/`, depth + 1);
    }
    for (const file of [...folder.files].sort((left, right) =>
      byName(fileName(left.path), fileName(right.path)),
    ))
      rows.push({ kind: "file", file, depth });
  };
  walk(root, "", 0);
  return rows;
}
