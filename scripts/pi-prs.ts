import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type ToolResultEvent = { toolName: string; input?: { command?: unknown }; content?: unknown };
type PiPrsAPI = {
  on(event: "tool_result", handler: (event: ToolResultEvent) => Promise<void>): unknown;
};

// Passes each bash result to pr-hooks.mjs, which labels this terminal with the pull requests the
// agent creates and the GitHub branches it pushes.
export default function piPrs(pi: PiPrsAPI) {
  if (!process.env.HC_TERMINAL_ID) return;
  pi.on("tool_result", async (event) => {
    if (event.toolName !== "bash" || typeof event.input?.command !== "string") return;
    if (!/\bgit\b.*\bpush\b|\bgh\s+pr\s+create\b/.test(event.input.command)) return;
    try {
      const script = join(dirname(realpathSync(fileURLToPath(import.meta.url))), "pr-hooks.mjs");
      const payload = {
        tool_name: "Bash",
        tool_input: { command: event.input.command },
        tool_response: event.content,
      };
      await new Promise<void>((resolve) => {
        const child = execFile(process.execPath, [script], { timeout: 8000 }, () => resolve());
        child.stdin?.on("error", () => {});
        child.stdin?.end(JSON.stringify(payload));
      });
    } catch {}
  });
}
