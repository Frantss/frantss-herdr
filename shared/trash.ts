// Moves files to the system trash, where they can be restored. Mods can't import outside their own
// folder, so each mod that trashes links this file as ./trash.ts and the build copies it into each.
// `$@` are the paths. macOS has trash; Linux desktops have gio. 127: neither.
export const TRASH_SCRIPT =
  'if command -v trash >/dev/null; then trash "$@"; elif command -v gio >/dev/null; then gio trash -- "$@"; else exit 127; fi';
