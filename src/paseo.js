// Paseo: locate/install the CLI, run it as a client of a (remote) daemon, and edit the local daemon config.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import bcrypt from 'bcryptjs';
import { CliError, IS_WINDOWS, run } from './util.js';

const PACKAGE = '@getpaseo/cli';
// npm 12 blocks dependency install scripts by default; these three need theirs (native modules / binaries).
const ALLOW_SCRIPTS = '--allow-scripts=esbuild,node-pty,msgpackr-extract';

let cachedEntry;

export function npmRootGlobal() {
  // On Windows npm is a .cmd shim, which Node can only start through a shell; the arguments are fixed strings.
  const res = run('npm', ['root', '-g'], { shell: IS_WINDOWS });
  if (res.code !== 0 || !res.stdout) throw new CliError(`Can't locate global npm packages: ${res.stderr}`);
  const root = res.stdout.split(/\r?\n/).pop().trim();
  if (!root.includes('***')) return root;
  // npm masks UUID-like path segments ("***") in its output. Use where npm puts global packages by default.
  const prefix = process.env.npm_config_prefix || (IS_WINDOWS ? path.dirname(process.execPath) : path.dirname(path.dirname(process.execPath)));
  return IS_WINDOWS ? path.join(prefix, 'node_modules') : path.join(prefix, 'lib', 'node_modules');
}

/** Path to Paseo's JS entry point, or null if not installed. Running it with `node` avoids .cmd shims. */
export function paseoEntry() {
  if (cachedEntry && fs.existsSync(cachedEntry)) return cachedEntry;
  const entry = path.join(npmRootGlobal(), PACKAGE, 'bin', 'paseo');
  cachedEntry = fs.existsSync(entry) ? entry : null;
  return cachedEntry;
}

export function requirePaseo() {
  const entry = paseoEntry();
  if (!entry) throw new CliError('Paseo is not installed.', { hint: `Run: claude-wingman setup   (or: ${PASEO_INSTALL})` });
  return entry;
}

/**
 * The Paseo release claude-wingman is tested with. Its terminals, error messages and agent states are relied on and
 * aren't a stable API, so new installs get exactly this version; a different one is reported by setup, doctor, verify.
 */
export const PASEO_VERSION = '0.11.4';
export const PASEO_INSTALL = `npm install -g ${PACKAGE}@${PASEO_VERSION} ${ALLOW_SCRIPTS}`;

/** The installed Paseo's version, or null. */
export function paseoVersion() {
  const entry = paseoEntry();
  if (!entry) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(path.dirname(entry), '..', 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

export function installPaseo() {
  const res = run('npm', ['install', '-g', `${PACKAGE}@${PASEO_VERSION}`, ALLOW_SCRIPTS], { shell: IS_WINDOWS, timeoutMs: 600_000 });
  cachedEntry = undefined;
  if (res.code !== 0 || !paseoEntry()) throw new CliError(`Installing Paseo failed:\n${res.stderr || res.stdout}`);
}

export const nodeArgs = (entry, args) => ['--disable-warning=DEP0040', entry, ...args];

/**
 * Environment for a Paseo client. Agents and terminals started by a daemon inherit PASEO_* context (PASEO_HOME,
 * which paseo refuses to combine with PASEO_HOST, and PASEO_WORKSPACE_ID, which would make `run` look for this
 * machine's workspace on the other daemon). None of it applies to another daemon, so drop it all.
 */
export function clientEnv({ host, password, isolatedHome } = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('PASEO_')) delete env[key];
  if (host) env.PASEO_HOST = host;
  else delete env.PASEO_HOST;
  if (password) env.PASEO_PASSWORD = password;
  if (isolatedHome) {
    // A client without this machine's local credential file, i.e. exactly what a remote client looks like.
    env.HOME = isolatedHome;
    env.USERPROFILE = isolatedHome;
  }
  return env;
}

/** A one-line reason from a failed paseo run. With --json, paseo reports errors as {"error": {"message": ...}}. */
export function errorText(res) {
  const text = (res.stderr || res.stdout || '').trim();
  try {
    const parsed = JSON.parse(text);
    const message = parsed?.error?.message ?? parsed?.message;
    if (typeof message === 'string' && message) return message;
  } catch {}
  return text.split(/\r?\n/).find((line) => line.trim()) ?? `exit code ${res.code}`;
}

/** Run paseo and capture output. */
export function paseo(args, opts = {}) {
  return run(process.execPath, nodeArgs(requirePaseo(), args), { env: clientEnv(opts), timeoutMs: opts.timeoutMs ?? 120_000 });
}

/** paseo() without blocking, so several daemons can be asked at once. */
export function paseoAsync(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, nodeArgs(requirePaseo(), args), { env: clientEnv(opts), windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 120_000);
    const done = (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    };
    child.on('error', () => done(127));
    child.on('close', (code) => done(code ?? 1));
  });
}

/** Run paseo attached to this terminal (for passthrough commands). Returns the exit code. */
export function paseoInteractive(args, opts = {}) {
  const res = spawnSync(process.execPath, nodeArgs(requirePaseo(), args), { env: clientEnv(opts), stdio: 'inherit', windowsHide: true });
  return res.status ?? 1;
}

/** Run a paseo command that prints JSON and parse it. */
export function paseoJson(args, opts = {}) {
  const res = paseo([...args, '--json'], opts);
  if (res.code !== 0) throw new CliError(`paseo ${args[0]} failed: ${errorText(res)}`);
  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new CliError(`Unexpected output from paseo ${args.join(' ')}:\n${res.stdout.slice(0, 500)}`);
  }
}

// ---- local daemon configuration ----------------------------------------------------------

export const paseoHome = () => process.env.PASEO_HOME || path.join(os.homedir(), '.paseo');
const paseoConfigPath = () => path.join(paseoHome(), 'config.json');

export function readDaemonConfig() {
  try {
    return JSON.parse(fs.readFileSync(paseoConfigPath(), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new CliError(`Can't read ${paseoConfigPath()}: ${err.message}`);
  }
}

export const passwordMatchesDaemon = (password) => {
  const hash = readDaemonConfig()?.daemon?.auth?.password;
  return Boolean(hash && password && bcrypt.compareSync(password, hash));
};

/**
 * Point the local daemon at `listen`, require `password`, and keep the relay off.
 * `paseo daemon set-password` needs a terminal, and `config set daemon.auth.password` is refused,
 * so the bcrypt hash goes straight into config.json (the documented daemon.auth.password key).
 */
export function configureDaemon({ listen, password }) {
  if (!readDaemonConfig()) {
    // Let paseo create a complete default config first.
    const res = run(process.execPath, nodeArgs(requirePaseo(), ['daemon', 'config', 'set', 'daemon.listen', listen]), { env: clientEnv() });
    if (res.code !== 0) throw new CliError(`Creating Paseo config failed: ${res.stderr}`);
  }
  const file = paseoConfigPath();
  const cfg = readDaemonConfig();
  const before = JSON.stringify(cfg);
  cfg.daemon ??= {};
  cfg.daemon.listen = listen;
  cfg.daemon.relay = { ...cfg.daemon.relay, enabled: false };
  if (!passwordMatchesDaemon(password)) cfg.daemon.auth = { ...cfg.daemon.auth, password: bcrypt.hashSync(password, 12) };
  const changed = JSON.stringify(cfg) !== before;
  if (changed) {
    const backup = `${file}.bak-${Date.now()}`;
    fs.copyFileSync(file, backup);
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
    // writeFileSync's mode only applies to new files; the config (and its backup) hold the password hash.
    if (!IS_WINDOWS) for (const f of [file, backup]) fs.chmodSync(f, 0o600);
  }
  return changed;
}
