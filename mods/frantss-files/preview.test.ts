import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { editorLanguage, PREVIEW_BYTES, previewKind, previewText } from "./preview.ts";

test("previews show images, render markdown, and show other files as code", () => {
  assert.equal(previewKind("assets/Logo.PNG"), "image");
  assert.equal(previewKind("icon.svg"), "image");
  assert.equal(previewKind("docs/README.md"), "markdown");
  assert.equal(previewKind("notes.markdown"), "markdown");
  assert.equal(previewKind("main.ts"), "text");
  assert.equal(previewKind("Makefile"), "text");
  assert.equal(previewKind(".env"), "text");
});

test("code views name the editor's language for the extension", () => {
  assert.equal(editorLanguage("src/main.ts"), "js");
  assert.equal(editorLanguage("Cargo.toml"), "yaml");
  assert.equal(editorLanguage("lib.rs"), "rs");
  assert.equal(editorLanguage("README.md"), "markdown");
  assert.equal(editorLanguage("Makefile"), "text");
  assert.equal(editorLanguage(".env"), "text");
});

test("previewed text is refused when missing or binary and cut when large", () => {
  assert.deepEqual(previewText(null), { error: "This file is no longer available" });
  assert.deepEqual(previewText("a\0b"), { error: "Binary file · no text preview" });
  assert.deepEqual(previewText("short\n"), { text: "short\n" });
  const long = previewText("x".repeat(PREVIEW_BYTES + 1));
  assert.ok("text" in long && long.text === "x".repeat(PREVIEW_BYTES) + "\n… (file truncated)");
});
