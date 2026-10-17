// End-to-end checks against your real paired machines, through the real CLI:
//   npm run e2e                                  every paired machine
//   CLAUDE_WINGMAN_E2E=msi,wsl npm run e2e       only these
//   CLAUDE_WINGMAN_E2E_AGENTS=1 npm run e2e      also start small agents (costs a little Claude usage)
// Run it on a machine that is set up and paired. What runs on the other machines is harmless: echo, a short
// ping or sleep, and a temporary file. Each test names the machine and what it checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'claude-wingman.js');
const cfg = loadConfig();
const only = process.env.CLAUDE_WINGMAN_E2E?.split(',').map((s) => s.trim()).filter(Boolean);
const peers = Object.entries(cfg.peers).filter(([name]) => !only || only.includes(name));
const agents = process.env.CLAUDE_WINGMAN_E2E_AGENTS === '1';

/** Run the CLI; returns { code, out } (stdout and stderr together). */
function cli(args, timeoutMs = 300_000) {
  const res = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: timeoutMs });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}
const runOn = (name, command, extra = []) => cli(['run', name, ...extra, '--', command]);
const sleepFor = (ms) => new Promise((r) => setTimeout(r, ms));

test('there is something to test', { skip: !cfg.self && 'this machine is not set up' }, () => {
  assert.ok(peers.length, only ? `none of ${only.join(', ')} is paired here` : 'no paired machines');
});

for (const [name, peer] of peers) {
  const win = peer.os === 'win32';
  const nonce = Math.random().toString(16).slice(2, 10);
  const marker = win ? `%TEMP%\\wingman-e2e-${nonce}` : `/tmp/wingman-e2e-${nonce}`;
  const seq = (n) => (win ? `for /l %i in (1,1,${n}) do @echo line %i` : `seq 1 ${n} | sed 's/^/line /'`);
  const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

  test(`${name}: status sees it`, () => {
    const res = cli(['status', name, '--json']);
    assert.equal(res.code, 0, res.out);
    assert.equal(JSON.parse(res.out).machines[0].reachable, true);
  });

  test(`${name}: run prints exact output and reports failure`, () => {
    assert.deepEqual(runOn(name, 'echo hello'), { code: 0, out: 'hello\n' });
    assert.equal(runOn(name, win ? 'dir C:\\wingman-no-such-dir' : 'ls /wingman-no-such-dir').code, 1);
    const indented = runOn(name, win ? 'echo.& echo   indented' : "printf '\\n  indented\\n'");
    assert.equal(indented.out, '\n  indented\n', 'leading blank line and indentation kept');
  });

  test(`${name}: long output comes back exactly, or its end when too long`, () => {
    assert.deepEqual(runOn(name, seq(2500)), { code: 0, out: `${lines(2500)}\n` });
    const cut = runOn(name, seq(15000));
    assert.equal(cut.code, 0);
    const got = cut.out.trimEnd().split('\n');
    assert.match(got[0], /^\(the start of the output didn't fit/);
    assert.deepEqual(got.slice(1), lines(15000).split('\n').slice(-(got.length - 1)), 'whole lines, through the last');
  });

  test(`${name}: shell syntax that broke the typed line on Windows works`, { skip: !win && 'Windows only' }, () => {
    assert.deepEqual(runOn(name, 'echo (x) & echo a)'), { code: 0, out: '(x) \na)\n' });
    assert.deepEqual(runOn(name, 'rem nothing'), { code: 0, out: '' });
    assert.deepEqual(runOn(name, 'if exist C:\\Windows (echo yes) else (echo no)'), { code: 0, out: 'yes\n' });
  });

  test(`${name}: a command past its timeout is stopped there`, async () => {
    const res = runOn(name, win ? `ping -n 25 127.0.0.1 >NUL & echo x> ${marker}` : `sleep 20; touch ${marker}`, ['--timeout', '5s']);
    assert.equal(res.code, 1);
    assert.match(res.out, /Timed out after 5s .*the command there was stopped/);
    await sleepFor(22_000);
    const check = runOn(name, win ? `if exist ${marker} (echo FINISHED) else (echo stopped)` : `[ -e ${marker} ] && echo FINISHED || echo stopped`);
    assert.equal(check.out.trim(), 'stopped', `the command must not have reached its end; the check printed: ${check.out}`);
  });

  test(`${name}: cancel stops a running command, and status shows it first`, async () => {
    const label = `e2e-${nonce}`;
    const after = `${marker}-cancel`;
    const child = spawn(process.execPath, [CLI, 'run', name, '--', win ? `ping -n 60 127.0.0.1 >NUL & echo x> ${after} & echo ${label}` : `sleep 60; touch ${after}; echo ${label}`]);
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const exited = new Promise((r) => child.on('exit', r));
    let id;
    for (let i = 0; i < 20 && !id; i++) {
      await sleepFor(3000);
      const snap = JSON.parse(cli(['status', name, '--json']).out).machines[0];
      id = snap.commands.find((c) => c.title.includes(label))?.shortId;
    }
    assert.ok(id, 'status lists the command');
    assert.equal(cli(['cancel', id]).code, 0);
    assert.equal(await exited, 1);
    assert.match(out, /was cancelled/);
    await sleepFor(3000);
    const check = runOn(name, win ? `if exist ${after} (echo RAN) else (echo stopped)` : `[ -e ${after} ] && echo RAN || echo stopped`);
    assert.equal(check.out.trim(), 'stopped', `the rest of the command must not run after cancel; the check printed: ${check.out}`);
  });

  test(`${name}: it logs the commands it receives`, () => {
    const label = `log-check-${nonce}`;
    runOn(name, `echo ${label}`);
    const log = runOn(name, win ? 'type "%USERPROFILE%\\.claude-wingman\\remote-commands.log"' : 'tail -n 5 ~/.claude-wingman/remote-commands.log');
    assert.match(log.out, new RegExp(`from ${cfg.self.name}: run echo ${label}`));
  });

  test(`${name}: remote runs claude-wingman there`, () => {
    const res = cli(['remote', name, 'version']);
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /\d+\.\d+\.\d+/);
  });

  test(`${name}: dispatch, pause, resume and cancel a real agent`, { skip: !agents && 'set CLAUDE_WINGMAN_E2E_AGENTS=1' }, async () => {
    const quick = cli(['dispatch', name, '--model', 'claude-haiku-5-5', '--title', `wingman-e2e ${nonce}`, 'Reply with just the word READY.']);
    assert.equal(quick.code, 0, quick.out);
    assert.match(quick.out, /READY/);
    const busy = win ? 'ping -n 120 127.0.0.1' : 'ping -c 120 127.0.0.1';
    const started = cli(['dispatch', name, '--detach', '--model', 'claude-haiku-5-5', '--title', `wingman-e2e busy ${nonce}`,
      `Run this exact command in the foreground and wait for it to finish: ${busy}. Then reply DONE.`]);
    const id = /agent ([0-9a-f-]{36})/.exec(started.out)?.[1]?.slice(0, 8);
    assert.ok(id, started.out);
    const state = () => JSON.parse(cli(['status', name, '--json', '--all']).out).machines[0].agents.find((a) => a.id.startsWith(id))?.state;
    for (let i = 0; i < 10 && state() !== 'running'; i++) await sleepFor(3000);
    assert.equal(state(), 'running');
    assert.equal(cli(['pause', id]).code, 0);
    assert.equal(state(), 'paused');
    assert.equal(cli(['resume', id]).code, 0);
    await sleepFor(5000);
    assert.equal(state(), 'running');
    assert.equal(cli(['cancel', id]).code, 0);
    assert.equal(state(), 'cancelled');
  });
}
