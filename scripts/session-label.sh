#!/bin/sh
# A SessionStart hook for Claude Code and Codex: labels the Herdr terminal it runs in with the
# session's transcript, so the frantss rail can show the agent's context. Prints nothing: a
# SessionStart hook's output goes into the agent's context.
[ -n "${HC_TERMINAL_ID-}" ] || exit 0
transcript=$(jq -r '.transcript_path // empty' 2>/dev/null) || exit 0
[ -n "$transcript" ] && hc label "$HC_TERMINAL_ID" "frantss.session=$transcript" >/dev/null 2>&1
exit 0
