/** "I" marks a gitignored path; git names an ignored folder once, not its contents. */
export type Mark = "A" | "M" | "D" | "U" | "I";

/** Marks by absolute path from `git status --porcelain=v1 -z --ignored` run in the repository `top`. */
export function statusMarks(stdout: string, top: string, limit: number): Record<string, Mark> {
  const marks: Record<string, Mark> = {};
  for (const entry of stdout.split("\0").filter(Boolean).slice(0, limit)) {
    const xy = entry.slice(0, 2);
    marks[`${top}/${entry.slice(3).replace(/\/$/, "")}`] =
      xy === "!!"
        ? "I"
        : xy === "??" || xy.includes("A")
          ? "A"
          : xy.includes("U")
            ? "U"
            : xy.includes("D")
              ? "D"
              : "M";
  }
  return marks;
}
