// Release checks, run by CI on every push to main and before publishing:  node tools/check-release.js
//   - package.json has what a public npm package needs;
//   - the published package is exactly the CLI (bin, src, README, LICENSE, package.json);
//   - no file in the repository holds credentials or personal details (tokens, keys, private addresses,
//     real e-mail addresses, home folders, Tailscale addresses).
// Also refuse words you don't want published (your name, hostnames):  CHECK_RELEASE_DENY="word,other" node tools/...
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const fail = (msg) => problems.push(msg);
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });

// ---- package.json -------------------------------------------------------------------------------
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const expect = {
  name: 'claude-wingman',
  author: 'dpkay <hello@dpkay.com>',
  license: 'MIT',
  'repository.url': 'git+https://github.com/dpkay-io/claude-wingman.git',
  homepage: 'https://github.com/dpkay-io/claude-wingman#readme',
  'bugs.url': 'https://github.com/dpkay-io/claude-wingman/issues',
  'bin.claude-wingman': 'bin/claude-wingman.js',
};
for (const [key, want] of Object.entries(expect)) {
  const got = key.split('.').reduce((o, k) => o?.[k], pkg);
  if (got !== want) fail(`package.json ${key} is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
}
if (pkg.private) fail('package.json has "private": true (npm would refuse to publish)');
if (!/^\d+\.\d+\.\d+$/.test(pkg.version ?? '')) fail(`package.json version ${pkg.version} isn't a plain x.y.z release`);
if (!pkg.engines?.node) fail('package.json has no engines.node');
if (!fs.existsSync(path.join(ROOT, 'LICENSE'))) fail('LICENSE is missing');

// ---- what npm would publish -----------------------------------------------------------------------
const packJson = JSON.parse(execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'],
  { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' }));
const packed = Array.isArray(packJson) ? packJson[0] : Object.values(packJson)[0]; // npm 12: keyed by package name
const published = packed.files.map((f) => f.path.replace(/\\/g, '/'));
const allowed = (f) => /^(bin\/claude-wingman\.js|src\/.+\.js|README\.md|LICENSE|package\.json)$/.test(f);
for (const f of published) if (!allowed(f)) fail(`npm would publish ${f}, which isn't part of the CLI`);
for (const f of ['bin/claude-wingman.js', 'src/cli.js', 'README.md', 'LICENSE', 'package.json']) {
  if (!published.includes(f)) fail(`npm would not publish ${f}`);
}

// ---- credentials and personal details in any file of the repository ------------------------------
const files = [...new Set([...git('ls-files').split('\n'), ...git('ls-files', '--others', '--exclude-standard').split('\n')])]
  .filter((f) => f && fs.existsSync(path.join(ROOT, f)) && !/\.(png|jpe?g|gif|ico)$/i.test(f));
const ALLOWED_EMAILS = new Set(['hello@dpkay.com', 'noreply@anthropic.com']);
const EXAMPLE_DOMAIN = /@(example\.(com|org|net|invalid)|[\w-]+\.(invalid|test|example))$/i;
// Placeholder users in examples and tests (a real one, like your own, is reported).
const PLACEHOLDER_USERS = new Set(['you', 'user', 'me', 'name', 'runner', 'username', 'x', 'd', 'u', 'john', '<you>', '<user>']);
// Fixture addresses in tests: LAN addresses that must be refused, and the edges of Tailscale's range.
const FIXTURE_ADDRESSES = new Set(['10.0.0.1', '192.168.0.1', '192.168.0.5', '192.168.1.5', '100.127.255.255', '100.63.255.255']);
const rules = [
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['a GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ['an npm token', /\bnpm_[A-Za-z0-9]{30,}/],
  ['an Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['an AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['a Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['a private network address', /\b(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/],
];
const deny = (process.env.CHECK_RELEASE_DENY ?? '').split(',').map((w) => w.trim()).filter(Boolean);
for (const file of files) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  if (file === 'package-lock.json') continue; // registry URLs and integrity hashes only (checked by npm)
  text.split('\n').forEach((line, i) => {
    const at = `${file}:${i + 1}`;
    for (const [what, re] of rules) {
      const m = re.exec(line);
      if (m && !FIXTURE_ADDRESSES.has(m[0])) fail(`${at} looks like it contains ${what} (${m[0].slice(0, 12)}...)`);
    }
    for (const m of line.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g)) {
      if (!ALLOWED_EMAILS.has(m[0].toLowerCase()) && !EXAMPLE_DOMAIN.test(m[0])) fail(`${at} has the e-mail address ${m[0]}`);
    }
    // Tailscale's 100.64.0.0/10. Tests and docs use 100.64.0.x and 100.100.100.100 (Tailscale's own resolver) only.
    for (const m of line.matchAll(/\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.(\d{1,3})\.(\d{1,3})\b/g)) {
      if (!(m[1] === '64' && m[2] === '0') && m[0] !== '100.100.100.100' && !FIXTURE_ADDRESSES.has(m[0])) fail(`${at} has the Tailscale address ${m[0]}`);
    }
    for (const m of line.matchAll(/(?:\/Users\/|\/home\/|[A-Z]:\\{1,2}Users\\{1,2})(<[A-Za-z]+>|[A-Za-z0-9._-]+)/g)) {
      if (!PLACEHOLDER_USERS.has(m[1].toLowerCase())) fail(`${at} names the home folder of "${m[1]}" (${m[0]})`);
    }
    for (const word of deny) if (line.toLowerCase().includes(word.toLowerCase())) fail(`${at} contains "${word}"`);
  });
}

if (problems.length) {
  console.error(`Release check failed (${problems.length}):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`Release check passed: ${published.length} published files, ${files.length} files scanned.`);
