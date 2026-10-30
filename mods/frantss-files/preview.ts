export const PREVIEW_BYTES = 400000;

// Herdr's code view names some languages after a close relative.
const LANG: Record<string, string> = {
  ts: "js",
  tsx: "js",
  mts: "js",
  cts: "js",
  jsx: "js",
  mjs: "js",
  toml: "yaml",
  jsonc: "json",
  svelte: "html",
  vue: "html",
  md: "markdown",
};
const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"]);
const MARKDOWN = new Set(["md", "markdown", "mdx"]);

// A leading dot names a file, not an extension.
function extension(path: string) {
  const name = path.slice(path.lastIndexOf("/") + 1),
    dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function previewKind(path: string): "image" | "markdown" | "text" {
  const ext = extension(path);
  return IMAGES.has(ext) ? "image" : MARKDOWN.has(ext) ? "markdown" : "text";
}

export function editorLanguage(path: string) {
  const ext = extension(path);
  return LANG[ext] ?? (ext || "text");
}

export function previewText(text: string | null): { text: string } | { error: string } {
  if (text === null) return { error: "This file is no longer available" };
  if (text.includes("\0")) return { error: "Binary file · no text preview" };
  return {
    text:
      text.length > PREVIEW_BYTES ? text.slice(0, PREVIEW_BYTES) + "\n… (file truncated)" : text,
  };
}
