// Entry point: route a command line to its implementation.
import { loadConfig } from './config.js';
import { dispatch, passthrough } from './commands/dispatch.js';
import { restart, skill, uninstall, unpair } from './commands/manage.js';
import { pair } from './commands/pair.js';
import { setup } from './commands/setup.js';
import { doctor, verify } from './commands/verify.js';
import { remote, runCommand, update } from './commands/remote.js';
import { cancel, logs, pause, resume, status } from './commands/agents.js';
import { CliError, VERSION, ui } from './util.js';


export const HELP = `claude-wingman ${VERSION}: your Claude Code wingman on your other machine.
Let Claude Code on one machine run agents on another, over Tailscale.

Get started (run on both machines, any order):
  claude-wingman pair [<machine>...] [--all] [--as <name>] [--repos <dir>]
                                              set this machine up if needed, then exchange credentials
                                              with other machines over Taildrop. With no <machine>, offers
                                              your other computers on Tailscale (--all: pair with every one).
       [--name <alias>] [--send-only | --receive-only] [--timeout 10m]
  npx claude-wingman pair                     the same, without installing first (it installs itself)

Setup details (optional):
  claude-wingman doctor                       check prerequisites
  claude-wingman setup [--name <name>] [--repos <dir>] [--rotate-password] [--no-restart]
                                              (re)configure the daemon: Tailscale-only, password,
                                              autostart, keep-awake. Safe to re-run.

Use:
  claude-wingman dispatch <peer> [--repo <name|path>] [--branch <branch>] [--detach]
                          [--timeout 9m] [--model <model>] [--json] "<task>"
                                              run a Claude agent on <peer> and print its report
                                              (exit 0 done, 3 waiting for permission, 4 still running)
  claude-wingman <peer> [paseo args]          any paseo command against <peer>
                                              (ls, logs <id>, wait <id>, send <id> "...", permit ls, ...)

See and control what runs, on every machine:
  claude-wingman status [<machine>...] [--all] [--watch] [--json]
                                              agents and remote commands on all machines (or the named
                                              ones): running, waiting for permission, paused, finished
  claude-wingman logs <id> [--follow]         an agent's activity, wherever it runs
  claude-wingman pause <id>                   interrupt an agent, keeping its conversation
  claude-wingman resume <id> ["<message>"]    let it carry on (default: continue where it left off)
  claude-wingman cancel <id>                  stop an agent, or a remote command, for good
                                              (<id>: the start of an id from status is enough)

Manage every machine from this one:
  claude-wingman update [<machine>...]        install this machine's claude-wingman version on paired
                                              machines (all by default) and apply it there
  claude-wingman remote <machine>|--all <cmd> run a claude-wingman command on other machines,
                                              e.g. "remote --all verify", "remote msi setup"
  claude-wingman run <machine>|--all [--cwd <dir>] [--timeout 10m] -- <command>
                                              run any shell command there (cmd.exe on Windows, sh
                                              elsewhere) and print its output. Like SSH: for you,
                                              with your rights and no agent safety checks.

Maintain:
  claude-wingman verify [--round-trip]        check security and connectivity end to end
  claude-wingman skill                        rewrite the Claude skills for all peers
  claude-wingman restart                      restart this machine's daemon
  claude-wingman unpair <peer>                forget a peer
  claude-wingman uninstall --yes              remove everything claude-wingman set up

In Claude Code, just ask: "run the tests for <project> on <peer>". Each peer has a skill.`;

export async function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    let code = 0;
    switch (cmd) {
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        console.log(HELP);
        break;
      case 'version':
      case '--version':
      case '-v':
        console.log(VERSION);
        break;
      case 'doctor':
        code = doctor();
        break;
      case 'setup':
        await setup(rest);
        break;
      case 'pair':
        code = await pair(rest);
        break;
      case 'dispatch':
        code = await dispatch(rest);
        break;
      case 'status':
      case 'peers': // what peers showed (reachability) is part of status now
        code = await status(rest);
        break;
      case 'cancel':
        code = await cancel(rest);
        break;
      case 'pause':
        code = await pause(rest);
        break;
      case 'resume':
        code = await resume(rest);
        break;
      case 'logs':
        code = await logs(rest);
        break;
      case 'verify':
        code = await verify(rest);
        break;
      case 'skill':
        skill();
        break;
      case 'restart':
        restart();
        break;
      case 'unpair':
        unpair(rest);
        break;
      case 'remote':
        code = await remote(rest);
        break;
      case 'update':
        code = await update(rest);
        break;
      case 'run':
        code = await runCommand(rest);
        break;
      case 'uninstall':
        uninstall(rest);
        break;
      default:
        if (Object.hasOwn(loadConfig().peers, cmd)) {
          code = passthrough(cmd, rest);
          break;
        }
        throw new CliError(`Unknown command or peer "${cmd}".`, { hint: 'Run: claude-wingman help' });
    }
    return code;
  } catch (err) {
    if (err instanceof CliError) {
      ui.fail(err.message);
      if (err.hint) ui.hint(err.hint);
      return err.exitCode;
    }
    throw err;
  }
}
