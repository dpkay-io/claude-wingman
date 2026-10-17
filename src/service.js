// Keep the Paseo daemon running at login and the machine awake, per OS.
//   macOS:   launchd LaunchAgents (daemon with KeepAlive; `caffeinate -i -s` to block idle sleep)
//   Windows: a logon Scheduled Task for the daemon; powercfg for "never sleep on AC"
//   Linux:   systemd user services (daemon with Restart=always; systemd-inhibit to block idle sleep),
//            plus "linger" so they run without a login session
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CliError, IS_LINUX, IS_MAC, IS_WINDOWS, psQuote, run, runPowerShell, which, xmlEscape } from './util.js';
import { nodeArgs, paseoHome } from './paseo.js';

export const MAC_DAEMON_LABEL = 'dev.claude-wingman.daemon';
export const MAC_AWAKE_LABEL = 'dev.claude-wingman.awake';
export const WIN_TASK = 'claude-wingman daemon';
const WIN_RESTART_TASK = 'claude-wingman restart';
const WIN_FIREWALL_RULE = 'claude-wingman daemon (Tailscale only)';
export const LINUX_DAEMON_UNIT = 'claude-wingman.service';
export const LINUX_AWAKE_UNIT = 'claude-wingman-awake.service';

const launchAgentsDir = () => path.join(os.homedir(), 'Library', 'LaunchAgents');
const plistPath = (label) => path.join(launchAgentsDir(), `${label}.plist`);
const guiDomain = () => `gui/${process.getuid()}`;

export function launchAgentPlist({ label, program, env, logFile }) {
  const args = program.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');
  const envXml = env
    ? `  <key>EnvironmentVariables</key>\n  <dict>\n${Object.entries(env)
        .map(([k, v]) => `    <key>${xmlEscape(k)}</key><string>${xmlEscape(v)}</string>`)
        .join('\n')}\n  </dict>\n`
    : '';
  const logs = logFile
    ? `  <key>StandardOutPath</key><string>${xmlEscape(logFile)}</string>\n  <key>StandardErrorPath</key><string>${xmlEscape(logFile)}</string>\n`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
${envXml}  <key>WorkingDirectory</key><string>${xmlEscape(os.homedir())}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
${logs}</dict>
</plist>
`;
}

/** PATH for the daemon: it must find `claude` (spawned per agent), `node` and `git`. */
function daemonPath() {
  const dirs = [path.dirname(process.execPath), which('claude') && path.dirname(which('claude')),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  return [...new Set(dirs.filter(Boolean))].join(':');
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const macLoaded = (label) => run('/bin/launchctl', ['print', `${guiDomain()}/${label}`]).code === 0;
function macUnload(label) {
  run('/bin/launchctl', ['bootout', `${guiDomain()}/${label}`]);
  for (let i = 0; i < 50 && macLoaded(label); i++) sleepSync(200);
}

/**
 * (Re)load LaunchAgents. `launchctl bootout` returns before the service is fully gone, and an
 * immediate `bootstrap` then fails with "5: Input/output error", so wait for the unload and retry.
 */
function macReload(labels, deferSeconds) {
  if (deferSeconds) {
    const cmds = labels.map((l) => {
      const target = `${guiDomain()}/${l}`;
      return `launchctl bootout ${target} >/dev/null 2>&1; n=0; while launchctl print ${target} >/dev/null 2>&1 && [ $n -lt 50 ]; do sleep 0.2; n=$((n+1)); done; ` +
        `for i in 1 2 3 4 5; do launchctl bootstrap ${guiDomain()} ${shQuote(plistPath(l))} && break; sleep 1; done`;
    });
    return detached(`sleep ${deferSeconds}; ${cmds.join('; ')}`);
  }
  for (const l of labels) {
    macUnload(l);
    let res;
    for (let attempt = 0; attempt < 5; attempt++) {
      res = run('/bin/launchctl', ['bootstrap', guiDomain(), plistPath(l)]);
      if (res.code === 0) break;
      sleepSync(1000);
    }
    if (res.code !== 0) throw new CliError(`launchctl bootstrap ${l} failed: ${res.stderr}`, { hint: `Retry: claude-wingman restart` });
  }
}

/** Run a shell command fully detached, so it survives this process being killed (e.g. by a daemon restart). */
function detached(command) {
  spawn('/bin/sh', ['-c', command], { detached: true, stdio: 'ignore' }).unref();
}

// ---- Linux: systemd user services ------------------------------------------------------------

const userUnitDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user');
const unitPath = (unit) => path.join(userUnitDir(), unit);
const systemctl = (...args) => run('systemctl', ['--user', ...args], { timeoutMs: 60_000 });

/** Quote one word for a systemd unit line (ExecStart=, Environment=): C-style escapes, and %% for %. */
export const systemdQuote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;

export function systemdUnit({ description, program, env = {} }) {
  return [
    '[Unit]',
    `Description=${description}`,
    '',
    '[Service]',
    `ExecStart=${program.map(systemdQuote).join(' ')}`,
    ...Object.entries(env).map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`)}`),
    'WorkingDirectory=%h',
    // Until Tailscale is up the daemon can't bind its address; it is retried every 15 s.
    'Restart=always',
    'RestartSec=15',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function requireSystemdUser() {
  const res = systemctl('show-environment');
  if (res.code !== 0) {
    throw new CliError(`systemd user services aren't available (${(res.stderr || res.stdout).split('\n')[0] || 'systemctl --user failed'}).`, {
      hint: 'claude-wingman needs systemd to keep the daemon running. On WSL, add "[boot]" and "systemd=true" to /etc/wsl.conf, then run "wsl --shutdown" from Windows.',
    });
  }
}

/** Let the user's services run without a login session (after boot, after logout). Returns a warning, or null. */
function ensureLinger() {
  const user = os.userInfo().username;
  if (run('loginctl', ['show-user', user, '--property=Linger', '--value']).stdout === 'yes') return null;
  if (run('loginctl', ['enable-linger', '--no-ask-password', user]).code === 0) return null;
  return `The daemon runs only while you're logged in. To keep it running after logout and reboot, run once: sudo loginctl enable-linger ${user}`;
}

/**
 * The strongest lock systemd-inhibit may take from a user service: "idle:sleep", "idle", or null.
 * polkit often allows blocking idle but not sleep, and may allow more in a terminal than in a service,
 * so probe where the service runs: in the user manager, through systemd-run.
 */
function allowedInhibit() {
  const bin = which('systemd-inhibit');
  if (!bin) return null;
  for (const what of ['idle:sleep', 'idle']) {
    const probe = [bin, `--what=${what}`, '--who=claude-wingman', '--why=probe', '--mode=block', 'true'];
    const res = which('systemd-run')
      ? run('systemd-run', ['--user', '--wait', '--quiet', '--collect', ...probe], { timeoutMs: 30_000 })
      : run(probe[0], probe.slice(1), { timeoutMs: 30_000 });
    if (res.code === 0) return what;
  }
  return null;
}

const inhibitDetail = (what) => `systemd-inhibit (${what === 'idle' ? 'no idle sleep' : 'no idle sleep or suspend'})`;

function linuxRestart(deferSeconds) {
  const units = [LINUX_DAEMON_UNIT, LINUX_AWAKE_UNIT].filter((unit) => fs.existsSync(unitPath(unit)));
  if (deferSeconds) {
    // A transient timer runs the restart outside the daemon's cgroup, so it survives the daemon stopping.
    const res = run('systemd-run', ['--user', `--on-active=${deferSeconds}`, '--timer-property=AccuracySec=1s', 'systemctl', '--user', 'restart', ...units]);
    if (res.code === 0) return;
    return detached(`sleep ${deferSeconds}; systemctl --user restart ${units.join(' ')}`);
  }
  const res = systemctl('restart', ...units);
  if (res.code !== 0) throw new CliError(`systemctl --user restart failed: ${res.stderr}`, { hint: `See: journalctl --user -u ${LINUX_DAEMON_UNIT}` });
}

// Task Scheduler shows a console window (a Windows Terminal tab on Windows 11) for a console program; conhost
// --headless gives it a console without one, so nothing flashes at logon, on a restart or on each watchdog run.
const CONHOST = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'conhost.exe');
const WATCHDOG_MINUTES = 2;

/**
 * Register a task that runs `exe args` without a window. With atLogon, it also runs every WATCHDOG_MINUTES minutes
 * from now on (`paseo daemon start` does nothing when the daemon is up), so a daemon that died comes back.
 */
function registerWinTask(name, exe, args, { atLogon }) {
  const triggers = atLogon
    ? `$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME; $logon.Delay = 'PT45S'; ` +
      `$watch = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes ${WATCHDOG_MINUTES}); ` +
      '$t = @($logon, $watch);'
    : '$t = $null;';
  return runPowerShell(
    `${triggers} ` +
      `$a = New-ScheduledTaskAction -Execute ${psQuote(CONHOST)} -Argument ${psQuote(`--headless ${winQuoteArg(exe)} ${args}`)}; ` +
      `$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew; ` +
      `if ($t) { Register-ScheduledTask -TaskName ${psQuote(name)} -Action $a -Trigger $t -Settings $s -Force | Out-Null } ` +
      `else { Register-ScheduledTask -TaskName ${psQuote(name)} -Action $a -Settings $s -Force | Out-Null }`,
  );
}

const winQuoteArg = (a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

// ---- WSL: keep the distro running ---------------------------------------------------------
// WSL runs a distro only while something on Windows uses it, and nothing starts it when Windows starts, so the daemon
// inside would be unreachable after a reboot or once the last WSL window closes. A Windows logon task (registered from
// inside WSL, through interop) keeps one headless `wsl.exe ... sleep infinity` running, and restarts it every
// WATCHDOG_MINUTES minutes if it ended (e.g. after `wsl --shutdown`).

export const IS_WSL = IS_LINUX && fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop');

/** This distro's name: `wslpath -w /` is \\wsl.localhost\<name>\ (or \\wsl$\<name>\ on older WSL). */
export function wslDistro() {
  const res = run('wslpath', ['-w', '/']);
  return /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\?$/.exec(res.stdout)?.[1] ?? process.env.WSL_DISTRO_NAME ?? null;
}

const wslTaskName = (distro) => `claude-wingman wsl ${distro}`;

/** Run a Windows PowerShell script from WSL (interop). The script travels base64-encoded, so nothing needs quoting. */
function wslPowerShell(script) {
  const c = run('wslpath', ['-u', 'C:\\']).stdout.replace(/\/+$/, '') || '/mnt/c';
  const exe = `${c}/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`;
  if (!fs.existsSync(exe)) return { code: 127, stdout: '', stderr: `${exe} not found (is WSL interop off?)` };
  const encoded = Buffer.from(`$ProgressPreference = 'SilentlyContinue'; ${script}`, 'utf16le').toString('base64');
  return run(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { cwd: c, timeoutMs: 60_000 });
}

/** The keep-alive task's state ("Running", "Ready", ...), or null if it isn't there. */
function wslKeepAliveState(distro) {
  const res = wslPowerShell(`$t = Get-ScheduledTask -TaskName ${psQuote(wslTaskName(distro))} -ErrorAction SilentlyContinue; if ($t) { [string]$t.State + '|' + $t.Actions[0].Arguments }`);
  const [state, args] = res.stdout.trim().split('|');
  return state ? { state, args } : null;
}

/** Make sure the keep-alive task exists and runs. Returns a warning, or null. */
function ensureWslKeepAlive() {
  const distro = wslDistro();
  if (!distro) return "Couldn't tell this WSL distribution's name, so WSL may stop when its last window closes (and won't start with Windows).";
  const args = `--headless wsl.exe -d ${distro} --exec /bin/sleep infinity`;
  const name = psQuote(wslTaskName(distro));
  const current = wslKeepAliveState(distro);
  if (current?.args !== args || current.state === 'Disabled') {
    const res = wslPowerShell(
      `$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME; ` +
        `$watch = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes ${WATCHDOG_MINUTES}); ` +
        `$a = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\\conhost.exe') -Argument ${psQuote(args)}; ` +
        `$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew; ` +
        `Register-ScheduledTask -TaskName ${name} -Action $a -Trigger @($logon, $watch) -Settings $s -Force | Out-Null`,
    );
    if (res.code !== 0) return `Couldn't register the Windows task that keeps WSL running: ${res.stderr || res.stdout}`;
  }
  if (wslKeepAliveState(distro)?.state !== 'Running') wslPowerShell(`Start-ScheduledTask -TaskName ${name}`);
  return null;
}

/**
 * Install daemon autostart and keep-awake.
 * The daemon is (re)started only when something changed or `force` is set (e.g. its config changed),
 * so re-running setup doesn't interrupt running agents. With noRestart, nothing is (re)started.
 * @returns {{ restarted: boolean, pending: boolean, warnings?: string[] }} pending: a restart is needed but noRestart prevented it
 */
export function installServices({ entry, deferSeconds = 0, noRestart = false, force = false }) {
  let changed = false;
  if (IS_MAC) {
    fs.mkdirSync(launchAgentsDir(), { recursive: true });
    const desired = {
      [MAC_DAEMON_LABEL]: launchAgentPlist({
        label: MAC_DAEMON_LABEL,
        program: [process.execPath, ...nodeArgs(entry, ['daemon', 'run'])],
        env: { PATH: daemonPath(), HOME: os.homedir() },
        logFile: path.join(paseoHome(), 'launchd.log'),
      }),
      // -i: no idle sleep on any power source; -s: no system sleep on AC. Closing the lid on battery still sleeps.
      [MAC_AWAKE_LABEL]: launchAgentPlist({ label: MAC_AWAKE_LABEL, program: ['/usr/bin/caffeinate', '-i', '-s'] }),
    };
    for (const [label, text] of Object.entries(desired)) {
      const current = fs.existsSync(plistPath(label)) ? fs.readFileSync(plistPath(label), 'utf8') : null;
      if (current !== text) {
        fs.writeFileSync(plistPath(label), text);
        changed = true;
      }
      if (!macLoaded(label)) changed = true;
    }
    if (noRestart || !(changed || force)) return { restarted: false, pending: noRestart && (changed || force) };
    // A daemon started by hand (paseo daemon start) would hold the port; stop it before launchd takes over.
    if (!deferSeconds) run(process.execPath, nodeArgs(entry, ['daemon', 'stop']), { timeoutMs: 30_000 });
    macReload([MAC_DAEMON_LABEL, MAC_AWAKE_LABEL], deferSeconds);
    return { restarted: true, pending: false };
  }
  if (IS_WINDOWS) {
    const args = nodeArgs(entry, ['daemon', 'start']).map(winQuoteArg).join(' ');
    const existing = runPowerShell(
      `$t = Get-ScheduledTask -TaskName ${psQuote(WIN_TASK)} -ErrorAction SilentlyContinue; ` +
        `if ($t) { $t.Actions[0].Execute + '|' + $t.Actions[0].Arguments + '|' + $t.State + '|' + (@($t.Triggers | ForEach-Object { $_.Repetition.Interval }) -join ',') }`,
    ).stdout;
    const [exe, taskArgs, state, intervals] = existing.split('|');
    const current = exe === CONHOST && taskArgs === `--headless ${winQuoteArg(process.execPath)} ${args}` && (intervals ?? '').includes(`PT${WATCHDOG_MINUTES}M`);
    if (!current || !state || state === 'Disabled') {
      const res = registerWinTask(WIN_TASK, process.execPath, args, { atLogon: true });
      if (res.code !== 0) throw new CliError(`Registering the "${WIN_TASK}" task failed: ${res.stderr}`);
      changed = true;
    }
    // Never sleep while on AC power (no admin rights needed).
    run('powercfg', ['/change', 'standby-timeout-ac', '0']);
    if (noRestart || !(changed || force)) return { restarted: false, pending: noRestart && (changed || force) };
    restartDaemon({ entry, deferSeconds });
    return { restarted: true, pending: false };
  }
  if (IS_LINUX) {
    requireSystemdUser();
    fs.mkdirSync(userUnitDir(), { recursive: true });
    const desired = {
      [LINUX_DAEMON_UNIT]: systemdUnit({
        description: 'claude-wingman daemon (Paseo, Tailscale only)',
        program: [process.execPath, ...nodeArgs(entry, ['daemon', 'run'])],
        env: { PATH: daemonPath(), HOME: os.homedir() },
      }),
    };
    const warnings = [];
    // Blocks idle sleep (and suspend, when allowed) while it runs, like caffeinate on macOS.
    const what = allowedInhibit();
    if (what) {
      desired[LINUX_AWAKE_UNIT] = systemdUnit({
        description: 'claude-wingman: keep this machine awake',
        program: [which('systemd-inhibit'), `--what=${what}`, '--who=claude-wingman',
          '--why=Keep the claude-wingman daemon reachable', '--mode=block', 'sleep', 'infinity'],
      });
      if (what === 'idle') warnings.push("Blocking idle sleep only: this system doesn't let claude-wingman block suspend. Turn off automatic suspend in your power settings if it has one.");
    } else {
      if (fs.existsSync(unitPath(LINUX_AWAKE_UNIT))) {
        systemctl('disable', '--now', LINUX_AWAKE_UNIT);
        fs.rmSync(unitPath(LINUX_AWAKE_UNIT), { force: true });
      }
      warnings.push("Can't keep this machine awake (systemd-inhibit is missing or refused). Turn off automatic sleep in your power settings.");
    }
    let wrote = false;
    for (const [unit, text] of Object.entries(desired)) {
      const current = fs.existsSync(unitPath(unit)) ? fs.readFileSync(unitPath(unit), 'utf8') : null;
      if (current !== text) {
        fs.writeFileSync(unitPath(unit), text);
        wrote = true;
      }
    }
    if (wrote) systemctl('daemon-reload');
    for (const unit of Object.keys(desired)) {
      if (systemctl('is-enabled', unit).stdout !== 'enabled') {
        const res = systemctl('enable', unit);
        if (res.code !== 0) throw new CliError(`systemctl --user enable ${unit} failed: ${res.stderr}`);
        changed = true;
      }
      if (systemctl('is-active', unit).stdout !== 'active') changed = true;
    }
    changed ||= wrote;
    const linger = ensureLinger();
    if (linger) warnings.push(linger);
    if (IS_WSL) {
      const keep = ensureWslKeepAlive();
      if (keep) warnings.push(keep);
    }
    if (noRestart || !(changed || force)) return { restarted: false, pending: noRestart && (changed || force), warnings };
    if (!deferSeconds) run(process.execPath, nodeArgs(entry, ['daemon', 'stop']), { timeoutMs: 30_000 });
    linuxRestart(deferSeconds);
    return { restarted: true, pending: false, warnings };
  }
  throw new CliError(`Automatic start isn't supported on ${process.platform}.`);
}

/** Restart the daemon so it picks up config changes. With deferSeconds, it happens later, outside this process tree. */
export function restartDaemon({ entry, deferSeconds = 0 }) {
  if (IS_MAC) {
    if (!fs.existsSync(plistPath(MAC_DAEMON_LABEL))) throw new CliError('Autostart is not installed.', { hint: 'Run: claude-wingman setup' });
    return macReload([MAC_DAEMON_LABEL, MAC_AWAKE_LABEL], deferSeconds);
  }
  if (IS_WINDOWS) {
    // Run stop+start from Task Scheduler: an agent started by this daemon would otherwise be killed
    // between "stop" and "start", leaving the daemon down.
    const node = psQuote(process.execPath);
    const js = psQuote(entry);
    const script = `Start-Sleep -Seconds ${Math.max(1, deferSeconds)}; & ${node} --disable-warning=DEP0040 ${js} daemon stop; Start-Sleep -Seconds 2; & ${node} --disable-warning=DEP0040 ${js} daemon start`;
    const reg = registerWinTask(WIN_RESTART_TASK, 'powershell.exe',
      `-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${script.replace(/"/g, '\\"')}"`, { atLogon: false });
    if (reg.code !== 0) throw new CliError(`Registering the restart task failed: ${reg.stderr}`);
    const res = runPowerShell(`Start-ScheduledTask -TaskName ${psQuote(WIN_RESTART_TASK)}`);
    if (res.code !== 0) throw new CliError(`Starting the restart task failed: ${res.stderr}`);
    return;
  }
  if (IS_LINUX) {
    if (!fs.existsSync(unitPath(LINUX_DAEMON_UNIT))) throw new CliError('Autostart is not installed.', { hint: 'Run: claude-wingman setup' });
    return linuxRestart(deferSeconds);
  }
  throw new CliError(`Restarting the daemon isn't supported on ${process.platform}.`);
}

/** On WSL: { running, detail } for the keep-alive task; undefined elsewhere. */
function wslStatus() {
  if (!IS_WSL) return undefined;
  const distro = wslDistro();
  const state = distro && wslKeepAliveState(distro)?.state;
  return { running: state === 'Running', detail: state ? `Windows task "${wslTaskName(distro)}" (${state})` : 'Windows task missing' };
}

export function serviceStatus() {
  if (IS_MAC) {
    const state = (label) => /state = running/.test(run('/bin/launchctl', ['print', `${guiDomain()}/${label}`]).stdout);
    return { autostart: state(MAC_DAEMON_LABEL), awake: state(MAC_AWAKE_LABEL), awakeDetail: 'caffeinate -i -s (no idle sleep; AC: no sleep)' };
  }
  if (IS_WINDOWS) {
    const task = runPowerShell(`(Get-ScheduledTask -TaskName ${psQuote(WIN_TASK)} -ErrorAction SilentlyContinue).State`).stdout;
    const sleep = run('powercfg', ['/query', 'SCHEME_CURRENT', 'SUB_SLEEP', 'STANDBYIDLE']).stdout;
    // The labels are localized; the last two hex values are always the AC then DC index.
    const values = [...sleep.matchAll(/:\s*0x([0-9a-f]+)/gi)].map((m) => parseInt(m[1], 16));
    const ac = values.length >= 2 ? values[values.length - 2] : undefined;
    return { autostart: Boolean(task) && task !== 'Disabled', autostartDetail: task, awake: ac === 0, awakeDetail: 'never sleep on AC' };
  }
  if (IS_LINUX) {
    const up = (unit) => systemctl('is-enabled', unit).stdout === 'enabled' && systemctl('is-active', unit).stdout === 'active';
    if (!fs.existsSync(unitPath(LINUX_AWAKE_UNIT))) {
      // Not installed because this system refuses the lock: reported, but not a failure.
      return { autostart: up(LINUX_DAEMON_UNIT), awake: null, awakeDetail: 'not available here (systemd-inhibit refused); set power settings to never sleep', wsl: wslStatus() };
    }
    const what = /--what=([a-z:]+)/.exec(fs.readFileSync(unitPath(LINUX_AWAKE_UNIT), 'utf8'))?.[1];
    return { autostart: up(LINUX_DAEMON_UNIT), awake: up(LINUX_AWAKE_UNIT), awakeDetail: inhibitDetail(what), wsl: wslStatus() };
  }
  return { autostart: false, awake: false };
}

export function removeServices({ entry } = {}) {
  if (IS_MAC) {
    for (const label of [MAC_DAEMON_LABEL, MAC_AWAKE_LABEL]) {
      run('/bin/launchctl', ['bootout', `${guiDomain()}/${label}`]);
      fs.rmSync(plistPath(label), { force: true });
    }
  } else if (IS_WINDOWS) {
    for (const name of [WIN_TASK, WIN_RESTART_TASK]) {
      runPowerShell(`if (Get-ScheduledTask -TaskName ${psQuote(name)} -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName ${psQuote(name)} -Confirm:$false }`);
    }
    if (entry) run(process.execPath, nodeArgs(entry, ['daemon', 'stop']), { timeoutMs: 30_000 });
  } else if (IS_LINUX) {
    const units = [LINUX_DAEMON_UNIT, LINUX_AWAKE_UNIT];
    systemctl('disable', '--now', ...units);
    for (const unit of units) fs.rmSync(unitPath(unit), { force: true });
    systemctl('daemon-reload');
    const distro = IS_WSL && wslDistro();
    if (distro) {
      const name = psQuote(wslTaskName(distro));
      wslPowerShell(`if (Get-ScheduledTask -TaskName ${name} -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName ${name} -Confirm:$false }`);
    }
  }
}

/** Windows only: add an inbound firewall rule limited to Tailscale addresses (needs an elevated shell). */
export function ensureWindowsFirewall(port) {
  const name = WIN_FIREWALL_RULE;
  const cmd = `New-NetFirewallRule -DisplayName '${name}' -Direction Inbound -Protocol TCP -LocalPort ${port} -RemoteAddress 100.64.0.0/10 -Action Allow`;
  const res = runPowerShell(
    `if (Get-NetFirewallRule -DisplayName ${psQuote(name)} -ErrorAction SilentlyContinue) { 'exists' } ` +
      `elseif (([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { ${cmd} | Out-Null; 'added' } else { 'not-admin' }`,
  );
  return { state: res.stdout.trim(), command: cmd };
}
