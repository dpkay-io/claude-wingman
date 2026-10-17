// Run a command on a paired machine through its daemon: Paseo opens a terminal there (the user's shell on
// macOS/Linux, cmd.exe on Windows) over the same password-protected Tailscale connection. No Claude agent is
// involved, which is what makes remote maintenance (update, setup, pairing) possible from any machine.
import crypto from 'node:crypto';
import { errorText, paseo } from './paseo.js';
import { CliError, sleep } from './util.js';

/** Remote-command terminals are named "wingman-<nonce>: <label>", which is how `status` and `cancel` find them. */
export const TERMINAL_PREFIX = 'wingman-';

/** Quote one argument for the remote shell. cmd.exe can't safely quote everything, so some characters are refused. */
export function quoteArg(arg, osName) {
  const s = String(arg);
  if (osName === 'win32') {
    if (/["%^&|<>\r\n]/.test(s)) throw new CliError(`Can't pass ${JSON.stringify(s)} to a Windows machine: it contains " % ^ & | < > or a newline.`);
    return /[\s()]/.test(s) || s === '' ? `"${s}"` : s;
  }
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * cmd.exe: `cmd /d /s /c "<command>"`, written so the line it's typed in leaves the command alone. That line wraps the
 * command in parentheses and an output redirect, and parses it first: an unquoted ) would close the parentheses, and
 * rem or :: would comment out the rest of the line. So every & | < > ( ) ^ that this outer parse would see outside
 * quotes gets a caret, which it removes; /s then gives the child exactly the original text, parsed as if typed.
 */
export function cmdChild(command) {
  if (/[\r\n]/.test(command)) throw new CliError("A command for a Windows machine can't contain a line break.");
  if ((command.match(/"/g) ?? []).length % 2) throw new CliError(`Unbalanced quotes in ${JSON.stringify(command)}: a command for a Windows machine needs them in pairs.`);
  let quoted = true; // the opening " of /c "..." below
  let out = '';
  for (const ch of command) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && '&|<>()^'.includes(ch)) out += '^';
    out += ch;
  }
  return `cmd /d /s /c "${out}"`;
}

/**
 * The single line typed into the remote shell. It prints a begin marker, runs the command with its output going to a
 * temporary file, prints that file in base64, then an end marker with 0 (success) or 1. Base64 lines (64 characters)
 * fit the terminal's 80 columns, so the output comes back exactly as printed, never wrapped.
 *
 * macOS/Linux: the user's shell may be bash, zsh, fish, csh..., so what is typed is only
 * `echo <script in base64> | base64 --decode | sh`, which all of them understand; the script itself runs in sh, and
 * its trap removes the temporary file even when the terminal is killed (a timeout or `cancel`).
 * Windows (cmd.exe): the command runs in a child cmd (see cmdChild). The markers are typed with ^ so that cmd's
 * echo of the line differs from what it prints.
 * A killed cmd can't clean up, so each run first removes leftovers older than a day.
 */
/** The log each machine keeps of the remote commands it was sent: one line each, time and label (who and what). */
export const COMMAND_LOG = 'remote-commands.log';

export function remoteLine(command, osName, nonce, label = 'remote command') {
  const what = String(label).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300);
  if (osName === 'win32') {
    // cmd can't quote everything safely, so the logged copy has its special characters replaced (the command doesn't).
    const log = `>>"%USERPROFILE%\\.claude-wingman\\${COMMAND_LOG}" 2>NUL echo %DATE% %TIME% ${what.replace(/["%^&|<>()!]/g, '_')}`;
    const out = `"%TEMP%\\wingman-out-${nonce}.txt"`;
    const b64 = `"%TEMP%\\wingman-out-${nonce}.b64"`;
    const sweep = `forfiles /p "%TEMP%" /m wingman-out-* /d -1 /c "cmd /c del @path" >NUL 2>NUL`;
    // certutil refuses an empty file, hence the extra empty line (trimmed when parsing).
    const print = `(echo.)>>${out} & certutil -f -encode ${out} ${b64} >NUL 2>NUL & type ${b64} 2>NUL & del ${out} ${b64} 2>NUL`;
    return `${sweep} & ${log} & echo __WM_${nonce}_^BEGIN__ & ((${cmdChild(command)}) <NUL >${out} 2>&1 && (${print} & echo __WM_${nonce}_^END_0__) || (${print} & echo __WM_${nonce}_^END_1__))`;
  }
  const script = [
    `wm_out=$(mktemp "\${TMPDIR:-/tmp}/wingman-out-${nonce}.XXXXXX") || exit 1`,
    `trap 'rm -f "$wm_out"' EXIT`,
    `trap 'exit 129' HUP INT TERM`,
    // umask 077: the log may hold whatever was typed into `run`, so it's private even if its folder isn't.
    `(umask 077; mkdir -p "$HOME/.claude-wingman" && printf '%s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" ${quoteArg(what, 'linux')} >>"$HOME/.claude-wingman/${COMMAND_LOG}") 2>/dev/null`,
    `echo __WM_${nonce}_BEGIN__`,
    `{ ${command}`,
    `} </dev/null >"$wm_out" 2>&1 && wm_rc=0 || wm_rc=1`,
    // One 64-character line per row: GNU base64 wraps at 76, so join first, or fold would leave half-empty rows.
    `base64 <"$wm_out" | tr -d '\\n' | fold -w 64; echo`,
    `echo __WM_${nonce}_END_\${wm_rc}__`,
  ].join('\n');
  return `echo ${Buffer.from(`${script}\n`).toString('base64')} | base64 --decode | sh`;
}

const BASE64_LINE = /^[A-Za-z0-9+/]+=*$/;
const CERTUTIL_FRAME = /^-----(BEGIN|END) CERTIFICATE-----$/;

/** Find the result in captured terminal text: { done, ok, output }. */
export function parseCapture(text, nonce) {
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.trim());
  const begin = lines.findIndex((l) => l === `__WM_${nonce}_BEGIN__`);
  const endAt = lines.findIndex((l, i) => i > begin && /^__WM_[0-9a-f]+_END_[01]__$/.test(l) && l.includes(nonce));
  if (endAt === -1) return { done: false, ok: false, output: '' };
  let encoded;
  if (begin !== -1) encoded = lines.slice(begin + 1, endAt).filter((l) => BASE64_LINE.test(l));
  else {
    // A long output can push the begin marker out of the terminal's scrollback: keep the base64 lines that are left.
    let from = endAt;
    while (from > 0 && (BASE64_LINE.test(lines[from - 1]) || CERTUTIL_FRAME.test(lines[from - 1]))) from--;
    encoded = lines.slice(from, endAt).filter((l) => BASE64_LINE.test(l));
  }
  let output = Buffer.from(encoded.join(''), 'base64').toString('utf8').replace(/\r\n?/g, '\n');
  // When the start was cut off, the first line is only the end of one: leave it out.
  if (begin === -1) output = `(the start of the output didn't fit in the terminal's scrollback)\n${output.slice(output.indexOf('\n') + 1)}`;
  // Only the end: leading blank lines or indentation are part of what the command printed.
  output = output.trimEnd();
  return { done: true, ok: lines[endAt].endsWith('_END_0__'), output };
}

/**
 * Run `command` (already quoted for the remote shell) on a paired machine.
 * @param {{ name?: string, peer: object, conn: object }} target from peerConnection()
 * @param {object} options `label` names the terminal (shown by `status`; never put a secret in it); `cwd` is a folder there
 * @returns {Promise<{ ok: boolean, output: string }>}
 */
export async function remoteExec({ name, peer, conn }, command, { timeoutSeconds = 600, env = {}, label = 'remote command', cwd = peer.home } = {}) {
  const where = name ?? peer.machine;
  const nonce = crypto.randomBytes(6).toString('hex');
  const terminalName = `${TERMINAL_PREFIX}${nonce}: ${label}`.slice(0, 100);
  // A daemon that is restarting refuses connections for a few seconds: retry those for a while.
  const retryUntil = Date.now() + 45_000;
  let created;
  let id;
  for (;;) {
    created = paseo(['terminal', 'create', '--cwd', cwd, '--name', terminalName, '--json'], { ...conn, timeoutMs: 60_000 });
    try {
      id = JSON.parse(created.stdout).id;
    } catch {}
    if ((created.code === 0 && id) || Date.now() > retryUntil || !/ECONNREFUSED|unreachable|ECONNRESET|socket hang up/i.test(errorText(created))) break;
    await sleep(3000);
  }
  if (created.code !== 0 || !id) throw new CliError(`Can't open a terminal on ${where}: ${errorText(created)}`);
  let finished; // undefined: the command was never typed; false: it was, and hasn't finished
  try {
    // Non-interactive: a claude-wingman command there must never stop at a question.
    // ...and must know it runs under the daemon, so it defers any daemon restart (see insidePaseoAgent).
    // WINGMAN_RUN tags the command's process on Windows, so a timeout or cancel can stop all of it (stopWindowsCommand).
    const prefix = Object.entries({ CLAUDE_WINGMAN_NONINTERACTIVE: '1', CLAUDE_WINGMAN_REMOTE: '1', WINGMAN_RUN: nonce, ...env })
      .map(([k, v]) => (peer.os === 'win32' ? `set ${k}=${v}&& ` : `${k}=${v} `)).join('');
    const line = remoteLine(peer.os === 'win32' ? `${prefix}${command}` : `export ${prefix.trim()}; ${command}`, peer.os, nonce, label);
    for (const keys of [['-l', id, line], [id, 'Enter']]) {
      const sent = paseo(['terminal', 'send-keys', ...keys], { ...conn, timeoutMs: 60_000 });
      if (sent.code !== 0) throw new CliError(`Can't type into the terminal on ${where}: ${errorText(sent)}`, { hint: 'Nothing ran there (the terminal is closed again). Usually a brief network drop: try again.' });
    }
    const deadline = Date.now() + timeoutSeconds * 1000;
    let failingSince = null;
    finished = false;
    while (Date.now() < deadline) {
      await sleep(1500);
      const cap = paseo(['terminal', 'capture', id, '--scrollback'], { ...conn, timeoutMs: 60_000 });
      if (cap.code !== 0) {
        // Killed by `claude-wingman cancel`: stop at once.
        if (/no terminal found|not found/i.test(errorText(cap))) throw new CliError(`The command on ${where} was cancelled.`);
        // A connection can drop for a moment (a Wi-Fi blip): the command keeps running there, so keep trying for a while.
        failingSince ??= Date.now();
        if (Date.now() - failingSince > 30_000) throw new CliError(`Lost the terminal on ${where}: ${errorText(cap)}`);
        continue;
      }
      failingSince = null;
      // cmd.exe asking for the rest of an unfinished line: it would wait forever (cmdChild should prevent this).
      if (peer.os === 'win32' && /\nMore\? *$/.test(cap.stdout.replace(/\r/g, '').trimEnd())) {
        throw new CliError(`The command left cmd.exe on ${where} waiting for more input (an unfinished line).`);
      }
      const res = parseCapture(cap.stdout, nonce);
      if (res.done) {
        finished = true;
        return { ok: res.ok, output: res.output };
      }
    }
    throw new CliError(`Timed out after ${timeoutSeconds}s waiting for ${where}; the command there was stopped.`);
  } finally {
    // Closing a terminal stops what runs in it on macOS and Linux (sh exits on the hang-up). On Windows the command's
    // child cmd.exe would still run the rest of a chain (`a & b`), so stop its whole process tree first.
    if (finished === false && peer.os === 'win32') await stopWindowsCommand({ peer, conn }, nonce);
    // Retried: when a brief network drop is what failed the command, it can fail this too, and leave the terminal behind.
    for (let i = 0; i < 4 && paseo(['terminal', 'kill', id], { ...conn, timeoutMs: 30_000 }).code !== 0; i++) await sleep(2000);
  }
}

/**
 * Windows: stop a running remote command (the terminal's cmd.exe, the command's child cmd.exe found by its WINGMAN_RUN
 * tag, and everything they started)
 * and remove its temporary files, from a second terminal. Best effort; leftover files are swept after a day.
 */
export async function stopWindowsCommand({ peer, conn }, nonce) {
  // From the terminal's own cmd.exe (the tagged one's parent) down, so it can't print a result or run anything more.
  const kill = `Get-CimInstance Win32_Process -Filter "Name = 'cmd.exe'" | Where-Object { $_.CommandLine -like '*WINGMAN_RUN=${nonce}*' } | ` +
    'ForEach-Object { $top = $_.ProcessId; $parent = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $_.ParentProcessId); ' +
    "if ($parent.Name -eq 'cmd.exe') { $top = $parent.ProcessId }; taskkill.exe /f /t /pid $top | Out-Null }";
  const encoded = Buffer.from(kill, 'utf16le').toString('base64');
  let id;
  try {
    id = JSON.parse(paseo(['terminal', 'create', '--cwd', peer.home, '--name', `${TERMINAL_PREFIX}${nonce}: stopping`, '--json'], { ...conn, timeoutMs: 30_000 }).stdout).id;
    const line = `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded} & del /q "%TEMP%\\wingman-out-${nonce}.*" 2>NUL & echo __WMSTOP_${nonce}_^DONE__`;
    paseo(['terminal', 'send-keys', '-l', id, line], { ...conn, timeoutMs: 30_000 });
    paseo(['terminal', 'send-keys', id, 'Enter'], { ...conn, timeoutMs: 30_000 });
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      const cap = paseo(['terminal', 'capture', id, '--scrollback'], { ...conn, timeoutMs: 30_000 });
      if (cap.code === 0 && cap.stdout.includes(`__WMSTOP_${nonce}_DONE__`)) break;
    }
  } catch {
    // Unreachable or no terminal: nothing more to do from here.
  } finally {
    if (id) paseo(['terminal', 'kill', id], { ...conn, timeoutMs: 30_000 });
  }
}
