// Manage paired machines from this one, through remote terminals (see remote.js):
//   claude-wingman remote <machine>|--all <claude-wingman command...>
//   claude-wingman run <machine>|--all [--cwd <dir>] [--timeout 10m] -- <command>   any command, for the user
//   claude-wingman update [<machine>...]          install this machine's version everywhere
// plus introducing a newly paired machine to the others, and re-sharing a rotated password.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../args.js';
import { loadConfig, requireSelf, saveConfig } from '../config.js';
import { remoteExec, quoteArg } from '../remote.js';
import { paseo } from '../paseo.js';
import { bundleFor, serveOnce } from '../share.js';
import { CliError, IS_WINDOWS, VERSION, run, sleep, ui } from '../util.js';
import { canConnect } from './manage.js';
import { peerConnection } from './dispatch.js';
import { parseDuration, resolveRepoPath } from '../dispatch.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** "claude-wingman <args>" quoted for the machine's shell. */
const wingman = (args, osName) => ['claude-wingman', ...args.map((a) => quoteArg(a, osName))].join(' ');

const indent = (text) => text.split('\n').map((l) => `    ${l}`).join('\n');

function targetsFrom(cfg, names) {
  const all = Object.keys(cfg.peers);
  if (!all.length) throw new CliError('No paired machines yet.', { hint: 'Pair one first: claude-wingman pair' });
  return names.length ? names.map((n) => (peerConnection(cfg, n), n)) : all;
}

/** claude-wingman remote <machine>|--all <claude-wingman args...> */
export async function remote(argv) {
  const [target, ...args] = argv;
  if (!target || !args.length) {
    throw new CliError('Usage: claude-wingman remote <machine>|--all <claude-wingman command>', { hint: 'e.g. claude-wingman remote msi verify   or   claude-wingman remote --all version' });
  }
  const cfg = requireSelf();
  const names = target === '--all' ? targetsFrom(cfg, []) : [target];
  let failed = 0;
  for (const name of names) {
    const t = peerConnection(cfg, name);
    ui.step(`${name}: claude-wingman ${args.join(' ')}`);
    try {
      const res = await remoteExec(t, wingman(args, t.peer.os), { timeoutSeconds: 900, label: `from ${cfg.self.name}: claude-wingman ${args.join(' ')}` });
      if (res.output.trim()) console.log(res.output.replace(/^\n+/, ''));
      if (!res.ok) failed++;
      if (scheduledRestart(res.output)) {
        ui.info(`Waiting for ${name}'s daemon to restart ...`);
        if (await waitForDaemon(name)) ui.ok(`${name} is back`);
        else {
          ui.fail(`${name}'s daemon didn't come back. Check: claude-wingman status`);
          failed++;
        }
      }
    } catch (err) {
      if (!(err instanceof CliError)) throw err;
      ui.fail(err.message);
      if (err.hint) ui.hint(err.hint);
      failed++;
    }
  }
  return failed ? 1 : 0;
}

const RUN_USAGE = 'Usage: claude-wingman run <machine>|--all [--cwd <dir>] [--timeout 10m] -- <command>';

/**
 * Split `run` arguments into our options and the command. Everything after `--` is the command; without `--`, the
 * command starts at the first word that isn't one of our options, so `run msi git log --oneline` works too.
 */
export function parseRunArgs(argv) {
  const sep = argv.indexOf('--');
  let head;
  let command;
  if (sep !== -1) {
    head = argv.slice(0, sep);
    command = argv.slice(sep + 1);
  } else {
    let i = 0;
    let target = false;
    let sawAll = false;
    // The target (unless --all), then any of our options; the first other word starts the command.
    for (; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--all') sawAll = true;
      else if (a === '--cwd' || a === '--timeout') i++;
      else if (/^--(cwd|timeout)=/.test(a)) continue;
      else if (!target && !sawAll && !a.startsWith('-')) target = true;
      else break;
    }
    head = argv.slice(0, i);
    command = argv.slice(i);
  }
  const { opts, positionals } = parseArgs(head, { all: 'boolean', cwd: 'string', timeout: 'string' });
  if (positionals.length > 1) throw new CliError(`Put the command after --: claude-wingman run ${positionals[0]} -- ${positionals.slice(1).join(' ')} ...`);
  const text = command.join(' ').trim();
  if ((!positionals[0] && !opts.all) || (positionals[0] && opts.all) || !text) throw new CliError(RUN_USAGE, { hint: 'e.g. claude-wingman run msi -- git -C myapp status' });
  return { target: positionals[0], all: Boolean(opts.all), cwd: opts.cwd, timeoutSeconds: parseDuration(opts.timeout ?? '10m'), command: text };
}

/**
 * claude-wingman run <machine>|--all ... -- <command>: run a shell command there (cmd.exe on Windows, sh elsewhere)
 * and print its output. Like SSH, for the user: it runs with the user's rights and without the safety checks a
 * dispatched agent has, which is why the skills tell Claude to use `dispatch` instead.
 * With one machine, only the command's output is printed (so it can be piped); the exit code is 0 or 1.
 */
export async function runCommand(argv) {
  const { target, all, cwd, timeoutSeconds, command } = parseRunArgs(argv);
  const cfg = requireSelf();
  const names = all ? targetsFrom(cfg, []) : [target];
  let failed = 0;
  for (const name of names) {
    const t = peerConnection(cfg, name);
    if (all) ui.step(`${name}: ${command}`);
    try {
      const res = await remoteExec(t, command, {
        timeoutSeconds,
        cwd: cwd ? resolveRepoPath(t.peer, cwd, '--cwd') : t.peer.home,
        label: `from ${cfg.self.name}: run ${command}`,
      });
      if (res.output) process.stdout.write(`${res.output}\n`);
      if (!res.ok) {
        failed++;
        if (all) ui.fail(`Failed on ${name}`);
      }
    } catch (err) {
      if (!(err instanceof CliError)) throw err;
      ui.fail(err.message);
      if (err.hint) ui.hint(err.hint);
      failed++;
    }
  }
  return failed ? 1 : 0;
}

const scheduledRestart = (output) => /restarts in ~\d+s/.test(output);

/**
 * After a command there scheduled a (deferred) daemon restart: wait until the new daemon answers with the password
 * this machine now holds for it. Until the restart, the old daemon still runs (with the old password, if it changed).
 */
async function waitForDaemon(name, seconds = 120) {
  const deadline = Date.now() + seconds * 1000;
  await sleep(22_000);
  while (Date.now() < deadline) {
    const { peer, conn } = peerConnection(loadConfig(), name); // re-read: the password may have just changed
    if ((await canConnect(peer.host, peer.port, 3000)) && paseo(['ls', '--json'], { ...conn, timeoutMs: 30_000 }).code === 0) return true;
    await sleep(3000);
  }
  return false;
}

/** claude-wingman update [<machine>...]: install this machine's exact version on paired machines. */
export async function update(argv) {
  const cfg = requireSelf();
  const names = targetsFrom(cfg, parseArgs(argv).positionals);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-wingman-update-'));
  try {
    const pack = run('npm', ['pack', PACKAGE_ROOT, '--pack-destination', dir].map((a) => (IS_WINDOWS ? `"${a}"` : a)), { shell: IS_WINDOWS, timeoutMs: 300_000 });
    const tarball = fs.readdirSync(dir).find((f) => f.endsWith('.tgz'));
    if (pack.code !== 0 || !tarball) throw new CliError(`Packing claude-wingman failed: ${pack.stderr || pack.stdout}`);
    ui.info(`Installing claude-wingman ${VERSION} from this machine on: ${names.join(', ')}`);
    let failed = 0;
    await serveOnce(cfg.self.host, tarball, fs.readFileSync(path.join(dir, tarball)), async (url) => {
      for (const name of names) {
        const t = peerConnection(cfg, name);
        ui.step(`${name} (${t.peer.machine})`);
        try {
          // The new version's own setup applies any service changes; its restart waits until this terminal is done.
          // npm 12 refuses tarball URLs unless allowed; older npm accepts the option silently.
          const res = await remoteExec(t, `npm install -g --allow-remote=all ${url} && ${wingman(['setup', '--defer-restart'], t.peer.os)} && ${wingman(['skill'], t.peer.os)}`, { timeoutSeconds: 900, label: `from ${cfg.self.name}: update to ${VERSION}` });
          if (!res.ok) {
            ui.fail(`Update failed on ${name}:`);
            console.log(indent(res.output.split('\n').slice(-15).join('\n')));
            failed++;
            continue;
          }
          if (scheduledRestart(res.output) && !(await waitForDaemon(name))) {
            ui.fail(`${name}'s daemon didn't come back after the restart. On ${name}: claude-wingman restart`);
            failed++;
            continue;
          }
          const ver = await remoteExec(t, wingman(['version'], t.peer.os), { timeoutSeconds: 120, label: `from ${cfg.self.name}: claude-wingman version` });
          if (ver.ok && ver.output.trim() === VERSION) {
            ui.ok(`${name} runs claude-wingman ${VERSION}`);
            const now = loadConfig(); // fresh: the restart wait may have reloaded a new password
            if (now.peers[name]) {
              now.peers[name].version = VERSION;
              saveConfig(now);
            }
          }
          else {
            ui.fail(`${name} reports version "${ver.output.trim()}", expected ${VERSION}`);
            failed++;
          }
        } catch (err) {
          if (!(err instanceof CliError)) throw err;
          ui.fail(`${name}: ${err.message}`);
          if (err.hint) ui.hint(err.hint);
          failed++;
        }
      }
    }, { once: false });
    return failed ? 1 : 0;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Hand `bundle` to machine `t` through its remote terminal (pair --from-url). Returns the remote result. */
async function handOver(cfg, t, bundle) {
  return serveOnce(cfg.self.host, 'credentials.json', Buffer.from(JSON.stringify(bundle)), (url) =>
    remoteExec(t, wingman(['pair', '--from-url', url], t.peer.os), { timeoutSeconds: 180, label: `from ${cfg.self.name}: pairing` }));
}

const tooOld = (res) => /Unknown option --from-url/.test(res.output);

function reportHandOver(res, what, where) {
  if (res.ok) return true;
  ui.fail(`${what} failed on ${where}:`);
  console.log(indent(res.output.split('\n').slice(-6).join('\n')));
  if (tooOld(res)) ui.hint(`${where} runs an older claude-wingman; update it first: claude-wingman update ${where}`);
  return false;
}

/**
 * After pairing with `newName`, pair it with this machine's other paired machines too, so adding a machine never
 * means visiting the existing ones. This machine knows both sides' credentials, so it hands each to the other.
 */
export async function introduce(newName) {
  const cfg = loadConfig();
  const others = Object.keys(cfg.peers).filter((n) => n !== newName);
  if (!others.length) return true;
  ui.step(`Pairing ${newName} with your other machines (${others.join(', ')})`);
  const x = peerConnection(cfg, newName);
  let allOk = true;
  for (const name of others) {
    const p = peerConnection(cfg, name);
    try {
      const ok = reportHandOver(await handOver(cfg, p, bundleFor(cfg, newName)), `Adding ${newName}`, name)
        && reportHandOver(await handOver(cfg, x, bundleFor(cfg, name)), `Adding ${name}`, newName);
      if (ok) ui.ok(`${newName} and ${name} are paired`);
      allOk &&= ok;
    } catch (err) {
      if (!(err instanceof CliError)) throw err;
      allOk = false;
      ui.fail(`Pairing ${newName} with ${name}: ${err.message}`);
    }
  }
  return allOk;
}

/** After this machine's password changed: give every paired machine the new one, through its remote terminal. */
export async function resharePassword() {
  const cfg = loadConfig();
  const names = Object.keys(cfg.peers);
  if (!names.length) return true;
  ui.step(`Sharing the new password with ${names.join(', ')}`);
  let allOk = true;
  for (const name of names) {
    try {
      const ok = reportHandOver(await handOver(cfg, peerConnection(cfg, name), bundleFor(cfg)), 'Taking the new password', name);
      if (ok) ui.ok(`${name} has the new password`);
      allOk &&= ok;
    } catch (err) {
      if (!(err instanceof CliError)) throw err;
      allOk = false;
      ui.fail(`${name}: ${err.message}`);
    }
  }
  if (!allOk) ui.hint(`For the others, run "claude-wingman pair ${cfg.self.machine}" on them and "claude-wingman pair <machine>" here.`);
  return allOk;
}
