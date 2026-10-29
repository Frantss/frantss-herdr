# Frantss Herdr

The personal `frantss` layout for Herdr, with custom mods, assets, and light and
dark themes. TypeScript sources build into the JavaScript that Herdr loads.

## Use the checkout live

Requires Node.js 22.18+, 24.11+, or 26+, pnpm, and the Herdr app. From this repository:

```sh
pnpm install
pnpm check
pnpm test
pnpm run link
pnpm dev
```

`pnpm run link` builds first, then links the layout, custom mod directories, and
themes from `dist/` into `~/.config/herdr-app`. Set `HERDR_APP_HOME` for another
Herdr config folder. After the first link or a move from source links to output
links, restart Herdr once so it resolves the new mod paths. Its core keeps the
terminals running. The output is ignored by Git; edit TypeScript and assets in
the source directories.

Keep `pnpm dev` running while editing. It rebuilds the JavaScript and copies
changed layouts, themes, and assets. After a successful build it notifies Herdr
through its installed links, because Herdr 0.1.7 does not watch external symbolic
link targets on macOS. Failed builds retain the previous output. Ctrl+C stops
watching; Herdr continues using the last build. Use `pnpm build` for a single build.

Matching original files are backed up under Herdr's `backups/frantss-herdr-<time>/`.
Different files and links to another checkout are refused before any replacement.
Links to this checkout's old source paths can be migrated to `dist/`. Repeating
the link command keeps existing output links. Keep this checkout at the same path
while Herdr uses it, and rebuild after cloning or deleting `dist/`.

To activate the layout in another installation:

```sh
herdr-app do layout.switch '{"name":"frantss"}'
```

Merge the `layout:frantss` bindings from this repo's `keys.json` into Herdr's
`keys.json` for F2 tab rename and Shift+F2 space rename. The link command leaves
keys, session data, saved workspaces, settings and layout click state in Herdr's
config folder. On this machine those bindings are already installed.

## Dependencies and checks

Keep Herdr's shipped mods installed. This layout uses their menus and dialogs
(`worktree`, `prompt`, `confirm`, `help`, `picker`, `peek`, `toast`, `new-menu`)
and icons from `workspace-chrome`, `files`, `changes` and `pane`.
Git panels require `git`; the GitHub panel also requires authenticated `gh`.
The app launcher uses macOS `open`. Other panels use Herdr's `hc` and native APIs.

`pnpm check` refreshes Herdr's generated API declarations in the ignored `types/`
files, then checks formatting, linting and TypeScript types with Vite+. It uses
Herdr's existing non-strict-null contracts. Use `pnpm fmt` to format files,
`pnpm lint` for linting, and `pnpm test` to build and run tests. The configuration
is in `vite.config.ts`. `AGENTS.md` stays excluded from formatting so it remains
an exact copy of its source.

`pnpm check:mods` builds and renders every emitted mod with Herdr's native checker.
Set `HERDR_APP_BIN` if `herdr-app` is not on PATH. Herdr 0.1.7's checker can abort
inside GPUI for `frantss` and `frantss-changes`, including the original mods.
Use `herdr-app status` to check errors in the running app after edits.

## Restore the original files

For each linked entry, remove the symbolic link and move its matching original
from the printed backup folder to the same location. Do not delete the checkout
until its links have been removed. The original extraction backup retains the
pre-extraction files, including generated editor files.
