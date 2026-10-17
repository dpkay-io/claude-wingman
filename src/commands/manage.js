// claude-wingman skill | unpair | restart | uninstall
import fs from 'node:fs';
import net from 'node:net';
import { parseArgs } from '../args.js';
import { configDir, loadConfig, requirePeer, requireSelf, saveConfig } from '../config.js';
import { paseoEntry, requirePaseo } from '../paseo.js';
import { deleteSecret } from '../secrets.js';
import { removeServices, restartDaemon } from '../service.js';
import { installSkill, removeSkill, renderSkill } from '../skill.js';
import { CliError, IS_WINDOWS, insidePaseoAgent, ui } from '../util.js';

/** Resolve true if a TCP connection to host:port succeeds within timeoutMs. */
export function canConnect(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export function skill() {
  const cfg = requireSelf();
  const names = Object.keys(cfg.peers);
  if (!names.length) return ui.info('No peers, so no skills to write.');
  for (const name of names) ui.ok(`Wrote ${installSkill(name, renderSkill(name, cfg.peers[name]))}`);
}

export function unpair(argv) {
  const { positionals } = parseArgs(argv);
  const [name] = positionals;
  if (!name) throw new CliError('Usage: claude-wingman unpair <peer>');
  const cfg = requireSelf();
  requirePeer(cfg, name);
  delete cfg.peers[name];
  saveConfig(cfg);
  deleteSecret(`peer:${name}`);
  removeSkill(name);
  ui.ok(`Unpaired ${name} (password, config and skill removed). ${name} can still reach this machine until it unpairs too or you run: claude-wingman setup --rotate-password`);
}

export function restart() {
  requireSelf();
  const deferSeconds = insidePaseoAgent() ? 20 : 0;
  restartDaemon({ entry: requirePaseo(), deferSeconds });
  if (deferSeconds) ui.ok(`Daemon restart scheduled in ~${deferSeconds}s`);
  else if (IS_WINDOWS) ui.ok('Daemon restart started (Task Scheduler); it is back in a few seconds');
  else ui.ok('Daemon restarted');
}

export function uninstall(argv) {
  const { opts } = parseArgs(argv, { yes: 'boolean' });
  if (insidePaseoAgent()) {
    throw new CliError("Uninstall stops the daemon this agent runs under, so it can't run from a dispatched agent.", { hint: 'Run it in a terminal on this machine.' });
  }
  if (!opts.yes) {
    throw new CliError('This removes autostart, keep-awake, stored passwords, paired peers and their skills.', {
      hint: 'Run again with --yes to confirm. (Paseo itself stays installed: npm rm -g @getpaseo/cli)',
    });
  }
  const cfg = loadConfig();
  let entry = null;
  try {
    entry = paseoEntry();
  } catch {} // npm missing: still remove everything else
  removeServices({ entry });
  ui.ok('Removed autostart and keep-awake; daemon stopped');
  for (const name of Object.keys(cfg.peers)) {
    deleteSecret(`peer:${name}`);
    if (removeSkill(name)) ui.ok(`Removed skill ${name}`);
  }
  deleteSecret('self');
  fs.rmSync(configDir(), { recursive: true, force: true });
  ui.ok('Removed passwords and configuration');
}
