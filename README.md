# Frantss Herdr

The personal `frantss` layout extracted from Herdr 0.1.7, with its twelve custom
mods, assets, and light and dark themes. Herdr provides the native UI runtime.
Vite+ provides development tests, formatting and linting; no web build is needed.

## Use the checkout live

Requires Node.js 22.18+, 24.11+, or 26+, pnpm, and the Herdr app. Run from this repository:

```sh
pnpm install
pnpm check
pnpm test
pnpm run link
pnpm dev
```

The link command connects `layouts/frantss.json`, each custom mod directory,
and the two theme files to `~/.config/herdr-app` with symbolic links. Set
`HERDR_APP_HOME` for another Herdr config folder.

Keep `pnpm dev` running while editing. Herdr 0.1.7 does not watch external
symbolic-link targets on macOS. This watcher forwards edits by updating the
installed links' timestamps, which triggers Herdr's own reload. It does not copy
files or run a build. Ctrl+C stops the watcher; Herdr keeps using the linked files.

Existing matching files are backed up under Herdr's `backups/frantss-herdr-<time>/`.
Different files and links to another checkout are refused before any replacement.
Running the command again leaves existing links in place. Keep this checkout at
the same path while Herdr uses it.

To activate the layout in a different installation:

```sh
herdr-app do layout.switch '{"name":"frantss"}'
```

Merge the `layout:frantss` bindings from this repo's `keys.json` into your Herdr
`keys.json` for F2 tab rename and Shift+F2 space rename. The link command leaves
your keys, session data, saved workspaces, settings and layout click state in
Herdr's config folder. On this machine those bindings are already installed.

## Dependencies and checks

Keep Herdr's shipped mods installed. This layout uses their menus and dialogs
(`worktree`, `prompt`, `confirm`, `help`, `picker`, `peek`, `toast`, `new-menu`)
and icons from `workspace-chrome`, `files`, `changes` and `pane`.
Git panels require `git`; the GitHub panel also requires authenticated `gh`.
The app launcher uses macOS `open`. Other panels use Herdr's `hc` and native APIs.
These mods retain their existing program execution, project-file access and
GitHub behavior.

`pnpm check` checks formatting and linting with Vite+. Use `pnpm fmt` to format
files, `pnpm lint` to run linting alone, and `pnpm test` to run all tests.
The configuration is in `vite.config.mjs`. `AGENTS.md` is excluded from formatting
so it remains an exact copy of its source.

`pnpm check:mods` loads and renders every custom mod with Herdr's native checker.
Set `HERDR_APP_BIN` if `herdr-app` is not on PATH. Herdr supplies the generated
type declarations and editor configuration; Git ignores those files. The history
UI tests read the installed app's `gpui-kit.d.ts` from `HERDR_APP_HOME` (or the
default config folder).

After editing, use `herdr-app status` to check runtime errors. Layout and mod
names stay the same so their saved state remains associated with them.

Herdr 0.1.7's native checker can abort inside GPUI for `frantss` and
`frantss-changes`, including the original mods. Inspect `herdr-app status` for
errors in the running app when this occurs.

## Restore the original files

For each linked entry, remove the symbolic link and move its matching original
from the printed backup folder back to the same location. Do not delete the
checkout until its links have been removed. Backups retain the pre-extraction
files, including generated editor files.
