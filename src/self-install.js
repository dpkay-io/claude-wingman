// `npx claude-wingman pair` should be the only command a new machine needs. npx runs the package from a
// temporary cache, but the generated skills call the `claude-wingman` command, so install it globally.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmRootGlobal } from './paseo.js';
import { CliError, IS_WINDOWS, run, ui } from './util.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = () => JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));

/** True for a path inside npm's npx cache (~/.npm/_npx/<hash>/...). */
export const isNpxPath = (p) => p.split(/[\\/]/).includes('_npx');

function installedVersion(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(npmRootGlobal(), name, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

// npm on Windows is a .cmd shim that needs a shell; quote the (path) arguments for it.
const npm = (args) => run('npm', IS_WINDOWS ? args.map((a) => `"${a}"`) : args, { shell: IS_WINDOWS, timeoutMs: 300_000 });

export function ensureInstalledGlobally() {
  if (!isNpxPath(PACKAGE_ROOT)) return;
  const { name, version } = pkg();
  if (installedVersion(name) === version) return;
  ui.info(`Installing the ${name} ${version} command globally (npm install -g) ...`);
  // Install this exact copy (from npm, GitHub or a tarball alike) by packing it first.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-wingman-pack-'));
  try {
    const pack = npm(['pack', PACKAGE_ROOT, '--pack-destination', dir]);
    const tarball = fs.readdirSync(dir).find((f) => f.endsWith('.tgz'));
    if (pack.code !== 0 || !tarball) throw new CliError(`Packing ${name} failed: ${pack.stderr || pack.stdout}`);
    const res = npm(['install', '-g', path.join(dir, tarball)]);
    if (res.code !== 0 || installedVersion(name) !== version) {
      throw new CliError(`Installing ${name} globally failed: ${(res.stderr || res.stdout).split('\n').slice(-3).join(' ')}`, {
        hint: `Install it yourself (npm install -g ${name}), then run: ${name} pair`,
      });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  ui.ok(`Installed the ${name} command`);
}
