// claude-wingman setup: make this machine's Paseo daemon reachable (Tailscale only, password, autostart, awake).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from '../args.js';
import { DEFAULT_PORT, loadConfig, saveConfig, toName, validateName } from '../config.js';
import { PASEO_INSTALL, PASEO_VERSION, configureDaemon, installPaseo, paseoEntry, paseoVersion, passwordMatchesDaemon, readDaemonConfig } from '../paseo.js';
import { getSecret, secretStoreName, setSecret } from '../secrets.js';
import { ensureWindowsFirewall, installServices } from '../service.js';
import { status as tailscaleStatus } from '../tailscale.js';
import { CliError, IS_LINUX, IS_MAC, IS_WINDOWS, SUPPORTED_OSES, insidePaseoAgent, isWindowsToolOnWsl, nodeIsSupported, ui, which } from '../util.js';
import { ensureInstalledGlobally } from '../self-install.js';
import { canConnect } from './manage.js';
import { resharePassword } from './remote.js';
import { ask } from '../prompt.js';

export function generatePassword(length = 24) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  while (out.length < length) {
    for (const byte of crypto.randomBytes(length)) {
      // Rejection sampling keeps the distribution uniform.
      if (byte < 256 - (256 % alphabet.length) && out.length < length) out += alphabet[byte % alphabet.length];
    }
  }
  return out;
}

// Common names for a folder of repos, most common first; the first that exists is the default.
export const REPO_FOLDERS = ['src', 'code', 'projects', 'repos', 'dev', 'git', 'ws', 'workspace'];
export const defaultReposRoot = (home = os.homedir(), exists = fs.existsSync) =>
  REPO_FOLDERS.map((f) => path.join(home, f)).find((dir) => exists(dir)) ?? home;

/** A short default machine name: "mac" on macOS, otherwise the Tailscale name (e.g. "msi") if usable. */
export function defaultSelfName(tailscaleName, platform = process.platform) {
  if (platform === 'darwin') return 'mac';
  return toName(tailscaleName) ?? (platform === 'linux' ? 'linux' : 'pc');
}

export async function setup(argv) {
  const { opts } = parseArgs(argv, { name: 'string', repos: 'string', 'rotate-password': 'boolean', 'no-restart': 'boolean', 'defer-restart': 'boolean' });
  await ensureSetup(opts);
}

/**
 * Configure this machine (idempotent). Used by `setup`, and by `pair` on a machine that isn't set up yet.
 * opts: { name, repos, 'rotate-password', 'no-restart' } plus { fromPair } to skip the "next step" hint.
 */
export async function ensureSetup(opts = {}) {
  if (!SUPPORTED_OSES.includes(process.platform)) throw new CliError(`claude-wingman supports macOS, Windows and Linux; this is ${process.platform}.`);
  if (!nodeIsSupported()) throw new CliError(`Node.js 20.11 or newer is required (found ${process.version}).`);
  ensureInstalledGlobally(); // started with npx: install the command, which the skills call

  const cfg = loadConfig();
  ui.step('Checking prerequisites');
  if (!which('claude')) {
    throw new CliError('Claude Code (`claude`) is not on PATH.', { hint: 'Install it and sign in: https://code.claude.com/docs/en/setup' });
  }
  for (const tool of ['claude', 'npm']) {
    if (isWindowsToolOnWsl(which(tool))) {
      throw new CliError(`\`${tool}\` here is the Windows one (${which(tool)}); WSL needs its own.`, {
        hint: tool === 'npm' ? 'Install Node.js inside WSL, e.g.: nvm install 22   (open a new terminal first if nvm was just installed)'
          : 'Install Claude Code inside WSL: curl -fsSL https://claude.ai/install.sh | bash   then run claude once to sign in',
      });
    }
  }
  ui.ok('Claude Code found');
  if (!which('git')) ui.warn('git is not on PATH; dispatched agents need it to fetch your branches');
  const ts = tailscaleStatus();
  ui.ok(`Tailscale connected as ${ts.self.name} (${ts.self.ip})`);

  let entry = paseoEntry();
  if (!entry) {
    ui.info(`Installing Paseo ${PASEO_VERSION} (npm install -g @getpaseo/cli@${PASEO_VERSION}) ...`);
    installPaseo();
    entry = paseoEntry();
  }
  const paseoAt = paseoVersion();
  // An existing Paseo may be used for other things, and Windows locks a running daemon's files: report, don't replace.
  if (paseoAt === PASEO_VERSION) ui.ok(`Paseo ${paseoAt}`);
  else {
    ui.warn(`Paseo ${paseoAt ?? '(unknown version)'} is installed; claude-wingman is tested with ${PASEO_VERSION}. To switch: ${PASEO_INSTALL}, then: claude-wingman restart`);
  }

  const name = opts.name !== undefined || cfg.self?.name
    ? validateName(opts.name ?? cfg.self.name, 'machine name')
    : await ask('Short name for this machine (other machines use it, e.g. "run the tests on <name>")',
      defaultSelfName(ts.self.name), (v) => validateName(v, 'machine name'));
  const reposRoot = path.resolve(opts.repos ?? cfg.self?.reposRoot ?? defaultReposRoot());
  const port = cfg.self?.port ?? DEFAULT_PORT;
  const listen = `${ts.self.ip}:${port}`;

  ui.step('Daemon password');
  let password = opts['rotate-password'] ? null : getSecret('self');
  let rotated = false;
  if (password && readDaemonConfig()?.daemon?.auth?.password && !passwordMatchesDaemon(password)) {
    ui.warn('The stored password no longer matches the daemon; replacing it');
    password = null;
  }
  if (!password) {
    password = generatePassword();
    rotated = Boolean(readDaemonConfig()?.daemon?.auth?.password);
    ui.ok(rotated ? 'Generated a new daemon password (replacing the old one)' : 'Generated a daemon password');
    setSecret('self', password);
  } else {
    ui.ok(`Using the stored password (${secretStoreName()})`);
  }

  ui.step('Daemon configuration');
  const configChanged = configureDaemon({ listen, password });
  ui.ok(`Listens only on ${listen} (Tailscale); password required; relay off`);

  // Paired machines still know the old password: hand them the new one through their remote terminals,
  // before the restart below (which, when deferred, would otherwise cut this off). They take it right away;
  // this daemon switches to it when it restarts.
  if (rotated && Object.keys(cfg.peers).length) await resharePassword();

  ui.step('Autostart and keep-awake');
  // Restarting the daemon from inside one of its own agents would kill this process mid-way,
  // so in that case the restart is handed off and happens shortly after we exit.
  // --defer-restart: run from a remote terminal, which also lives under the daemon.
  const deferSeconds = insidePaseoAgent() || opts['defer-restart'] ? 20 : 0;
  const noRestart = Boolean(opts['no-restart']);
  const force = configChanged || !(await canConnect(ts.self.ip, port));
  const { restarted, pending, warnings = [] } = installServices({ entry, deferSeconds, noRestart, force });
  ui.ok(IS_MAC ? 'launchd keeps the daemon running; caffeinate blocks idle sleep'
    : IS_LINUX ? 'systemd keeps the daemon running; systemd-inhibit blocks idle sleep'
      : 'Logon task starts the daemon (and again within 2 minutes if it stops); no sleep on AC power');
  for (const w of warnings) ui.warn(w);
  if (pending) ui.warn('Not restarted (--no-restart): run "claude-wingman restart" to apply the new configuration.');
  else if (restarted && deferSeconds) ui.warn(`The daemon restarts in ~${deferSeconds}s (anything running under it is cut off then).`);
  else if (restarted) ui.ok('Daemon (re)started with this configuration');
  else ui.ok('Daemon already running with this configuration; not restarted');
  if (IS_WINDOWS) {
    const fw = ensureWindowsFirewall(port);
    if (fw.state === 'not-admin') {
      ui.info('Optional: allow only Tailscale through Windows Firewall (run once in an Administrator PowerShell):');
      ui.hint(fw.command);
    } else ui.ok(`Firewall rule (Tailscale only): ${fw.state}`);
  }

  const fresh = loadConfig(); // keep peers paired by a concurrent run
  fresh.self = {
    name, machine: ts.self.name, host: ts.self.ip, os: process.platform, port, home: os.homedir(), reposRoot,
    user: os.userInfo().username, node: process.execPath,
  };
  saveConfig(fresh);

  ui.ok(`This machine is "${name}". Repos for dispatched agents: ${reposRoot}`);
  const peers = Object.keys(cfg.peers);
  if (!opts.fromPair && !peers.length) ui.info('Next: run "claude-wingman pair" on this machine and on the other one.');
}
