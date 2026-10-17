// The credential bundle two machines exchange (over Taildrop) when pairing.
// It holds everything a peer needs to reach this machine's daemon and to write a skill for it.
import { CliError, SUPPORTED_OSES } from './util.js';
import { validateName } from './config.js';
import { isTailscaleIp } from './tailscale.js';

export const BUNDLE_KIND = 'claude-wingman-credentials';
export const BUNDLE_PREFIX = 'claude-wingman-';
export const bundleFileName = (name) => `${BUNDLE_PREFIX}${name}.json`;

const OSES = new Set(SUPPORTED_OSES);

export function makeBundle({ name, host, port, password, os, home, reposRoot, machine, version }) {
  return { kind: BUNDLE_KIND, v: 1, name, host, port, password, os, home, reposRoot, machine, version, createdAt: new Date().toISOString() };
}

/** Parse and validate a bundle; throws CliError describing the first problem. */
export function parseBundle(text) {
  let b;
  try {
    b = JSON.parse(text);
  } catch {
    throw new CliError('Credential file is not valid JSON.');
  }
  const bad = (what) => {
    throw new CliError(`Credential file has an invalid ${what}.`);
  };
  if (b?.kind !== BUNDLE_KIND || b.v !== 1) bad('format (not a claude-wingman v1 bundle)');
  validateName(b.name, 'peer name');
  if (!isTailscaleIp(b.host)) bad('host (expected a Tailscale 100.x address)');
  if (!Number.isInteger(b.port) || b.port < 1 || b.port > 65535) bad('port');
  if (typeof b.password !== 'string' || !/^[A-Za-z0-9._~-]{4,128}$/.test(b.password)) bad('password');
  if (!OSES.has(b.os)) bad('os');
  // These values end up in the generated skill, which Claude reads as instructions: allow plain machine
  // names and absolute paths only (no quotes, backticks, angle brackets, newlines or control characters).
  if (typeof b.machine !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(b.machine)) bad('machine');
  for (const key of ['home', 'reposRoot']) {
    const v = b[key];
    const absolute = b.os === 'win32' ? /^[A-Za-z]:\\/.test(v ?? '') : String(v ?? '').startsWith('/');
    if (typeof v !== 'string' || !absolute || !/^[^\x00-\x1f\x7f"`<>|*?]{2,200}$/.test(v) || v.trim() !== v) bad(key);
  }
  // The sender's claude-wingman version (absent from older versions' bundles), shown by status.
  if (b.version !== undefined && (typeof b.version !== 'string' || !/^\d{1,4}\.\d{1,4}\.\d{1,6}(-[0-9A-Za-z.]{1,32})?$/.test(b.version))) bad('version');
  const created = Date.parse(b.createdAt);
  if (!Number.isFinite(created) || created > Date.now() + 5 * 60_000) bad('createdAt (missing or in the future)');
  return b;
}
