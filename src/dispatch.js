// Building and running a dispatched task on a peer.
import { CliError } from './util.js';
import { errorText, paseo, paseoJson } from './paseo.js';

const isAbsoluteFor = (osName, p) => (osName === 'win32' ? /^([A-Za-z]:[\\/]|\\\\)/.test(p) : p.startsWith('/'));

/** Resolve --repo (a folder name or a full path on the peer) to a path on the peer, in the peer's path style. */
export function resolveRepoPath(peer, repo, flag = '--repo') {
  if (!repo) return peer.home;
  if (isAbsoluteFor(peer.os, repo)) return repo;
  if (/[\\/]/.test(repo) || repo === '..' || repo === '.') {
    throw new CliError(`${flag} "${repo}" must be a folder name under ${peer.reposRoot} or a full path on the peer.`);
  }
  const sep = peer.os === 'win32' ? '\\' : '/';
  return `${peer.reposRoot.replace(/[\\/]+$/, '')}${sep}${repo}`;
}

/** The prompt the remote agent receives. With a branch, it works in a sibling worktree so the user's checkout is untouched. */
export function buildPrompt({ task, from, branch, repoPath }) {
  const lines = [`You were dispatched from the machine "${from}" at the user's request.`];
  if (branch) {
    const wt = `${repoPath}-remote-test`;
    lines.push(
      `The folder ${repoPath} is the user's working copy: never switch its branch or modify it.`,
      `Run \`git fetch origin\` there. Then work in the sibling worktree ${wt}: if it exists, run \`git -C "${wt}" checkout --detach origin/${branch}\`, otherwise \`git worktree add --detach "${wt}" origin/${branch}\`.`,
      `Do all work inside ${wt}. If you commit fixes, push them with \`git push origin HEAD:${branch}\`. Never push to main or master.`,
    );
  }
  lines.push(
    'Run scripts with the interpreter their shebang names.',
    '',
    `Task: ${task}`,
    '',
    'Finish with a short report: what you ran, pass/fail, and the exact failing output if anything failed.',
  );
  return lines.join('\n');
}

/** "9m", "540s", "1h", "90" (seconds) -> seconds. */
export function parseDuration(text) {
  const m = /^(\d+)\s*([smh]?)$/.exec(String(text).trim());
  if (!m) throw new CliError(`Invalid duration "${text}" (use e.g. 90, 90s, 9m, 1h).`);
  return Number(m[1]) * ({ '': 1, s: 1, m: 60, h: 3600 })[m[2]];
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/;

/** Start the agent on the peer; returns its id. */
export function startAgent(conn, { cwd, title, prompt, model }) {
  const args = ['run', '-d', '--quiet', '--provider', 'claude', '--mode', 'auto', '--cwd', cwd, '--title', title,
    '--env', 'GIT_TERMINAL_PROMPT=0', '--env', 'GCM_INTERACTIVE=never'];
  if (model) args.push('--model', model);
  const res = paseo([...args, prompt], conn);
  const id = UUID.exec(res.stdout)?.[0];
  if (res.code !== 0 || !id) throw new CliError(`Starting the agent failed: ${res.stderr || res.stdout}`);
  return id;
}

/** Wait for an agent; returns "idle" | "permission" | "timeout" | "error". */
export function waitAgent(conn, id, seconds) {
  const out = paseoJson(['wait', id, '--timeout', String(seconds)], { ...conn, timeoutMs: (seconds + 60) * 1000 });
  return out.status;
}

export function finalReport(conn, id) {
  const res = paseo(['logs', id, '--filter', 'text', '--tail', '1'], conn);
  if (res.code !== 0) return `(could not fetch the report: ${errorText(res)})`;
  return res.stdout;
}
