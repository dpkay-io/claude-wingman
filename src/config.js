// claude-wingman configuration: this machine's identity and its paired peers.
// Stored as JSON in ~/.claude-wingman/config.json. Passwords are never stored here (see secrets.js).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CliError } from './util.js';

export const DEFAULT_PORT = 6767;
export const COMMANDS = new Set([
  'help', 'version', 'doctor', 'setup', 'pair', 'unpair', 'peers', 'status', 'dispatch',
  'verify', 'skill', 'restart', 'uninstall', 'remote', 'update', 'cancel', 'pause', 'resume', 'logs', 'run',
]);

export const configDir = () => process.env.CLAUDE_WINGMAN_HOME || path.join(os.homedir(), '.claude-wingman');
export const configPath = () => path.join(configDir(), 'config.json');

/** Peer and machine names become skill names, file names and CLI words, so keep them simple. */
export function validateName(name, what = 'name') {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(name ?? '')) {
    throw new CliError(`Invalid ${what} "${name}".`, {
      hint: 'Use 1-31 lowercase letters, digits or hyphens, starting with a letter (e.g. "mac", "msi", "work-pc").',
    });
  }
  if (COMMANDS.has(name)) {
    throw new CliError(`"${name}" is a claude-wingman command and can't be used as a ${what}.`);
  }
  return name;
}

/** A valid name made from free text such as a Tailscale machine name ("Work PC" -> "work-pc"), or null. */
export function toName(text) {
  const cleaned = String(text ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+|-+$/g, '').slice(0, 31).replace(/-+$/, '');
  try {
    return validateName(cleaned);
  } catch {
    return null;
  }
}

export function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    cfg.peers ??= {};
    return cfg;
  } catch (err) {
    if (err.code === 'ENOENT') return { version: 1, self: null, peers: {} };
    throw new CliError(`Can't read ${configPath()}: ${err.message}`);
  }
}

export function saveConfig(cfg) {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const tmp = `${configPath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, configPath());
}

/** Load config and require that `claude-wingman setup` has run. */
export function requireSelf() {
  const cfg = loadConfig();
  if (!cfg.self) throw new CliError('This machine is not set up yet.', { hint: 'Run: claude-wingman setup' });
  return cfg;
}

export function requirePeer(cfg, name) {
  const peer = Object.hasOwn(cfg.peers, name) ? cfg.peers[name] : undefined;
  if (!peer) {
    const known = Object.keys(cfg.peers);
    throw new CliError(`Unknown peer "${name}".`, {
      hint: known.length ? `Paired peers: ${known.join(', ')}` : 'No peers yet. Pair one with: claude-wingman pair <machine>',
    });
  }
  return peer;
}
