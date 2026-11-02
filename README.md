# Frantss Herdr

The personal `frantss` layout for Herdr, with custom mods, assets, and light and
dark themes. TypeScript sources build into the JavaScript that Herdr loads.

## Use the checkout live

Requires Herdr 0.1.12 or newer, Node.js 22.18+, 24.11+, or 26+, and pnpm. From this repository:

```sh
pnpm install
pnpm check
pnpm test
pnpm run link
pnpm dev
```

`pnpm run link` builds first, then installs everything from `dist/` into
`~/.config/herdr-app`: it links the layout and themes and copies the custom mod
directories. Mods are copies, not links, because Herdr does not load mod assets
through symbolic links to locations outside its config folder. Set `HERDR_APP_HOME` for another Herdr config folder.
When the command replaces an existing entry, restart Herdr once. Its core keeps the
terminals running. The output is ignored by Git; edit TypeScript and assets in
the source directories, not the installed copies.

Keep `pnpm dev` running while editing. It rebuilds the JavaScript and copies
changed layouts, themes, and assets. After a successful build it copies changed
mods into Herdr and notifies Herdr through the layout and theme links, because
Herdr 0.1.7 does not watch external symbolic link targets on macOS. Failed builds
retain the previous output. Ctrl+C stops watching; Herdr continues using the last
build. Use `pnpm build` for a single build.

Matching original files are backed up under Herdr's `backups/frantss-herdr-<time>/`.
Different files and links to another checkout are refused before any replacement.
Links to this checkout's source or `dist/` mods are replaced by copies. A hidden
`.frantss-herdr` file marks each copied mod, so later installs update it. Keep this
checkout at the same path while Herdr uses it, and rebuild after cloning or
deleting `dist/`.

To activate the layout in another installation:

```sh
herdr-app do layout.switch '{"name":"frantss"}'
```

Merge the `layout:frantss` bindings from this repo's `keys.json` into Herdr's
`keys.json` for F2 tab rename, Shift+F2 space rename and Cmd+W to close the focused
pane in a multi-pane tab. With one pane or no focused pane, Cmd+W asks before
closing the tab. The link command leaves keys, session data, saved workspaces,
settings and layout click state in Herdr's config folder.

## Dependencies and checks

Keep Herdr's shipped mods installed. This layout uses their menus and dialogs
(`worktree`, `prompt`, `confirm`, `help`, `picker`, `peek`, `toast`, `new-menu`)
and icons from `workspace-chrome`, `files`, `changes` and `pane`.
Git panels require `git`; the GitHub panel also requires authenticated `gh`.
The changes panel colors code with [bat](https://github.com/sharkdp/bat) (`brew install bat`).
The files panel previews a clicked file; its pen button opens the file in [Fresh](https://getfresh.dev/) (`fresh` on PATH), in one
Fresh daemon per project folder. The daemons keep running after their tabs close;
`fresh --cmd daemon list` shows them as `herdr-<folder>-<hash>`, and
`fresh --cmd daemon kill <name>` stops one. A new daemon takes the active Herdr theme,
written to `~/.config/fresh/themes/herdr-frantss.json`, and a config without the welcome
tab, written to `frantss-files/fresh-config.json` in Herdr's config folder. Stop a daemon
to give it a changed theme.
On macOS, the preview's VS Code button opens the local file in Visual Studio Code.
The app launcher uses macOS `open`. Other panels use Herdr's `hc` and native APIs.

This layout's Codex launchers and Resume controls use `--no-daemon`, so `hc run`
children belong to the agent that started them. In a Herdr shell, start Codex with
`codex --no-daemon`. To move an existing daemon-backed session to this mode, exit
Codex and use `codex --no-daemon resume`.

## Panel navigation and agent attention

With Herdr's default macOS bindings, use Cmd+Option+Arrow to move between
terminal panes and the visible Files, Changes, or Git History panel. These
panels follow your `pane.go` bindings; the layout does not replace them.

An agent's context menu offers **Pin** or **Unpin**. Pinned agents appear above
the status groups in the rail, and agent navigation follows that order.
**Mark as unread** and pins use Herdr's shared terminal state, so they follow
the agent across connected Herdr clients. Reading an agent on another client
clears its shared unread status. Pins end when the terminal ends.

Right-click a pane in the rail and choose **Rename pane** to give it a name,
or **Rename tab** to name its tab. Pane names appear in the rail and pane headers
and persist in this Herdr installation. Clear a pane name to use the program's
title again. An unnamed tab with one pane follows that pane's name; an explicit
tab name stays separate. Pane names are removed when their panes close.

## Other worktrees

Under an open repository, expand **Other worktrees** to find Git checkouts that
have no open Herdr space, including ones created by agents or other tools. Click
a checkout to open it; this does not move or resume an existing agent session.
Hover or focus a checkout to show **Open**, **New thread**, and **Remove…** controls.
Removal is available only for linked worktrees, requires confirmation, and stops
if the checkout is open or has local changes. It deletes the checkout folder,
including ignored files, but keeps the Git branch. Git's lock and submodule
safety checks still apply.

Hover or focus **Other worktrees** to reveal **Remove all eligible worktrees…**
beside refresh. It checks the repository again and confirms the checkout paths
before removal. Main, open or opening, dirty, locked, and submodule checkouts are
skipped. Each candidate is checked again before deletion; a refusal does not stop
the remaining candidates. The result lists removals and skips. Branches are kept.

The list refreshes on expansion when its cache is older than ten seconds, and
checks every ten seconds while expanded. Collapsing the list, repository, or
Workspaces section stops periodic checks. The refresh icon beside **Other worktrees**
checks immediately, even while the list is collapsed;
a failed check keeps the previous list marked **Stale** and retries less often.
With many expanded repositories, checks are spread across refresh cycles.

## Agent usage

The rail's **Usage** section shows Claude and Codex subscription quota consumed.
Closed, it shows each subscription's most used window, with its reset time from
90%; click it to see every window and its reset time. It reads the local CLI
sign-ins on startup and every five minutes; its refresh button reads both again.
A failed refresh keeps the last values marked **Stale**; an expired window shows
a dash until refreshed.
Sign in through each CLI if prompted. Claude uses the CLI's private usage endpoint,
which may change; Codex requires a CLI with `account/rateLimits/read` support.

The focused agent's row in the rail shows its context: a bar and percent for Codex, Pi and OMP,
and the token count for Claude Code, whose session file doesn't give the window.
Claude Code and Codex need `scripts/session-label.sh` (and `jq`) as a `SessionStart` command hook,
by this checkout's absolute path, in `~/.claude/settings.json` and `~/.codex/hooks.json`.
The hook labels the agent's terminal with its session file; agents started before
it was added show no context until they restart or resume.

For Pi, link this checkout's extension, then start Pi or run `/reload` in an existing session:

```sh
mkdir -p "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions"
ln -s "$PWD/scripts/pi-context.ts" "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/frantss-context.ts"
```

Run these commands from this checkout. The extension reports Pi's own context estimate
through `hc` terminal labels. Unknown usage after compaction stays hidden until Pi has
a new estimate. It names unnamed Pi sessions from the first user message's first nonempty
line, limited to 80 characters; existing session names are kept. Use Pi's `/name` to
change that name. Install the extension on each machine where Pi runs. Closed Pi sessions
offer **Resume…**, which opens Pi's session selector in the original folder.

## OMP

OMP 18.15.0 reports its identity and working, blocked, done, idle and error states
through the status protocol Herdr reads. Keep OMP's `terminal.programStatus` setting
enabled. No status hook or replacement terminal launcher is needed.

To add OMP to the agent menu, merge this entry into `programs` in
`~/.config/herdr-app/programs.json` (or `$HERDR_APP_HOME/programs.json`). Keep existing entries:

```json
{
  "programs": {
    "omp": {
      "name": "OMP",
      "icon": "mods/frantss/omp.png",
      "tint": false,
      "run": ["omp"]
    }
  }
}
```

For context usage, session naming and turn recording, run from this checkout:

```sh
mkdir -p "$HOME/.omp/agent/extensions"
ln -s "$PWD/scripts/omp-herdr.ts" "$HOME/.omp/agent/extensions/frantss-herdr.ts"
```

Restart OMP after installing or changing the extension. Keep this checkout and its
sibling recorder scripts available; do not copy the extension alone. Install it on
each machine where OMP runs. Node.js, Git and `hc` must be on OMP's PATH. The link
command installs the layout, not this extension or the program entry.

Context updates at session and turn boundaries and within five seconds of idle
model changes. Unavailable estimates are hidden. The extension names unnamed
sessions from the first user message, preserves existing names and ignores internal
subagents. Herdr uses OMP's own session selector for **Resume…** in the original folder.

These commands use OMP's default config directory. For a named profile, its extension
directory is `~/.omp/profiles/<name>/agent/extensions`; config-directory overrides can
change those paths. The menu entry and **Resume…** use the default profile. Resume named
profiles manually with `omp --profile <name> --resume`.

## Per-turn changes

The Changes panel has one **View / turn** selector: **Working tree** keeps the
normal staging and commit controls; **Turn changes** contains recorded requests
from Pi, OMP, Claude Code and Codex in the followed worktree. Select a request to compare
its saved before and after file states. Previous/Next moves between recorded
requests. Historical views are read-only, including review comments, and remain
available after later edits or commits. Recording starts only after setup; old
transcripts cannot reconstruct these snapshots.

### Enable recording

Keep this checkout available on each machine where agents run. Recording needs
Node.js and Git on that machine and runs only inside Herdr (`HC_TERMINAL_ID` must
be set). The panel reads recorded turns through a POSIX shell (`sh`), including
for remote worktrees; it does not need Node.js in Herdr's own PATH. The link
command installs the panel, not agent hooks.

For OMP, recording is included in the extension installed under [OMP](#omp).

For Pi, link the additional extension from this checkout, then start Pi or run
`/reload`. Keep its sibling scripts in this checkout; do not copy the extension
on its own.

```sh
mkdir -p "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions"
ln -s "$PWD/scripts/pi-turns.ts" "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/frantss-turns.ts"
```

For Claude Code and Codex, merge the following hook entries into the relevant
configuration. Keep existing hooks, including the context SessionStart hook.
Replace `/ABS/CHECKOUT` with this checkout's absolute path and `AGENT` as follows:

| Agent                                                | Configuration             | Replace `AGENT` with |
| ---------------------------------------------------- | ------------------------- | -------------------- |
| [Claude Code](https://code.claude.com/docs/en/hooks) | `~/.claude/settings.json` | `claude-code`        |
| [Codex](https://developers.openai.com/codex/hooks)   | `~/.codex/hooks.json`     | `codex`              |

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"/ABS/CHECKOUT/scripts/turn-hooks.mjs\" AGENT",
            "timeout": 16
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"/ABS/CHECKOUT/scripts/turn-hooks.mjs\" AGENT",
            "timeout": 16
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"/ABS/CHECKOUT/scripts/turn-hooks.mjs\" AGENT",
            "timeout": 3
          }
        ]
      }
    ]
  }
}
```

Also register the same command under **StopFailure** for Claude Code (timeout
16), and under **Interrupt** for Codex (timeout 3). No matcher is needed. If Node
is not available in the hook's PATH, replace `node` with its absolute executable
path. Restart each CLI after changing its hooks. In Codex, use `/hooks` to review
and trust the configured hooks; `[features].hooks = false` disables them.

Pi records from user-request start until `agent_settled`, including automatic
continuations. OMP records from prompt preparation to the final `agent_end`, keeping
retries, automatic continuations, background work and steering delivered during the
active request in the same record. New input while that request awaits background
work stays in its record too. Queued user batches that start after settlement get a
new record. OMP dispatches end notifications without awaiting earlier extensions;
long-running `agent_end` handlers loaded before this extension can delay the boundary
and group overlapping requests incorrectly. Avoid that combination when recording.
OMP shutdown capture has a shorter, 1.5-second child-process timeout
to fit its extension shutdown budget; forced exits can leave a request Recording.
Claude Code and Codex record from UserPromptSubmit to Stop. If
another Stop hook requests more work, a later Stop with `stop_hook_active: true`
updates the same request's snapshot; the earlier snapshot can appear until then.
Claude Code has no interrupt hook: an unfinished request is closed as interrupted
on the next request in that session or on SessionEnd. A forced kill can leave a
request marked Recording. Hook failures do not block the agent or print into its
context. Normal capture has a 15-second budget; shutdown capture has 2.5 seconds,
so a large or busy repository can have a missing or failed snapshot.

Snapshots include tracked files and nonignored untracked files, but not the
contents of nested submodules. Capture uses a separate temporary index and
private `refs/frantss/` refs, without changing HEAD, branches, or the staging
index. File contents remain in the local Git object store; metadata, including
the first prompt line, is under `frantss-turns/` in the worktree's Git directory.
The recorder retains 100 completed requests per worktree and removes their
private refs as they age out; Git garbage collection controls when unreferenced
objects disappear. `git push --mirror` includes these refs and their saved file
contents. Ignoring a file does not exclude it if it is already tracked.
Use separate worktrees for concurrent agents: snapshots record all changes made
in the worktree during a request, including manual edits and other agents' work.

## Agent pull requests

An agent row in the rail shows a chip with its open pull requests, colored by the most urgent
state: failed checks, changes requested or conflicts, then open comments, running checks, ready.
Click it to open the GitHub panel's **Agents** tab, which lists each agent's pull requests,
merged and closed ones included. An agent counts a pull request it created with `gh pr create`
or the GitHub MCP server, one the GitHub panel started it for, and an open or merged pull request
whose branch it pushed to GitHub (except the default branch). Closed agents keep their list until
the rail forgets them. The rail looks pull requests up within seconds of a new link and refreshes
their states every two minutes. Lookups use the local `gh`; agents on other machines are not tracked.

For Claude Code and Codex, add this hook next to the turn hooks, with the same `/ABS/CHECKOUT`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash|.*create_pull_request",
        "hooks": [
          {
            "type": "command",
            "command": "node \"/ABS/CHECKOUT/scripts/pr-hooks.mjs\"",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

For Pi, link the extension from this checkout, then start Pi or run `/reload`:

```sh
ln -s "$PWD/scripts/pi-prs.ts" "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/frantss-prs.ts"
```

## Checks

`pnpm check` refreshes Herdr's generated API declarations in the ignored `types/`
files, then checks formatting, linting and TypeScript types with Vite+. It uses
Herdr's existing non-strict-null contracts. Use `pnpm fmt` to format files,
`pnpm lint` for linting, and `pnpm test` to build and run tests. The configuration
is in `vite.config.ts`. `AGENTS.md` and `ORCHESTRATION.md` stay excluded from
formatting so they remain exact copies of their source.

`pnpm check:mods` builds and renders every emitted mod with Herdr's native checker.
Set `HERDR_APP_BIN` if `herdr-app` is not on PATH. The native checker validates
initial rendering, not laid-out geometry or later interactions. Use
`herdr-app status` to check errors in the running app after edits, and verify
changed interactions in the app.

## Restore the original files

For each installed entry, remove the symbolic link or copied mod directory and move
its matching original from the printed backup folder to the same location. Do not
delete the checkout until its links have been removed. The original extraction
backup retains the pre-extraction files, including generated editor files.
