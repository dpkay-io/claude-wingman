// See and control what runs on your machines, from any of them:
//   claude-wingman status [<machine>...] [--all] [--watch] [--json]
//   claude-wingman cancel|pause <id>    claude-wingman resume <id> ["<message>"]    claude-wingman logs <id> [--follow]
// An <id> (or the start of one) names an agent, or a remote command for cancel, on whichever machine runs it.
import { parseArgs } from '../args.js';
import { requireSelf } from '../config.js';
import { errorText, paseo, paseoAsync, paseoInteractive } from '../paseo.js';
import { TERMINAL_PREFIX, stopWindowsCommand } from '../remote.js';
import { getSecret } from '../secrets.js';
import { CliError, IS_WINDOWS, VERSION, osLabel, paint, sleep, ui } from '../util.js';
import { serviceStatus } from '../service.js';
import { canConnect } from './manage.js';
import { peerConnection } from './dispatch.js';

/** Paseo has no paused or cancelled state (both are just idle), so claude-wingman records them in this label. */
const STATE_LABEL = 'wingman-state';
const RESUME_MESSAGE = 'You were paused. Continue the task where you left off.';
const ACTIVE = new Set(['running', 'starting', 'needs permission']);

const LOOK = {
  running: { mark: IS_WINDOWS ? '>' : '▶', color: 36 },
  starting: { mark: IS_WINDOWS ? '>' : '▶', color: 36 },
  'needs permission': { mark: '?', color: 33 },
  paused: { mark: IS_WINDOWS ? '=' : '‖', color: 33 },
  failed: { mark: IS_WINDOWS ? 'x' : '✗', color: 31 },
  cancelled: { mark: IS_WINDOWS ? '-' : '✗', color: 2 },
  // Finished its turn: Claude Code reports a failed task (even a model that doesn't exist) as an ordinary reply.
  finished: { mark: IS_WINDOWS ? '-' : '✓', color: 2 },
  command: { mark: IS_WINDOWS ? '>' : '▶', color: 35 },
};

/** This machine and the paired ones (or just `names`), each with a connection or the reason there is none. */
function machines(cfg, names = []) {
  const s = cfg.self;
  const all = [
    { name: s.name, self: true, peer: s, conn: { host: `${s.host}:${s.port}`, password: getSecret('self') } },
    ...Object.keys(cfg.peers).map((n) => {
      try {
        return { ...peerConnection(cfg, n), self: false };
      } catch (err) {
        return { name: n, self: false, peer: cfg.peers[n], error: err.message };
      }
    }),
  ];
  if (!names.length) return all;
  return names.map((n) => all.find((m) => m.name === n) ?? peerConnection(cfg, n)); // throws "unknown peer" helpfully
}

/** What paseo's status (plus our label and pending permissions) means for the user. */
export function agentState(status, { label, waiting }) {
  if (waiting) return 'needs permission';
  if (status === 'running') return 'running';
  if (status === 'initializing') return 'starting';
  if (status === 'error') return 'failed';
  if (status === 'idle' || status === 'closed') return label === 'paused' || label === 'cancelled' ? label : 'finished';
  return status;
}

const parseList = (res) => {
  try {
    return res.code === 0 ? JSON.parse(res.stdout) : [];
  } catch {
    return [];
  }
};

/** One machine's agents and remote commands, newest first. Never includes the connection (no password in --json). */
async function snapshot(m) {
  // version: this machine's, or the one a paired machine last reported (when pairing, or after `update`).
  const base = { machine: m.name, thisMachine: m.self, os: m.peer?.os, host: m.peer?.host, version: m.self ? VERSION : (m.peer?.version ?? null) };
  if (m.error) return { ...base, reachable: false, error: m.error };
  if (!(await canConnect(m.peer.host, m.peer.port))) return { ...base, reachable: false, error: 'unreachable (asleep, offline, or Tailscale down)' };
  const opts = { ...m.conn, timeoutMs: 30_000 };
  const [ls, paused, cancelled, permits, terminals] = await Promise.all([
    paseoAsync(['ls', '-g', '--json'], opts),
    paseoAsync(['ls', '-g', '--label', `${STATE_LABEL}=paused`, '--json'], opts),
    paseoAsync(['ls', '-g', '--label', `${STATE_LABEL}=cancelled`, '--json'], opts),
    paseoAsync(['permit', 'ls', '--json'], opts),
    paseoAsync(['terminal', 'ls', '--all', '--json'], opts),
  ]);
  if (ls.code !== 0) return { ...base, reachable: false, error: errorText(ls) };
  const labels = new Map([...parseList(paused).map((a) => [a.id, 'paused']), ...parseList(cancelled).map((a) => [a.id, 'cancelled'])]);
  const waiting = new Set(parseList(permits).map((p) => p.agentId));
  const agents = parseList(ls).map((a) => ({
    id: a.id,
    shortId: a.shortId ?? a.id.slice(0, 7),
    state: agentState(a.status, { label: labels.get(a.id), waiting: waiting.has(a.id) }),
    title: a.name,
    cwd: a.cwd,
    started: a.created,
  }));
  const commands = parseList(terminals)
    // Leave out the terminal this command itself runs in (status run through `remote`).
    .filter((t) => t.name?.startsWith(TERMINAL_PREFIX) && t.id !== process.env.PASEO_TERMINAL_ID)
    .map((t) => ({ id: t.id, shortId: t.id.slice(0, 7), name: t.name, state: 'running', title: /^wingman-[0-9a-f]+: (.+)/.exec(t.name)?.[1] ?? 'started by an older claude-wingman' }));
  return { ...base, reachable: true, agents, commands };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function summary(snap) {
  const counts = {};
  for (const a of snap.agents) counts[a.state] = (counts[a.state] ?? 0) + 1;
  const parts = ['running', 'starting', 'needs permission', 'paused', 'failed'].filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`);
  if (snap.commands.length) parts.push(plural(snap.commands.length, 'remote command'));
  return parts.length ? parts.join(', ') : 'nothing running';
}

const fit = (text, width) => (text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text);

/** The status screen as lines of text. Shows everything active, plus the latest few finished agents (all with --all). */
export function renderStatus(snaps, { all = false, recent = 3, width = 100, notes = [] } = {}) {
  const lines = [];
  // A narrow terminal drops the "started" column.
  const started = (when) => (width >= 80 ? `${(when ?? '').replace(/^1 (\w+)s ago$/, '1 $1 ago').padEnd(15)} ` : '');
  const row = (look, id, state, when, title = '', folder = '') => {
    const head = `  ${look.mark} ${id}  ${state.padEnd(16)} ${started(when)}`;
    // The title matters most; the folder gets what's left (shortened from the left, where paths are least telling).
    const room = Math.max(12, width - head.length);
    const t = fit(title, folder ? Math.max(Math.min(30, room), room - Math.min(folder.length, 28) - 2) : room);
    const left = room - t.length - 2;
    const f = !folder || left < 8 ? '' : folder.length > left ? `…${folder.slice(-(left - 1))}` : folder;
    lines.push(`${paint(look.color, `  ${look.mark} ${id}  ${state.padEnd(16)}`)} ${started(when)}${t}${f ? `  ${ui.dim(f)}` : ''}`);
  };
  for (const snap of snaps) {
    const about = [snap.os && osLabel(snap.os), snap.host, snap.version && `v${snap.version}`].filter(Boolean).join(' · ');
    const name = ui.bold(snap.machine) + ui.dim(`${snap.thisMachine ? ' (this machine)' : ''}${about ? `  ${about}` : ''}`);
    if (!snap.reachable) {
      lines.push(`${name}  ${paint(31, snap.error)}`, '');
      continue;
    }
    lines.push(`${name}  ${summary(snap)}`);
    for (const c of snap.commands) row(LOOK.command, c.shortId, 'remote command', '', c.title);
    const active = snap.agents.filter((a) => ACTIVE.has(a.state) || a.state === 'paused' || a.state === 'failed');
    const finished = snap.agents.filter((a) => !active.includes(a));
    const shown = all ? finished : finished.slice(0, recent);
    for (const a of [...active, ...shown]) row(LOOK[a.state] ?? LOOK.running, a.shortId, a.state, a.started, a.title, a.cwd);
    if (shown.length < finished.length) lines.push(ui.dim(`    + ${finished.length - shown.length} earlier (claude-wingman status --all)`));
    lines.push('');
  }
  for (const note of notes) lines.push(`${paint(33, IS_WINDOWS ? '[!]' : '!')} ${note}`);
  if (notes.length) lines.push('');
  return lines;
}

/** -1, 0 or 1, comparing "1.2.3" style versions (a pre-release counts as older than its release). */
export function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v).split('-');
    return [...core.split('.').map(Number), pre ? 0 : 1];
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 4; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
  return 0;
}

/** Warnings under the status screen: paired machines on another version, and this machine's services. */
export function statusNotes(snaps, svc = null) {
  const notes = [];
  for (const snap of snaps) {
    if (snap.thisMachine || !snap.version || snap.version === VERSION) continue;
    notes.push(compareVersions(snap.version, VERSION) < 0
      ? `${snap.machine} runs claude-wingman ${snap.version} (last seen), this machine ${VERSION}. Bring it up to date: claude-wingman update ${snap.machine}`
      : `${snap.machine} runs a newer claude-wingman (${snap.version}) than this machine (${VERSION}). Update this one: claude-wingman remote ${snap.machine} update <this machine>, or npm install -g claude-wingman@latest`);
  }
  if (svc && !svc.autostart) notes.push("This machine's daemon doesn't start automatically: claude-wingman setup");
  if (svc && svc.awake === false) notes.push('This machine may go to sleep (keep-awake is off): claude-wingman setup');
  if (svc?.wsl && !svc.wsl.running) notes.push(`WSL may stop when its last window closes (${svc.wsl.detail}): claude-wingman setup`);
  return notes;
}

/** claude-wingman status [<machine>...] [--all] [--watch] [--json] */
export async function status(argv) {
  const { opts, positionals } = parseArgs(argv, { all: 'boolean', watch: 'boolean', json: 'boolean' });
  if (opts.watch && opts.json) throw new CliError("--watch and --json don't go together.");
  const cfg = requireSelf();
  const list = machines(cfg, positionals);
  const tips = ui.dim('Control: claude-wingman cancel|pause|resume <id>   Activity: claude-wingman logs <id> [--follow]');
  // This machine's services: checked once (on Windows and WSL it means a PowerShell call), not on every refresh.
  const svc = list.some((m) => m.self) ? serviceStatus() : null;
  for (;;) {
    const snaps = await Promise.all(list.map(snapshot));
    if (opts.json) {
      console.log(JSON.stringify({ machines: snaps, notes: statusNotes(snaps, svc) }, null, 2));
      return snaps.every((s) => s.reachable) ? 0 : 1;
    }
    const lines = renderStatus(snaps, { all: opts.all, width: process.stdout.columns || 100, notes: statusNotes(snaps, svc) });
    if (!opts.watch) {
      console.log([...lines, tips].join('\n'));
      return snaps.every((s) => s.reachable) ? 0 : 1;
    }
    const stamp = ui.dim(`Updated ${new Date().toLocaleTimeString()}; refreshing every 5s. Ctrl+C to stop.`);
    // Redraw in place on a terminal; elsewhere, just print each update.
    process.stdout.write(`${process.stdout.isTTY ? '\x1b[2J\x1b[H' : '\n'}${[...lines, tips, stamp].join('\n')}\n`);
    await sleep(5000);
  }
}

/** Find the agent or remote command whose id starts with `ref`, on any machine (or only on `on`). */
async function locate(cfg, ref, on) {
  if (!ref) throw new CliError('Which one? Give an id from: claude-wingman status');
  if (!/^[0-9a-f-]{4,36}$/i.test(ref)) throw new CliError(`"${ref}" isn't an id. Ids are shown by: claude-wingman status`);
  const list = machines(cfg, on ? [on] : []);
  const snaps = await Promise.all(list.map(snapshot));
  const want = ref.toLowerCase();
  const hits = [];
  snaps.forEach((snap, i) => {
    for (const a of snap.agents ?? []) if (a.id.startsWith(want)) hits.push({ kind: 'agent', item: a, m: list[i] });
    for (const c of snap.commands ?? []) if (c.id.startsWith(want)) hits.push({ kind: 'command', item: c, m: list[i] });
  });
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new CliError(`"${ref}" matches ${hits.map((h) => `${h.item.shortId} on ${h.m.name}`).join(' and ')}. Give more of the id.`);
  const down = snaps.filter((s) => !s.reachable).map((s) => s.machine);
  throw new CliError(`Nothing with id ${ref} on ${list.map((m) => m.name).join(', ')}.`, {
    hint: down.length ? `Couldn't check ${down.join(', ')}: unreachable.` : 'See the ids with: claude-wingman status',
  });
}

function setState(conn, id, value) {
  const res = paseo(['agent', 'update', id, '--label', `${STATE_LABEL}=${value}`], { ...conn, timeoutMs: 30_000 });
  if (res.code !== 0) throw new CliError(`Couldn't record the agent's state: ${errorText(res)}`);
}

function interrupt(conn, id) {
  const res = paseo(['stop', id], { ...conn, timeoutMs: 60_000 });
  if (res.code !== 0) throw new CliError(`Couldn't stop the agent: ${errorText(res)}`);
}

const describe = (hit) => `${hit.item.shortId} on ${hit.m.name}${hit.item.title ? ` (${fit(hit.item.title, 60)})` : ''}`;

/** claude-wingman cancel <id> [--on <machine>]: stop an agent for good, or kill a remote command. */
export async function cancel(argv) {
  const { opts, positionals } = parseArgs(argv, { on: 'string' });
  const hit = await locate(requireSelf(), positionals[0], opts.on);
  const { conn } = hit.m;
  if (hit.kind === 'command') {
    // On Windows, closing the terminal alone could let the rest of a command chain run (see stopWindowsCommand).
    const nonce = /^wingman-([0-9a-f]+)/.exec(hit.item.name ?? '')?.[1];
    if (hit.m.peer.os === 'win32' && nonce) await stopWindowsCommand(hit.m, nonce);
    const res = paseo(['terminal', 'kill', hit.item.id], { ...conn, timeoutMs: 30_000 });
    // Already gone (it ended, or whoever started it closed it): stopped all the same.
    if (res.code !== 0 && !/no terminal found/i.test(errorText(res))) throw new CliError(`Couldn't stop the remote command: ${errorText(res)}`);
    ui.ok(`Cancelled the remote command ${describe(hit)}`);
    return 0;
  }
  if (!ACTIVE.has(hit.item.state) && hit.item.state !== 'paused') {
    ui.info(`Agent ${describe(hit)} isn't running (${hit.item.state}); nothing to cancel.`);
    return 0;
  }
  interrupt(conn, hit.item.id);
  setState(conn, hit.item.id, 'cancelled');
  ui.ok(`Cancelled agent ${describe(hit)}`);
  ui.hint(`Its conversation is kept; to carry on anyway: claude-wingman resume ${hit.item.shortId}`);
  return 0;
}

/** claude-wingman pause <id> [--on <machine>]: interrupt an agent, keeping its conversation so it can resume. */
export async function pause(argv) {
  const { opts, positionals } = parseArgs(argv, { on: 'string' });
  const hit = await locate(requireSelf(), positionals[0], opts.on);
  if (hit.kind === 'command') throw new CliError("A remote command can't be paused, only cancelled.", { hint: `claude-wingman cancel ${hit.item.shortId}` });
  if (!ACTIVE.has(hit.item.state)) throw new CliError(`Agent ${describe(hit)} isn't running (${hit.item.state}).`);
  interrupt(hit.m.conn, hit.item.id);
  setState(hit.m.conn, hit.item.id, 'paused');
  ui.ok(`Paused agent ${describe(hit)}`);
  ui.hint(`Whatever it was running was stopped. Resume with: claude-wingman resume ${hit.item.shortId}`);
  return 0;
}

/** claude-wingman resume <id> ["<message>"] [--on <machine>]: let a paused (or finished) agent carry on. */
export async function resume(argv) {
  const { opts, positionals } = parseArgs(argv, { on: 'string' });
  const [ref, ...words] = positionals;
  const hit = await locate(requireSelf(), ref, opts.on);
  if (hit.kind === 'command') throw new CliError("A remote command can't be resumed; run it again.");
  if (ACTIVE.has(hit.item.state)) throw new CliError(`Agent ${describe(hit)} is already ${hit.item.state}.`);
  const message = words.join(' ').trim() || RESUME_MESSAGE;
  setState(hit.m.conn, hit.item.id, '');
  const res = paseo(['send', '--no-wait', hit.item.id, message], { ...hit.m.conn, timeoutMs: 60_000 });
  if (res.code !== 0) {
    if (hit.item.state === 'paused') setState(hit.m.conn, hit.item.id, 'paused');
    throw new CliError(`Couldn't resume the agent: ${errorText(res)}`);
  }
  ui.ok(`Resumed agent ${describe(hit)}`);
  ui.hint(`Follow it: claude-wingman logs ${hit.item.shortId} --follow   Its latest message: claude-wingman logs ${hit.item.shortId} --tail 1`);
  return 0;
}

/** claude-wingman logs <id> [--follow] [--tail <n>] [--on <machine>]: an agent's activity, wherever it runs. */
export async function logs(argv) {
  const follow = argv.includes('-f');
  const { opts, positionals } = parseArgs(argv.filter((a) => a !== '-f'), { follow: 'boolean', tail: 'string', on: 'string' });
  const hit = await locate(requireSelf(), positionals[0], opts.on);
  if (hit.kind === 'command') throw new CliError('Remote commands have no log; their output is shown where they were started.');
  const args = ['logs', hit.item.id];
  if (follow || opts.follow) args.push('--follow');
  if (opts.tail) args.push('--tail', opts.tail);
  ui.info(`Agent ${describe(hit)}, ${hit.item.state}`);
  return paseoInteractive(args, hit.m.conn);
}
