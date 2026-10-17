// Small shared helpers: running commands, console output, errors.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

/** This claude-wingman's version. */
export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export const IS_WINDOWS = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';
export const IS_LINUX = process.platform === 'linux';
export const SUPPORTED_OSES = ['darwin', 'win32', 'linux'];

/** "macOS", "Windows" or "Linux" for a process.platform value. */
export const osLabel = (platform) => ({ darwin: 'macOS', win32: 'Windows', linux: 'Linux' })[platform] ?? platform;

/** An error meant for the user: printed without a stack trace, with an optional fix hint. */
export class CliError extends Error {
  constructor(message, { hint, exitCode = 1 } = {}) {
    super(message);
    this.hint = hint;
    this.exitCode = exitCode;
  }
}

/** Run a command synchronously and capture its output. Never throws for a non-zero exit. */
export function run(cmd, args = [], { env, input, cwd, timeoutMs = 120_000, shell = false } = {}) {
  const res = spawnSync(cmd, args, {
    env: env ?? process.env,
    input,
    cwd,
    shell,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  return {
    code: res.status ?? (res.error ? 127 : 1),
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
    error: res.error,
  };
}

/** Run a PowerShell script (Windows). Secrets should be passed through `env`, never inside the script. */
export function runPowerShell(script, { env, timeoutMs } = {}) {
  const childEnv = { ...process.env, ...env };
  // When launched from PowerShell 7 (e.g. Claude Code's PowerShell tool), PSModulePath points at PS7 modules,
  // which Windows PowerShell 5.1 can't load ("module could not be loaded"). Let 5.1 build its own default.
  delete childEnv.PSModulePath;
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    env: childEnv,
    timeoutMs,
  });
}

/** Absolute path of an executable on PATH, or null. */
export function which(name) {
  const res = IS_WINDOWS ? run('where.exe', [name]) : run('/usr/bin/which', [name]);
  return res.code === 0 ? res.stdout.split(/\r?\n/)[0].trim() : null;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Quote a string for a PowerShell single-quoted literal. */
export const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** Escape text for an XML element (launchd plists). */
export const xmlEscape = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Node 20.11+ (needed for --disable-warning, which Paseo is started with). */
export function nodeIsSupported(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  return major > 20 || (major === 20 && minor >= 11);
}

/** WSL puts Windows folders on PATH, so `npm` or `claude` there can be the Windows one, which can't serve Linux. */
export const isWindowsToolOnWsl = (p) => IS_LINUX && /^\/mnt\/[a-z]\//i.test(p ?? '');

/**
 * True when this process runs under the Paseo daemon: in an agent it started, or in a remote terminal
 * (claude-wingman remote/update). Restarting the daemon from here must be deferred, or it kills this process.
 */
export const insidePaseoAgent = () => Boolean(process.env.PASEO_HOME || process.env.PASEO_AGENT_ID || process.env.CLAUDE_WINGMAN_REMOTE);

// ---- console output ---------------------------------------------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
export const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
// Windows PowerShell 5.1 consoles often can't render check marks, so use ASCII there.
const marks = IS_WINDOWS ? { ok: '[ok]', fail: '[x]', warn: '[!]', info: '[-]' } : { ok: '✓', fail: '✗', warn: '!', info: '·' };

export const ui = {
  ok: (msg) => console.log(`${paint(32, marks.ok)} ${msg}`),
  fail: (msg) => console.log(`${paint(31, marks.fail)} ${msg}`),
  warn: (msg) => console.log(`${paint(33, marks.warn)} ${msg}`),
  info: (msg) => console.log(`${paint(2, marks.info)} ${msg}`),
  step: (msg) => console.log(`\n${paint(1, msg)}`),
  hint: (msg) => console.log(`  ${paint(2, msg)}`),
  dim: (s) => paint(2, s),
  bold: (s) => paint(1, s),
};

export const homeDir = () => os.homedir();
