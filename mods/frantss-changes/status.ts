// `git status` and `git diff --numstat` output as the files each section of the list shows.
export type Section = "staged" | "unstaged";
export const SECTIONS: readonly Section[] = ["staged", "unstaged"];

export interface FileStats {
  add: number;
  del: number;
  binary?: boolean;
}
export interface ChangedFile extends FileStats {
  section: Section;
  path: string;
  status: string;
  fresh: boolean;
}

// A file can show in both sections, so the section is part of its identity.
export const entryKey = ({ section, path }: { section: Section; path: string }) =>
  `${section}:${path}`;

// `git diff --numstat -z --no-renames` output by path.
export function parseNumstat(stdout: string): Record<string, FileStats> {
  const stats: Record<string, FileStats> = {};
  for (const entry of stdout.split("\0")) {
    const [add, del, ...parts] = entry.split("\t");
    if (!parts.length) continue;
    stats[parts.join("\t")] = { add: Number(add) || 0, del: Number(del) || 0, binary: add === "-" };
  }
  return stats;
}

const letter = (code: string) => (code === "D" ? "D" : code === "A" ? "A" : "M");

// `git status --porcelain=v1 -z --branch --no-renames` output: whether HEAD exists, and the
// changed paths with their index (X) and worktree (Y) codes.
export function parseStatus(stdout: string) {
  const [branch = "", ...entries] = stdout.split("\0").filter(Boolean);
  return {
    hasHead: !/^## (No commits yet|Initial commit) on /.test(branch),
    entries: entries.map((entry) => ({ xy: entry.slice(0, 2), path: entry.slice(3) })),
  };
}

// The staged files come first. A conflict or an untracked file is only in the unstaged section,
// where staging it resolves or adds it.
export function changedFiles(
  entries: { xy: string; path: string }[],
  staged: Record<string, FileStats>,
  unstaged: Record<string, FileStats>,
): ChangedFile[] {
  const sections: Record<Section, ChangedFile[]> = { staged: [], unstaged: [] };
  const add = (section: Section, path: string, status: string, fresh = false) =>
    sections[section].push({
      section,
      path,
      status,
      fresh,
      ...((section === "staged" ? staged : unstaged)[path] ?? { add: 0, del: 0 }),
    });
  for (const { xy, path } of entries) {
    const [index, worktree] = xy;
    if (xy === "??") add("unstaged", path, "A", true);
    else if (xy.includes("U") || xy === "AA" || xy === "DD") add("unstaged", path, "U");
    else {
      if (index !== " ") add("staged", path, letter(index));
      if (worktree !== " ") add("unstaged", path, letter(worktree));
    }
  }
  return [...sections.staged, ...sections.unstaged];
}
