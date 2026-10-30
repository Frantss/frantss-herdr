// hc commands on agents: reading the question on an agent's screen, answering it, and acting on it.
// Mods can't import outside their own folder, so each mod that acts on agents links this file as
// ./agent-hc.ts.
import { agents, hc, notify } from "herdr";

// Runs an hc command; a failure shows as a toast.
export async function hcOrToast(args: string[], failure: string) {
  const result = await hc(args).catch((): null => null);
  if (result?.code !== 0)
    notify({ title: failure, body: result?.stderr.trim() || undefined, level: "error" });
}

// Box borders and rules carry no words; a line inside a box loses its side borders.
const RULE = /^[\s─━═┄┈╌\-│┃║╭╮╯╰┌┐└┘├┤┬┴┼]*$/;
const SIDES = /^\s*[│┃║]\s?|\s?[│┃║]\s*$/g;

// The last lines of a screen that hold text: where an agent's question and its choices are.
export function questionLines(screen: string, count: number) {
  return screen
    .split("\n")
    .filter((line) => !RULE.test(line))
    .map((line) => line.replace(SIDES, "").trimEnd())
    .slice(-count);
}

export async function readQuestion(address: string, count: number) {
  const result = await hc(["read", address, "--json"]);
  if (result.code !== 0) throw new Error(result.stderr);
  return questionLines(JSON.parse(result.stdout).text ?? "", count);
}

// The hc command that sends a reply. A blocked agent only takes text with --force: the reply may
// answer its question.
export function replyArgs(address: string, text: string) {
  const blocked = agents().find((a) => a.address === address)?.status === "blocked";
  return ["send", ...(blocked ? ["--force"] : []), address, text];
}
