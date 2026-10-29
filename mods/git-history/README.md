# Git history

Open **History** from the frantss tab bar. The panel follows the focused terminal's checkout and machine.

- **Current branch** follows HEAD, including its merged history. **All branches** includes local branches, remote-tracking branches and commit tags.
- **History** and **Commit details** are collapsible sections. History starts open; Commit details starts closed. Select a commit, then expand Commit details for its message, author and changed files. Selecting another commit keeps your expansion choice. Select a file for its diff. Merge diffs compare with the first parent.
- Tab reaches the controls and history list. In the list, Up/Down select commits, Home/End move to the first/last loaded commit, and R refreshes. In changed files, Up/Down move and Enter opens a diff. Escape returns from a diff to commit details.
- History starts with 25 commits. **Load 25 more** extends the same snapshot. Refresh starts a new snapshot. The panel checks refs every 15 seconds while shown and reports when history changes.

History loads up to 2,000 commits. Details list up to 1,000 files. Diff previews show up to 30,000 characters; Herdr rejects commands beyond its 8 MiB output or 30-second execution limits. No Git writes, automatic fetches or repository configuration changes are performed.

To open the same mod in a dedicated tab, pass explicit checkout and machine props:

```sh
herdr-app do tab.new '{"name":"History","mod":"git-history","props":{"cwd":"/absolute/repo/path","on":null}}'
```

Use a configured machine name for `on` when the checkout is remote.

Check changes with `herdr-app check ~/.config/herdr-app/mods/git-history`. From the repository root, run this panel's data and UI tests with `pnpm exec vp test mods/git-history`.

`git.js` reads Git through an injected executor. `graph.js` assigns lanes without host APIs. `main.js` handles native rendering and per-copy state. The graph algorithm is adapted from the local `git-graph-claude-mod` project. Personal mod files survive Herdr updates; its generated type files describe the installed API.
