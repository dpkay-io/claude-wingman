// Handing credentials (pairing bundles) to other machines:
//   - over Taildrop, for the first pairing, which a person runs in a terminal (sendBundle);
//   - from a single-use URL on this machine's Tailscale address, fetched by a machine this one already
//     controls through a remote terminal (serveOnce + fetchBundle). Taildrop can't be used there: on macOS,
//     processes under the daemon may not read ~/Downloads, where Taildrop saves files.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { bundleFileName, makeBundle, parseBundle } from './bundle.js';
import { getSecret } from './secrets.js';
import { isTailscaleIp, sendFile } from './tailscale.js';
import { CliError, VERSION } from './util.js';

/** This machine's bundle, or (with `peerName`) a paired machine's, rebuilt from what this machine knows about it. */
export function bundleFor(cfg, peerName) {
  if (!peerName) {
    const password = getSecret('self');
    if (!password) throw new CliError('No daemon password stored for this machine.', { hint: 'Run: claude-wingman setup' });
    const { name, host, port, os: osName, home, reposRoot, machine } = cfg.self;
    return makeBundle({ name, host, port, password, os: osName, home, reposRoot, machine, version: VERSION });
  }
  const p = cfg.peers[peerName];
  const password = getSecret(`peer:${peerName}`);
  if (!p || !password) throw new CliError(`No stored credentials for ${peerName}.`);
  return makeBundle({ name: p.remoteName ?? peerName, host: p.host, port: p.port, password, os: p.os, home: p.home, reposRoot: p.reposRoot, machine: p.machine, version: p.version });
}

/** @param machine {{ name: string }} a Tailscale machine; selfIp: this machine's current Tailscale IP */
export function sendBundle(cfg, machine, selfIp) {
  const bundle = bundleFor(cfg);
  if (cfg.self.host !== selfIp) {
    throw new CliError(`This machine's Tailscale IP changed (${cfg.self.host} -> ${selfIp}) since setup.`, { hint: 'Run: claude-wingman setup' });
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-wingman-'));
  const file = path.join(dir, bundleFileName(bundle.name));
  try {
    fs.writeFileSync(file, JSON.stringify(bundle), { mode: 0o600 });
    sendFile(file, machine.name);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Serve `content` at an unguessable URL on this machine's Tailscale address while `fn(url)` runs.
 * With `once`, the URL stops working after the first download (for credentials).
 */
export async function serveOnce(host, fileName, content, fn, { once = true } = {}) {
  const token = crypto.randomBytes(16).toString('hex');
  const urlPath = `/${token}/${encodeURIComponent(fileName)}`;
  let served = false;
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== urlPath || (once && served)) {
      res.writeHead(404).end();
      return;
    }
    served = true;
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': content.length, 'Cache-Control': 'no-store' });
    res.end(content);
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, host, resolve));
  try {
    return await fn(`http://${host}:${server.address().port}${urlPath}`);
  } finally {
    server.close();
  }
}

/** Download and validate a bundle from a URL made by serveOnce on another of the user's machines. */
export async function fetchBundle(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new CliError(`Not a URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' || !isTailscaleIp(parsed.hostname)) throw new CliError('Credentials can only come from a Tailscale (100.x) address.');
  return new Promise((resolve, reject) => {
    const req = http.get(parsed, { timeout: 30_000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new CliError(`Fetching credentials failed (HTTP ${res.statusCode}); the link works once and only while the other machine waits.`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 64 * 1024) req.destroy(new CliError('Credential file too large.'));
      });
      res.on('end', () => {
        try {
          resolve(parseBundle(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('timeout', () => req.destroy(new CliError('Fetching credentials timed out.')));
    req.on('error', (err) => reject(err instanceof CliError ? err : new CliError(`Fetching credentials failed: ${err.message}`)));
  });
}
