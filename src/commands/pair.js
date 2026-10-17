// claude-wingman pair [<machine>...]: exchange daemon credentials with other machines over Taildrop.
// Run it on each machine (any order). Each side sends its own bundle and waits for the others'.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from '../args.js';
import { BUNDLE_PREFIX, parseBundle } from '../bundle.js';
import { configDir, loadConfig, requireSelf, saveConfig, toName, validateName } from '../config.js';
import { parseDuration } from '../dispatch.js';
import { errorText, paseo } from '../paseo.js';
import { chooseMany } from '../prompt.js';
import { setSecret } from '../secrets.js';
import { fetchBundle, sendBundle } from '../share.js';
import { ensureInstalledGlobally } from '../self-install.js';
import { assertSkillInstallable, installSkill, renderSkill } from '../skill.js';
import { receiveFiles, resolveMachine, status as tailscaleStatus } from '../tailscale.js';
import { CliError, osLabel, sleep, ui } from '../util.js';
import { ensureSetup } from './setup.js';
import { introduce } from './remote.js';

/**
 * Credential files received so far, grouped by sender IP: the newest valid bundle per sender, plus all its
 * files (deleted only after a successful import). Each unusable file is reported once.
 */
function receivedBundles(expectedIps, reported) {
  const bySender = new Map();
  for (const file of receiveFiles(path.join(configDir(), 'inbox'), BUNDLE_PREFIX)) {
    let bundle;
    try {
      bundle = parseBundle(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (!reported.has(file)) ui.warn(`Ignoring ${file}: ${err.message}`);
      reported.add(file);
      continue;
    }
    if (!expectedIps.has(bundle.host)) {
      if (!reported.has(file)) {
        ui.warn(`Ignoring ${file}: it is from ${bundle.host}, which isn't being paired now. Delete it if you don't need it; it contains a password.`);
      }
      reported.add(file);
      continue;
    }
    const entry = bySender.get(bundle.host) ?? { bundle, files: [] };
    if (Date.parse(bundle.createdAt) > Date.parse(entry.bundle.createdAt)) entry.bundle = bundle;
    entry.files.push(file);
    bySender.set(bundle.host, entry);
  }
  return bySender;
}

/**
 * Machines that can be paired: online macOS, Windows and Linux machines with an IPv4 address that belong
 * to the same Tailscale user as this one. Shared-in and tagged machines (other owners) are never offered.
 */
export const pairCandidates = (peers, self) =>
  peers.filter((m) => m.online && m.ip && !m.shared && m.userId === self.userId && /^(macos|windows|linux)$/i.test(m.os ?? ''));

/** The machines to pair with when none were named: the only candidate, all of them, or a choice. */
async function pickMachines(ts, all) {
  const candidates = pairCandidates(ts.peers, ts.self);
  if (!candidates.length) {
    throw new CliError('No other computer of yours is online on Tailscale.', {
      hint: 'Sign in to Tailscale on the other machine with the same account, or name it: claude-wingman pair <machine>',
    });
  }
  const tsOs = { macos: 'macOS', windows: 'Windows', linux: 'Linux' };
  const label = (m) => `${m.name} (${tsOs[m.os.toLowerCase()] ?? m.os}, ${m.ip})`;
  if (candidates.length === 1) {
    ui.info(`Pairing with ${label(candidates[0])}, your only other computer online`);
    return candidates;
  }
  if (all) return candidates;
  return chooseMany('Pair with which machines?', candidates, label, {
    hint: `Name them (claude-wingman pair ${candidates.map((m) => m.name).join(' ')}) or pass --all.`,
  });
}

/**
 * The name this machine will use for a newly paired one: --name if given; the name it already has here
 * (re-pairing); else its own name, its Tailscale name, or its name plus a number, whichever is free.
 */
export function peerAlias(bundle, cfg, explicit) {
  const owner = (n) => (Object.hasOwn(cfg.peers, n) ? cfg.peers[n] : null);
  if (explicit) {
    if (explicit === cfg.self.name) throw new CliError(`"${explicit}" is this machine's own name.`);
    if (owner(explicit) && owner(explicit).host !== bundle.host) {
      throw new CliError(`"${explicit}" is already the name of another paired machine (${owner(explicit).machine}).`, { hint: 'Pick another --name.' });
    }
    return explicit;
  }
  const existing = Object.keys(cfg.peers).find((n) => cfg.peers[n].host === bundle.host);
  if (existing) return existing;
  const free = (n) => n && n !== cfg.self.name && !owner(n);
  for (const candidate of [bundle.name, toName(bundle.machine)]) if (free(candidate)) return candidate;
  for (let i = 2; ; i++) {
    const candidate = `${bundle.name.slice(0, 27)}-${i}`;
    if (free(candidate)) return candidate;
  }
}

/** Save a received bundle as a peer and write its skill. Returns the alias. */
function importBundle({ bundle, files }, explicitName) {
  const cfg = loadConfig(); // fresh: another pair may have saved while we waited
  const alias = peerAlias(bundle, cfg, explicitName);
  // Check what can fail before changing anything, so a failed import leaves no half-paired peer.
  assertSkillInstallable(alias);
  setSecret(`peer:${alias}`, bundle.password);
  cfg.peers[alias] = {
    host: bundle.host, port: bundle.port, os: bundle.os, home: bundle.home, reposRoot: bundle.reposRoot,
    machine: bundle.machine, remoteName: bundle.name, pairedAt: new Date().toISOString(),
    ...(bundle.version ? { version: bundle.version } : {}),
  };
  saveConfig(cfg);
  const skillFile = installSkill(alias, renderSkill(alias, cfg.peers[alias]));
  for (const file of files) fs.rmSync(file, { force: true }); // they hold a password; gone once imported
  const renamed = alias !== bundle.name ? ` (it calls itself "${bundle.name}"; that name is taken here)` : '';
  ui.ok(`Paired with ${alias}${renamed}: ${bundle.machine}, ${osLabel(bundle.os)}, ${bundle.host}`);
  ui.ok(`Installed skill: ${skillFile}`);
  const check = paseo(['ls'], { host: `${bundle.host}:${bundle.port}`, password: bundle.password, timeoutMs: 30_000 });
  if (check.code === 0) ui.ok(`Connected to ${alias}'s daemon`);
  else ui.warn(`Can't reach ${alias}'s daemon yet (${errorText(check)}). If it was just set up, give it a minute and run: claude-wingman status`);
  return alias;
}

export async function pair(argv) {
  const { opts, positionals } = parseArgs(argv, {
    name: 'string', as: 'string', repos: 'string', all: 'boolean', 'send-only': 'boolean', 'receive-only': 'boolean', timeout: 'string',
    'no-introduce': 'boolean', 'from-url': 'string',
  });
  if (opts['send-only'] && opts['receive-only']) throw new CliError('Use --send-only or --receive-only, not both.');
  if (opts.name && (positionals.length > 1 || opts.all)) throw new CliError('--name renames one machine; pair with a single machine to use it.');
  if (opts.all && positionals.length) throw new CliError('Name machines or pass --all, not both.');
  if (opts.name) validateName(opts.name, 'peer name');
  if (opts.as) validateName(opts.as, 'machine name');
  const timeoutSeconds = parseDuration(opts.timeout ?? '10m');

  // Credentials handed over by another of the user's machines (claude-wingman update/remote, password changes).
  if (opts['from-url']) {
    requireSelf();
    importBundle({ bundle: await fetchBundle(opts['from-url']), files: [] }, opts.name);
    return 0;
  }

  // One command per machine: install the command (when run with npx) and set this machine up first.
  ensureInstalledGlobally();
  let cfg = loadConfig();
  if (!cfg.self) {
    ui.step('Setting up this machine first');
    await ensureSetup({ name: opts.as, repos: opts.repos, fromPair: true });
    cfg = requireSelf();
    ui.step('Pairing');
  } else if ((opts.as && opts.as !== cfg.self.name) || opts.repos) {
    ui.warn(`This machine is already set up as "${cfg.self.name}"; --as/--repos are ignored. To change them: claude-wingman setup --name <name> --repos <dir>`);
  }

  const ts = tailscaleStatus();
  const picked = positionals.length ? positionals.map(resolveMachine) : await pickMachines(ts, opts.all);
  const machines = [...new Map(picked.map((m) => [m.ip, m])).values()];
  for (const m of machines) {
    if (!m.ip) throw new CliError(`${m.name} has no Tailscale IPv4 address.`);
    if (m.ip === ts.self.ip) throw new CliError(`${m.name} is this machine.`);
  }

  const failed = [];
  if (!opts['receive-only']) {
    for (const m of machines) {
      if (!m.online) ui.warn(`${m.name} looks offline; Taildrop will deliver when it's back.`);
      try {
        sendBundle(cfg, m, ts.self.ip);
        ui.ok(`Sent this machine's credentials to ${m.name} (Taildrop, end-to-end encrypted)`);
      } catch (err) {
        if (!(err instanceof CliError)) throw err;
        ui.fail(`${m.name}: ${err.message}`);
        if (err.hint) ui.hint(err.hint);
        failed.push(m.name);
      }
    }
  }
  if (opts['send-only']) {
    for (const m of machines) if (!failed.includes(m.name)) ui.info(`On ${m.name}, run: claude-wingman pair ${cfg.self.machine}`);
    return failed.length ? 1 : 0;
  }

  // Wait for each machine's credentials, importing each as it arrives.
  let pending = machines.filter((m) => !failed.includes(m.name));
  const startedAt = Date.now();
  const before = loadConfig().peers;
  const newlyPaired = [];
  const deadline = Date.now() + timeoutSeconds * 1000;
  const reported = new Set();
  let announced = false;
  while (pending.length) {
    const received = receivedBundles(new Set(pending.map((m) => m.ip)), reported);
    const now = loadConfig().peers;
    for (const m of [...pending]) {
      // Another pair run (e.g. one started remotely) may have imported this machine's credentials first.
      const importedElsewhere = Object.entries(now).find(([, p]) => p.host === m.ip && Date.parse(p.pairedAt) >= startedAt);
      const found = received.get(m.ip);
      if (!found && !importedElsewhere) continue;
      pending = pending.filter((p) => p !== m);
      if (!found) {
        ui.ok(`Paired with ${importedElsewhere[0]} (${m.name}), imported by another claude-wingman run`);
        continue;
      }
      try {
        const alias = importBundle(found, opts.name);
        if (!Object.values(before).some((p) => p.host === m.ip)) newlyPaired.push(alias);
      } catch (err) {
        if (!(err instanceof CliError)) throw err;
        ui.fail(`${m.name}: ${err.message}`);
        if (err.hint) ui.hint(err.hint);
        failed.push(m.name);
      }
    }
    if (!pending.length || Date.now() >= deadline) break;
    if (!announced) {
      for (const m of pending) ui.info(`Waiting for ${m.name}'s credentials. On ${m.name}, run: claude-wingman pair ${cfg.self.machine}`);
      announced = true;
    }
    await sleep(3000);
  }
  for (const m of pending) {
    ui.fail(`Timed out waiting for credentials from ${m.name}.`);
    ui.hint(`Run "claude-wingman pair ${cfg.self.machine}" on ${m.name}, then here: claude-wingman pair ${m.name} --receive-only`);
  }
  // A machine new to this one also gets paired with this one's other machines, remotely.
  let introduced = true;
  if (!opts['no-introduce']) for (const alias of newlyPaired) introduced = (await introduce(alias)) && introduced;
  const paired = machines.length - failed.length - pending.length;
  if (paired) ui.info('Try it: in claude, ask "run the tests for <project> on <machine>"');
  return failed.length || pending.length || !introduced ? 1 : 0;
}
