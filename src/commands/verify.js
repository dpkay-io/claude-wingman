// claude-wingman verify | doctor
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from '../args.js';
import { loadConfig, requireSelf } from '../config.js';
import { finalReport, startAgent, waitAgent } from '../dispatch.js';
import { PASEO_INSTALL, PASEO_VERSION, errorText, paseo, paseoEntry, paseoVersion, passwordMatchesDaemon, readDaemonConfig } from '../paseo.js';
import { getSecret } from '../secrets.js';
import { serviceStatus } from '../service.js';
import { skillsDir, SKILL_MARKER } from '../skill.js';
import { status as tailscaleStatus, tailscaleBin } from '../tailscale.js';
import { IS_LINUX, IS_MAC, IS_WINDOWS, SUPPORTED_OSES, isWindowsToolOnWsl, nodeIsSupported, run, ui, which } from '../util.js';
import { canConnect } from './manage.js';
import { peerConnection } from './dispatch.js';
import { quoteArg, remoteExec } from '../remote.js';

function checker() {
  const results = { pass: 0, fail: 0 };
  const check = (ok, label, hint) => {
    if (ok) {
      results.pass++;
      ui.ok(label);
    } else {
      results.fail++;
      ui.fail(label);
      if (hint) ui.hint(hint);
    }
    return ok;
  };
  return { check, results };
}

/** Connect to our own daemon the way a remote client would: no local credential file. */
function probeAuth(host, password) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-wingman-probe-'));
  try {
    const res = paseo(['ls', '--json'], { host, password, isolatedHome: home, timeoutMs: 30_000 });
    return { ok: res.code === 0, text: `${res.stderr}\n${res.stdout}` };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function verifyPeer(name, cfg, check, roundTrip) {
  const { peer, conn } = peerConnection(cfg, name);
  if (!check(await canConnect(peer.host, peer.port), `Reachable at ${conn.host}`, 'Is it awake and on Tailscale?')) return;
  const ls = paseo(['ls', '--json'], { ...conn, timeoutMs: 30_000 });
  check(ls.code === 0, 'Password accepted', `${errorText(ls)}  (re-pair: claude-wingman pair ${peer.machine})`);
  const skillFile = path.join(skillsDir(), name, 'SKILL.md');
  check(fs.existsSync(skillFile) && fs.readFileSync(skillFile, 'utf8').includes(SKILL_MARKER), `Skill installed (${skillFile})`, 'Run: claude-wingman skill');
  if (!roundTrip || ls.code !== 0) return;
  const id = startAgent(conn, {
    cwd: peer.home,
    title: `${cfg.self.name}: claude-wingman verify`,
    prompt: 'Connectivity check from claude-wingman verify. Do not run any tools. Reply with exactly: CLAUDE_WINGMAN_OK',
  });
  const st = waitAgent(conn, id, 180);
  const report = st === 'idle' ? finalReport(conn, id) : '';
  check(/CLAUDE_WINGMAN_OK/.test(report), `Round trip: an agent ran on ${name} and replied`, `status ${st}; see: claude-wingman ${name} logs ${id}`);
  paseo(['archive', id], { ...conn, timeoutMs: 30_000 });
}

export async function verify(argv) {
  const { opts } = parseArgs(argv, { 'round-trip': 'boolean' });
  const cfg = requireSelf();
  const { check, results } = checker();
  const s = cfg.self;
  const host = `${s.host}:${s.port}`;

  ui.step(`This machine (${s.name})`);
  let ts;
  try {
    ts = tailscaleStatus();
  } catch (err) {
    check(false, `Tailscale connected: ${err.message}`);
  }
  if (ts) check(ts.self.ip === s.host, `Tailscale IP is still ${s.host}`, `It is now ${ts.self.ip}; run: claude-wingman setup`);
  const daemon = readDaemonConfig()?.daemon ?? {};
  check(daemon.listen === host, `Daemon configured to listen on ${host} only`, 'Run: claude-wingman setup');
  check(daemon.relay?.enabled === false, 'Paseo relay disabled', 'Run: claude-wingman setup');
  check(passwordMatchesDaemon(getSecret('self')), 'Stored password matches the daemon', 'Run: claude-wingman setup');
  check(await canConnect(s.host, s.port), `Daemon accepting connections on ${host}`, 'Run: claude-wingman restart');
  check(!(await canConnect('127.0.0.1', s.port, 1500)), `Not exposed on localhost:${s.port}`);
  const noPw = probeAuth(host, undefined);
  check(!noPw.ok && /password required/i.test(noPw.text), 'Refuses a client with no password');
  const wrongPw = probeAuth(host, 'definitely-not-the-password');
  check(!wrongPw.ok && /incorrect password/i.test(wrongPw.text), 'Refuses a wrong password');
  check(probeAuth(host, getSecret('self')).ok, 'Accepts the right password');
  const svc = serviceStatus();
  check(svc.autostart, 'Daemon starts automatically', 'Run: claude-wingman setup');
  if (svc.wsl) check(svc.wsl.running, `WSL kept running, and started with Windows: ${svc.wsl.detail}`, 'Run: claude-wingman setup');
  if (svc.awake === null) ui.warn(`Keep-awake: ${svc.awakeDetail}`);
  else check(svc.awake, `Kept awake (${svc.awakeDetail})`, 'Run: claude-wingman setup');
  // macOS privacy protection keeps processes under launchd out of ~/Documents, ~/Desktop and ~/Downloads, so a
  // repos folder there is invisible to dispatched agents. Ask the daemon itself, through one of its terminals.
  if (IS_MAC && (await canConnect(s.host, s.port))) {
    try {
      const res = await remoteExec({ peer: { ...s, machine: 'this machine' }, conn: { host, password: getSecret('self') } },
        `ls ${quoteArg(s.reposRoot, 'darwin')} >/dev/null`, { timeoutSeconds: 60, label: 'verify: repos folder check' });
      check(res.ok, `Dispatched agents can read ${s.reposRoot}`,
        'macOS keeps background processes out of ~/Documents, ~/Desktop and ~/Downloads. Keep repos elsewhere (e.g. ~/src), or give node Full Disk Access in System Settings > Privacy & Security.');
    } catch (err) {
      check(false, `Dispatched agents can read ${s.reposRoot}`, err.message);
    }
  }
  // The service runs the node binary that ran setup; an nvm/Homebrew upgrade can remove it.
  if (s.node) check(fs.existsSync(s.node), `Daemon's Node.js still installed (${s.node})`, 'Node was upgraded or removed; run: claude-wingman setup');
  const paseoHere = paseoVersion();
  if (paseoHere && paseoHere !== PASEO_VERSION) ui.warn(`Paseo ${paseoHere}; claude-wingman is tested with ${PASEO_VERSION}. To switch: ${PASEO_INSTALL}, then: claude-wingman restart`);

  for (const name of Object.keys(cfg.peers)) {
    const peer = cfg.peers[name];
    ui.step(`Peer ${name} (${peer.machine})`);
    try {
      await verifyPeer(name, cfg, check, opts['round-trip']);
    } catch (err) {
      check(false, `Checking ${name} failed: ${err.message}`, err.hint);
    }
  }

  console.log(`\n${results.fail ? ui.bold(`${results.fail} check(s) failed`) : ui.bold('All checks passed')}, ${results.pass} passed.`);
  return results.fail ? 1 : 0;
}

export function doctor() {
  const { check, results } = checker();
  ui.step('Prerequisites');
  check(SUPPORTED_OSES.includes(process.platform), `Supported OS (${process.platform})`, 'claude-wingman supports macOS, Windows and Linux.');
  check(nodeIsSupported(), `Node.js ${process.version}`, 'Install Node.js 20.11 or newer.');
  check(Boolean(which('git')), 'git on PATH', IS_MAC ? 'Install: xcode-select --install' : IS_WINDOWS ? 'Install: winget install --id Git.Git -e' : 'Install git with your package manager (e.g. sudo apt install git)');
  const claude = which('claude');
  check(Boolean(claude), 'Claude Code on PATH', 'Install and sign in: https://code.claude.com/docs/en/setup');
  for (const tool of ['claude', 'npm']) {
    if (isWindowsToolOnWsl(which(tool))) check(false, `${tool} is the Linux one (found the Windows ${which(tool)})`, tool === 'npm' ? 'Install Node.js inside WSL, e.g. with nvm' : 'Install Claude Code inside WSL');
  }
  if (claude) ui.hint(run(claude, ['--version']).stdout);
  const tsBin = tailscaleBin({ required: false });
  check(Boolean(tsBin), 'Tailscale installed', IS_WINDOWS ? 'Install: winget install --id Tailscale.Tailscale -e'
    : IS_LINUX ? 'Install: curl -fsSL https://tailscale.com/install.sh | sh' : 'Install the standalone .pkg from https://tailscale.com/download');
  if (tsBin) {
    try {
      const ts = tailscaleStatus();
      check(true, `Tailscale connected (${ts.self.name}, ${ts.self.ip})`);
    } catch (err) {
      check(false, `Tailscale connected`, err.message);
    }
  }
  check(Boolean(paseoEntry()), 'Paseo installed', 'claude-wingman setup installs it');
  const paseoAt = paseoVersion();
  if (paseoAt && paseoAt !== PASEO_VERSION) ui.warn(`Paseo ${paseoAt}; claude-wingman is tested with ${PASEO_VERSION}. To switch: ${PASEO_INSTALL}`);
  const cfg = loadConfig();
  check(Boolean(cfg.self), cfg.self ? `Set up as "${cfg.self.name}"` : 'Set up', 'Run: claude-wingman setup');
  console.log(`\n${results.fail ? `${results.fail} item(s) need attention` : 'Ready'}.`);
  return results.fail ? 1 : 0;
}
