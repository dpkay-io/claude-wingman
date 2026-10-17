// Tailscale: find the CLI, read status, resolve machines, and move files with Taildrop.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliError, IS_LINUX, IS_MAC, IS_WINDOWS, run, runPowerShell, which } from './util.js';

const CANDIDATES = IS_MAC
  ? ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale']
  : IS_WINDOWS
    ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe')]
    : ['/usr/bin/tailscale', '/usr/local/bin/tailscale'];

export function tailscaleBin({ required = true } = {}) {
  const found = CANDIDATES.find((p) => fs.existsSync(p)) ?? which('tailscale');
  if (!found && required) {
    throw new CliError('Tailscale is not installed.', {
      hint: IS_WINDOWS
        ? 'Install it: winget install --id Tailscale.Tailscale -e   (then sign in with the same account on every machine)'
        : IS_LINUX
          ? 'Install it: curl -fsSL https://tailscale.com/install.sh | sh   then: sudo tailscale up && sudo tailscale set --operator=$USER'
          : 'Install it from https://tailscale.com/download (on macOS, the standalone .pkg), then sign in.',
    });
  }
  return found;
}

/** Short machine name from a MagicDNS name: "msi.tail1234.ts.net." -> "msi". */
const shortName = (dnsName) => (dnsName || '').split('.')[0].toLowerCase();

const toMachine = (node) => ({
  name: shortName(node.DNSName) || node.HostName,
  displayName: node.HostName,
  ip: (node.TailscaleIPs || []).find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip)),
  os: node.OS,
  online: node.Online !== false,
  userId: node.UserID,
  // Shared into this tailnet from someone else's: never a pairing candidate.
  shared: Boolean(node.ShareeNode),
});

// On Linux, tailscaled runs as root; Taildrop needs this user to be its "operator".
const operatorHint = () => (IS_LINUX ? { hint: 'Allow Taildrop for your user once: sudo tailscale set --operator=$USER' } : {});
const permissionDenied = (text) => /access denied|permission denied|operator|must be root|requires root/i.test(text);

export function status() {
  const res = run(tailscaleBin(), ['status', '--json']);
  if (res.code !== 0) throw new CliError(`tailscale status failed: ${res.stderr || res.stdout}`);
  const data = JSON.parse(res.stdout);
  if (data.BackendState !== 'Running') {
    throw new CliError(`Tailscale is not connected (state: ${data.BackendState}).`, { hint: 'Open Tailscale and sign in, or run: tailscale up' });
  }
  return { self: toMachine(data.Self), peers: Object.values(data.Peer || {}).map(toMachine) };
}

/** Find a tailnet machine by short name, display name or IPv4 address. */
export function resolveMachine(query) {
  const { peers } = status();
  const q = String(query).toLowerCase();
  const match = peers.find((m) => m.ip === query || m.name === q || m.displayName.toLowerCase() === q);
  if (!match) {
    throw new CliError(`No machine "${query}" on your tailnet.`, {
      hint: `Machines: ${peers.map((m) => `${m.name} (${m.ip}${m.online ? '' : ', offline'})`).join(', ') || 'none'}`,
    });
  }
  return match;
}

/** CGNAT range 100.64.0.0/10, which Tailscale assigns from. */
export const isTailscaleIp = (ip) => {
  const m = /^100\.(\d+)\.(\d+)\.(\d+)$/.exec(ip ?? '');
  return Boolean(m) && Number(m[1]) >= 64 && Number(m[1]) <= 127 && [m[2], m[3]].every((n) => Number(n) <= 255);
};

export function sendFile(file, machineName) {
  const res = run(tailscaleBin(), ['file', 'cp', file, `${machineName}:`], { timeoutMs: 120_000 });
  if (res.code !== 0) {
    const text = res.stderr || res.stdout;
    throw new CliError(`Taildrop send to ${machineName} failed: ${text}`, permissionDenied(text) ? operatorHint() : {});
  }
}

let downloadsDir;
/** The user's Downloads folder. On Windows it can be redirected (e.g. to OneDrive), so ask the shell. */
function downloads() {
  if (downloadsDir) return downloadsDir;
  downloadsDir = path.join(os.homedir(), 'Downloads');
  if (IS_WINDOWS) {
    const res = runPowerShell("(New-Object -ComObject Shell.Application).NameSpace('shell:Downloads').Self.Path");
    if (res.code === 0 && res.stdout && fs.existsSync(res.stdout)) downloadsDir = res.stdout;
  }
  return downloadsDir;
}

/**
 * Move received Taildrop files into `dir` (non-blocking) and return candidate paths.
 * The macOS and Windows Tailscale apps save received files straight to Downloads, so that is searched too.
 * On Linux they wait in tailscaled's inbox until `tailscale file get` moves them.
 */
export function receiveFiles(dir, prefix) {
  fs.mkdirSync(dir, { recursive: true });
  const res = run(tailscaleBin(), ['file', 'get', '--conflict=overwrite', dir], { timeoutMs: 30_000 });
  if (res.code !== 0 && permissionDenied(res.stderr || res.stdout)) {
    throw new CliError(`Can't receive Taildrop files: ${res.stderr || res.stdout}`, operatorHint());
  }
  const dirs = [dir, downloads()];
  return dirs.flatMap((d) => {
    try {
      return fs.readdirSync(d).filter((f) => f.startsWith(prefix) && f.endsWith('.json')).map((f) => path.join(d, f));
    } catch {
      return [];
    }
  });
}
