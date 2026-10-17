// claude-wingman dispatch <peer> ... and claude-wingman <peer> <paseo args>
import { parseArgs } from '../args.js';
import { requirePeer, requireSelf } from '../config.js';
import { buildPrompt, finalReport, parseDuration, resolveRepoPath, startAgent, waitAgent } from '../dispatch.js';
import { paseo, paseoInteractive } from '../paseo.js';
import { getSecret } from '../secrets.js';
import { CliError, ui } from '../util.js';

export const EXIT = { done: 0, error: 1, permission: 3, running: 4 };

/** Connection options for a paired peer. */
export function peerConnection(cfg, name) {
  const peer = requirePeer(cfg, name);
  const password = getSecret(`peer:${name}`);
  if (!password) throw new CliError(`No stored password for ${name}.`, { hint: `Re-pair: claude-wingman pair ${peer.machine}` });
  return { name, peer, conn: { host: `${peer.host}:${peer.port}`, password } };
}

export async function dispatch(argv) {
  const { opts, positionals } = parseArgs(argv, {
    repo: 'string', branch: 'string', detach: 'boolean', timeout: 'string', model: 'string', title: 'string', json: 'boolean',
  });
  const [name, ...words] = positionals;
  const task = words.join(' ').trim();
  if (!name || !task) {
    throw new CliError('Usage: claude-wingman dispatch <peer> [--repo <name|path>] [--branch <branch>] [--detach] [--timeout 9m] "<task>"');
  }
  if (opts.branch) {
    if (!/^[\w./-]+$/.test(opts.branch)) throw new CliError(`Invalid branch name "${opts.branch}".`);
    if (/^(main|master)$/.test(opts.branch)) throw new CliError(`--branch ${opts.branch}: dispatched agents may push to the branch, so use a separate one (e.g. ${name}-test/<topic>).`);
    if (!opts.repo) throw new CliError('--branch needs --repo (the repository to make the worktree from).');
  }
  const cfg = requireSelf();
  const { peer, conn } = peerConnection(cfg, name);
  const cwd = resolveRepoPath(peer, opts.repo);
  const timeout = parseDuration(opts.timeout ?? '9m');
  const prompt = buildPrompt({ task, from: cfg.self.name, branch: opts.branch, repoPath: cwd });
  const title = opts.title ?? `${cfg.self.name}: ${task.replace(/\s+/g, ' ').slice(0, 60)}`;

  const id = startAgent(conn, { cwd, title, prompt, model: opts.model });
  const out = (status, extra = {}) => {
    if (opts.json) console.log(JSON.stringify({ peer: name, agentId: id, status, cwd, ...extra }, null, 2));
  };
  if (!opts.json) ui.ok(`Dispatched to ${name} as agent ${id}  ${ui.dim(`(cwd ${cwd})`)}`);
  if (opts.detach) {
    out('running');
    if (!opts.json) ui.info(`Check later: claude-wingman status ${name}   Its steps: claude-wingman logs ${id.slice(0, 7)}   Its report: claude-wingman ${name} logs ${id} --filter text --tail 1`);
    return EXIT.done;
  }

  if (!opts.json) ui.info(`Waiting up to ${opts.timeout ?? '9m'} ...`);
  let status;
  try {
    status = waitAgent(conn, id, timeout);
  } catch (err) {
    // The agent is running on the peer; never lose its id.
    out('unknown', { error: err.message });
    if (!opts.json) {
      ui.fail(`Lost contact while waiting: ${err.message}`);
      ui.info(`The agent may still be running. Check: claude-wingman ${name} logs ${id} --filter text --tail 1`);
    }
    return EXIT.error;
  }
  if (status === 'idle') {
    const report = finalReport(conn, id);
    out('done', { report });
    if (!opts.json) {
      ui.ok(`${name} agent finished. Its report:\n`);
      console.log(report || ui.dim('(no text output)'));
    }
    return EXIT.done;
  }
  if (status === 'permission') {
    const pending = paseo(['permit', 'ls'], conn).stdout;
    out('permission', { pending });
    if (!opts.json) {
      ui.warn(`${name} agent is waiting for a permission:`);
      console.log(pending);
      ui.info(`Allow: claude-wingman ${name} permit allow ${id}   Deny: claude-wingman ${name} permit deny ${id}`);
    }
    return EXIT.permission;
  }
  if (status === 'timeout') {
    out('running');
    if (!opts.json) ui.warn(`Still running after ${opts.timeout ?? '9m'}. Continue: claude-wingman ${name} wait ${id} --timeout 540`);
    return EXIT.running;
  }
  const report = finalReport(conn, id);
  out('error', { report });
  if (!opts.json) {
    ui.fail(`${name} agent ended with an error.`);
    console.log(report);
  }
  return EXIT.error;
}

/** claude-wingman <peer> [paseo args...]: run any paseo command against the peer's daemon. */
export function passthrough(name, args) {
  const cfg = requireSelf();
  const { conn } = peerConnection(cfg, name);
  return paseoInteractive(args.length ? args : ['ls'], conn);
}
