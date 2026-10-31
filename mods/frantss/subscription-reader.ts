// Desktop PATH may omit Node. FD 3 preserves JSON while shell startup output is discarded.
export const SUBSCRIPTION_LAUNCH =
  'exec 3>&1; exec "${SHELL:-/bin/sh}" -lic \'exec node "$@" >&3\' herdr-usage "$@" >/dev/null 2>/dev/null';

// Runs outside Herdr's JavaScript runtime so CLI credentials stay in the child process.
export const SUBSCRIPTION_READER = String.raw`
import { spawn, execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const failure = error => ({ windows: [], error });

function window(label, usedPercent, resetsAt) {
  if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) return null;
  if (!Number.isFinite(resetsAt) || resetsAt <= 0) return null;
  return { label, usedPercent, resetsAt };
}

function duration(minutes, fallback) {
  if (!Number.isFinite(minutes) || minutes <= 0) return fallback;
  if (minutes % 1440 === 0) return String(minutes / 1440) + 'd';
  if (minutes % 60 === 0) return String(minutes / 60) + 'h';
  return String(minutes) + 'm';
}

async function codex() {
  return new Promise(resolve => {
    const child = spawn('codex', ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let settled = false;
    const timer = setTimeout(() => finish(failure('Codex usage timed out. Try refreshing.')), 20000);
    const lines = createInterface({ input: child.stdout });
    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.destroy();
      child.kill('SIGKILL');
      resolve(result);
    }
    function send(message) {
      if (!settled) child.stdin.write(JSON.stringify(message) + '\n');
    }
    child.on('error', error => finish(failure(error.code === 'ENOENT'
      ? 'Install Codex CLI to read usage.' : 'Could not start Codex. Try refreshing.')));
    child.on('exit', () => finish(failure('Codex closed before returning usage. Try refreshing.')));
    child.stdin.on('error', () => finish(failure('Could not read Codex usage. Try refreshing.')));
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id === 1) {
        if (message.error) return finish(failure('Could not initialize Codex. Try refreshing.'));
        send({ method: 'initialized' });
        send({ method: 'account/rateLimits/read', id: 2 });
      }
      if (message.id !== 2) return;
      if (message.error) return finish(failure('Open Codex and sign in to read subscription usage.'));
      const result = message.result;
      const limits = result?.rateLimitsByLimitId?.codex ?? result?.rateLimits;
      const windows = ['primary', 'secondary'].map((name, index) => {
        const value = limits?.[name];
        return value && window(duration(value.windowDurationMins, index ? 'Secondary' : 'Primary'), value.usedPercent, value.resetsAt);
      }).filter(Boolean);
      finish(windows.length ? { windows } : failure('Codex did not report subscription limits.'));
    });
    send({ method: 'initialize', id: 1, params: { clientInfo: { name: 'herdr_usage', version: '1.0.0' } } });
  });
}

async function claudeCredentials() {
  const configuration = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return { accessToken: process.env.CLAUDE_CODE_OAUTH_TOKEN };
  if (process.platform === 'darwin') {
    const secureDirectory = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    const isDefault = secureDirectory !== undefined ? !secureDirectory : !process.env.CLAUDE_CONFIG_DIR;
    const directory = (secureDirectory !== undefined ? secureDirectory : configuration).normalize('NFC');
    const suffix = isDefault ? '' : '-' + createHash('sha256').update(directory).digest('hex').slice(0, 8);
    try {
      const { stdout } = await execute('security', ['find-generic-password', '-a', process.env.USER || userInfo().username, '-w', '-s', 'Claude Code-credentials' + suffix], { timeout: 3000, maxBuffer: 1024 * 1024 });
      const credentials = JSON.parse(stdout)?.claudeAiOauth;
      if (credentials?.accessToken) return credentials;
    } catch {}
  }
  try {
    return JSON.parse(await readFile(join(configuration, '.credentials.json'), 'utf8'))?.claudeAiOauth;
  } catch { return null; }
}

async function claude() {
  const credentials = await claudeCredentials();
  if (!credentials?.accessToken) return failure('Sign in to Claude Code to read usage.');
  if (Number.isFinite(credentials.expiresAt) && credentials.expiresAt <= Date.now()) {
    return failure('Open Claude Code and sign in again.');
  }
  try {
    // Claude Code's own /usage reads this private endpoint; failures never change CLI credentials.
    const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: 'Bearer ' + credentials.accessToken, 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 401 || response.status === 403) return failure('Open Claude Code and sign in again.');
    if (response.status === 429) return failure('Claude usage is rate limited. Try again later.');
    if (!response.ok) return failure('Claude usage is unavailable. Try refreshing.');
    const data = await response.json();
    const windows = [['five_hour', '5h'], ['seven_day', '7d']].map(([key, label]) => {
      const value = data?.[key];
      return value && window(label, value.utilization, Date.parse(value.resets_at) / 1000);
    }).filter(Boolean);
    return windows.length ? { windows } : failure('Claude did not report subscription limits.');
  } catch { return failure('Could not reach Claude usage. Try refreshing.'); }
}

let result;
try {
  result = process.argv[1] === 'codex' ? await codex()
    : process.argv[1] === 'claude' ? await claude()
    : failure('Unknown subscription provider.');
} catch { result = failure('Could not read subscription usage. Try refreshing.'); }
process.stdout.write(JSON.stringify(result));
`;
