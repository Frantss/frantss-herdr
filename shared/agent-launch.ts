// Codex's shared daemon inherits another terminal's hc parent context.
export function agentArgv(argv: string[]) {
  const executable = argv[0]?.split(/[\\/]/).pop();
  if (!/^codex(?:\.exe)?$/i.test(executable ?? "") || argv.includes("--no-daemon")) return argv;
  return [argv[0], "--no-daemon", ...argv.slice(1)];
}
