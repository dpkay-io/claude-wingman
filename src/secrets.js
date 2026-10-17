// Password storage, per OS:
//   macOS:   the login Keychain (service "claude-wingman")
//   Windows: DPAPI-encrypted files (decryptable only by this Windows user) under ~/.claude-wingman/secrets
//   Linux:   files readable only by this user (mode 600, folder 700) under ~/.claude-wingman/secrets,
//            like ~/.ssh keys. A desktop keyring isn't used: it is often absent or locked on servers and WSL.
// Keys: "self" (this machine's daemon password) and "peer:<name>" (a peer's daemon password).
import fs from 'node:fs';
import path from 'node:path';
import { configDir } from './config.js';
import { CliError, IS_LINUX, IS_MAC, IS_WINDOWS, run, runPowerShell } from './util.js';

const SERVICE = 'claude-wingman';
// Passwords we generate are alphanumeric; this also keeps `security -i` command lines unambiguous.
const SAFE = /^[A-Za-z0-9._~-]{4,128}$/;

const secretsDir = () => path.join(configDir(), 'secrets');
const secretFile = (key) => path.join(secretsDir(), `${key.replace(/[^a-z0-9-]/g, '_')}${IS_WINDOWS ? '.dpapi' : '.secret'}`);

/** Where secrets are kept, for messages. */
export const secretStoreName = () => (IS_MAC ? 'Keychain' : IS_WINDOWS ? 'DPAPI' : 'private file');

export function setSecret(key, value) {
  if (!SAFE.test(value)) throw new CliError('Password contains unsupported characters (allowed: A-Z a-z 0-9 . _ ~ -).');
  if (IS_MAC) {
    // `security -i` reads the command from stdin, so the password never appears in the process list.
    // It exits 0 even when the command fails, so success is checked by reading the value back.
    const res = run('/usr/bin/security', ['-i'], { input: `add-generic-password -U -s ${SERVICE} -a ${key} -w ${value}\n` });
    if (getSecret(key) !== value) throw new CliError(`Keychain write failed: ${res.stderr || res.stdout || 'value not stored'}`);
    return;
  }
  if (IS_WINDOWS) {
    const res = runPowerShell(
      '(ConvertTo-SecureString -String $env:CP_SECRET -AsPlainText -Force) | ConvertFrom-SecureString',
      { env: { CP_SECRET: value } },
    );
    if (res.code !== 0 || !res.stdout) throw new CliError(`DPAPI encryption failed: ${res.stderr}`);
    fs.mkdirSync(secretsDir(), { recursive: true });
    fs.writeFileSync(secretFile(key), res.stdout + '\n');
    if (getSecret(key) !== value) throw new CliError('DPAPI round-trip check failed; secret not stored correctly.');
    return;
  }
  if (IS_LINUX) {
    fs.mkdirSync(secretsDir(), { recursive: true, mode: 0o700 });
    fs.chmodSync(secretsDir(), 0o700);
    // Write to a private temp file and rename, so the secret is never briefly readable by others.
    const tmp = `${secretFile(key)}.tmp`;
    fs.writeFileSync(tmp, value + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, secretFile(key));
    if (getSecret(key) !== value) throw new CliError('Secret file round-trip check failed; secret not stored correctly.');
    return;
  }
  throw new CliError(`Secret storage isn't supported on ${process.platform}.`);
}

export function getSecret(key) {
  if (IS_MAC) {
    const res = run('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-a', key, '-w']);
    return res.code === 0 ? res.stdout : null;
  }
  if (IS_WINDOWS) {
    if (!fs.existsSync(secretFile(key))) return null;
    const res = runPowerShell(
      '$s = Get-Content -LiteralPath $env:CP_FILE | ConvertTo-SecureString; ' +
        '$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); ' +
        'try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }',
      { env: { CP_FILE: secretFile(key) } },
    );
    if (res.code !== 0) throw new CliError(`DPAPI decryption failed for "${key}": ${res.stderr}`);
    return res.stdout;
  }
  if (IS_LINUX) {
    try {
      return fs.readFileSync(secretFile(key), 'utf8').trim();
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw new CliError(`Can't read the secret "${key}": ${err.message}`);
    }
  }
  return null;
}

export function deleteSecret(key) {
  if (IS_MAC) run('/usr/bin/security', ['delete-generic-password', '-s', SERVICE, '-a', key]);
  else fs.rmSync(secretFile(key), { force: true });
}
