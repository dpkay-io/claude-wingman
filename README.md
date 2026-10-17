# claude-wingman

[![Claude Code](https://img.shields.io/badge/Claude_Code-cc785c)](https://code.claude.com) [![platform](https://img.shields.io/badge/platform-windows%20%7C%20macos%20%7C%20linux-blue)](https://github.com/dpkay-io/claude-wingman) [![CI](https://github.com/dpkay-io/claude-wingman/actions/workflows/ci.yml/badge.svg)](https://github.com/dpkay-io/claude-wingman/actions/workflows/ci.yml) [![license](https://img.shields.io/npm/l/claude-wingman.svg)](https://github.com/dpkay-io/claude-wingman/blob/main/LICENSE) [![npm version](https://img.shields.io/npm/v/claude-wingman.svg)](https://www.npmjs.com/package/claude-wingman) [![npm downloads](https://img.shields.io/npm/dt/claude-wingman.svg)](https://www.npmjs.com/package/claude-wingman) [![node](https://img.shields.io/node/v/claude-wingman.svg)](https://nodejs.org)

**Use all your computers from one Claude Code session.**

Tell Claude *"run the tests on my Windows laptop"* and it happens there, while you keep working here. claude-wingman lets Claude Code on any of your machines (a Mac, a Windows PC, a Linux box, WSL) hand work to the others and bring the result back. No SSH, no remote desktop, no copying code around.

```
you, on the Mac:   Push this branch and run the test suite on msi.
Claude:            Dispatched to msi … 214 passed, 2 failed on Windows: path separators in
                   src/export.ts. Fixed both, pushed to msi-test/export. All 216 pass.
```
<sub>An example of a session: "msi" is the Windows laptop's name in claude-wingman.</sub>

## Why claude-wingman

Most developers have more than one computer, and each can do something the others can't: Windows-only builds and tests, Linux tooling, the desktop with the big GPU, the Mac that signs the iOS app. Using the other one usually means walking over to it, or SSH, remote desktop and moving code back and forth. With claude-wingman you just ask Claude, from wherever you are.

- **Just ask, in plain language.** Your normal `claude` CLI learns about your other machines: *"build it on Windows"*, *"check the app starts on Linux"*, *"what's running on my machines?"*
- **A real agent on the other machine, not just a command.** A Claude agent works there with that machine's own OS, files and tools, fixes what it finds, pushes the fix to your branch, and reports back to the session you're in.
- **One command per machine, once.** `npx claude-wingman pair`. No ports to open, no SSH keys, no config files, no passwords to copy.
- **Then never visit them again.** See what's running everywhere, pause, resume or cancel it, update every machine, or run a quick command, all from whichever machine you're at.
- **Private and safe by default.** Your machines talk only over your own [Tailscale](https://tailscale.com) network, with a password on every connection. Agents keep Claude Code's safety checks on, and your working copy on the other machine is never touched.

## What it's for

- **Cross-platform testing:** finish a change on your Mac, and have it tested on Windows and Linux before it reaches `main`.
- **The right machine for the job:** builds that need Windows, tools that only run on Linux, the machine with the GPU or the signing keys.
- **Handing off long jobs:** start a long test run or build on the desktop (`--detach`), carry on with your laptop, and check in later with `claude-wingman status`.
- **One place to look after every machine:** `claude-wingman status --watch` shows what runs everywhere; `claude-wingman update` brings every machine to the same version.

## How it compares

| | SSH or remote desktop | claude-wingman |
|---|---|---|
| **Setup** | A server and keys on every machine, open ports or a VPN (Windows needs OpenSSH Server, which needs admin) | `npx claude-wingman pair` on each machine, once |
| **Using it** | You log in and do the work yourself | You ask Claude; an agent does the work there and reports back |
| **From Claude Code** | Claude has to drive a remote shell | Built in: a skill for each of your machines |
| **Your code there** | Whatever state that checkout is in | Code moves with git; agents work in a separate worktree, so your checkout is untouched |
| **Keeping machines up to date** | One at a time | `claude-wingman update`, from any machine |

Works on **macOS, Windows and Linux** (WSL included), in any mix, with two machines or more. Built on [Paseo](https://github.com/getpaseo/paseo) (Apache-2.0), an open-source daemon for coding agents, which claude-wingman installs and locks down for you, and on [Tailscale](https://tailscale.com), a free private network for your devices.

## Quick start

**You need on each machine:**
- [Claude Code](https://code.claude.com/docs/en/setup), signed in;
- [Tailscale](https://tailscale.com/download), signed in with the **same account** everywhere;
- Node.js 20.11+ and git, with git able to push and pull your repos without prompting.

**Then run this on each machine**, in a terminal, in any order:

```sh
npx claude-wingman pair
```

The first time, `pair`:
1. installs the `claude-wingman` command;
2. asks for a short name for this machine (`mac` on macOS, the machine's name elsewhere);
3. installs and secures the daemon, and starts it automatically;
4. finds your other computers on Tailscale (yours only; never shared or tagged devices) and swaps credentials with them over Taildrop, which is end-to-end encrypted;
5. writes a Claude skill for each one and tests the connection.

**Now just ask**, in `claude` on any of them:
- *"Push this branch and run the test suite on msi."*
- *"Run `npm run build` for this repo on the Mac and tell me what fails."*
- *"Check whether the app starts on Linux."*

Run `claude-wingman verify --round-trip` any time to check the whole setup end to end.

> **Run `pair` yourself, in a terminal.** It installs a background service and moves a credential between machines, which Claude Code's safety checks rightly refuse to do on an agent's behalf.

### Linux

Linux needs **systemd** (most distributions; on WSL, set `systemd=true` under `[boot]` in `/etc/wsl.conf`) and two one-time commands that need `sudo`:

```sh
sudo tailscale set --operator=$USER    # lets claude-wingman use Taildrop without root
sudo loginctl enable-linger $USER      # keeps the daemon running when you're logged out (pair tries this itself first)
```

Install Node.js without `sudo` (for example with [nvm](https://github.com/nvm-sh/nvm)), so global npm installs work.

### More than two machines

Run `npx claude-wingman pair` on every machine at about the same time. Each one lists your other computers and pairs with the ones you pick (all, by default). Every machine then has a skill for every other.

**To add a machine later**, run `npx claude-wingman pair` on it, and `claude-wingman pair <new-machine>` on any one machine you already use. That machine then pairs the new one with all your others by itself.

If two machines would get the same name (two Macs both called `mac`), the second one is called by its Tailscale name instead (for example `work-air`). Pick your own with `pair <machine> --name <name>`.

## Manage every machine from one

Once machines are paired, you never need to go back to them. From any of them:

```sh
claude-wingman update                  # install this machine's claude-wingman version on all the others, and apply it
claude-wingman remote --all verify     # run any claude-wingman command on every machine (or name one: remote msi ...)
claude-wingman remote wsl setup --repos ~/code
claude-wingman setup --rotate-password # new password here; every paired machine gets it automatically
```

For a quick check or fix that doesn't need an agent, run a shell command directly, like SSH:

```sh
claude-wingman run msi -- git -C myapp status       # cmd.exe on Windows, sh on macOS and Linux
claude-wingman run wsl --cwd myapp -- npm test      # --cwd: a folder under the repos folder, or a full path
claude-wingman run --all -- node --version          # every paired machine
claude-wingman run msi -- type C:\logs\app.log > app.log   # with one machine, only the output is printed
```

It isn't an interactive terminal: programs that wait for input or need a screen (editors, password prompts) won't work, output appears when the command ends, and the exit code is 0 or 1. Quote the command when it has characters your own shell would interpret (`run msi -- "dir & ver"`). On Windows it behaves as if typed at a `cmd` prompt (so `%NAME%` is expanded before the line runs). `run` is for you: Claude's skills tell it to use agents instead, because a raw command skips the safety checks an agent has.

To upgrade everything: update one machine (`npm install -g claude-wingman@latest`), then run `claude-wingman update` there.

Or just ask Claude, for example *"update wingman on all my machines"* or *"check that wingman is healthy everywhere"*.

These work through the daemon's remote terminals over the same password-protected Tailscale connection, so no agent and no visit is needed. They work whatever the shell on the other machine is (bash, zsh, fish, csh; `cmd.exe` on Windows), and output comes back exactly as printed. A command that runs too long (or that you `cancel`) is stopped there, not left running.

## See and control what's running

From any machine, one view of all of them:

```
$ claude-wingman status
mac (this machine)  1 running
  ▶ 6250908  running          2 minutes ago   msi: run the e2e tests for checkout  ~/src/shop
  ✓ f0918d4  finished         1 hour ago      msi: lint and type-check  ~/src/shop

msi  1 needs permission, 1 paused, 1 remote command
  ▶ 98eefed  remote command                   from wsl: claude-wingman verify
  ? 81d5ced  needs permission 5 minutes ago   mac: build the installer  C:\Users\you\src\app
  ‖ 3b2c1d0  paused           20 minutes ago  mac: profile the slow import  C:\Users\you\src\app

wsl  nothing running
```

```sh
claude-wingman status --watch          # keep it on screen, refreshed every 5 seconds
claude-wingman status msi --all        # one machine, every finished agent too (--json to script it)
claude-wingman logs 6250908 --follow   # what that agent is doing, live
claude-wingman pause 6250908           # interrupt it, keeping its conversation
claude-wingman resume 6250908          # carry on where it left off (or: resume 6250908 "also check Safari")
claude-wingman cancel 81d5ced          # stop it for good (also stops a remote command)
```

The start of an id is enough, and claude-wingman finds the machine it's on. "Finished" means the agent finished its turn, not that the task succeeded: read its report with `logs <id> --tail 1`. Pausing stops whatever the agent was running at that moment (a test run, a build); resuming tells it to continue, so it picks the work up again. Or just ask Claude: *"what's running on my machines?"*, *"pause the agent on msi"*.

## How it works

```
 mac                                                       msi
 claude ── skill "msi" ── claude-wingman dispatch msi ──┐  ┌── dispatch mac ── skill "mac" ── claude
 wingman daemon 100.x:6767 ◀────────────────────────────┼──┘
                                                        └──▶ wingman daemon 100.y:6767
                  Tailscale (WireGuard) between the machines; git push/pull for code
```

1. You ask Claude for something "on msi". The skill tells it to commit and push to a branch, then run `claude-wingman dispatch`.
2. The daemon on msi starts a fresh Claude Code agent. With `--branch`, the agent works in `<repo>-remote-test`, a worktree at `origin/<branch>`, and pushes any fixes back to that branch.
3. `dispatch` waits for the agent and prints its final report, which Claude reads and summarizes for you.

## Using it from a shell

```sh
claude-wingman dispatch msi --repo myapp --branch msi-test/login "run npm test and report failures"
claude-wingman status        # every machine: reachable or not, and what's running there
claude-wingman msi ls        # any paseo command against a machine: ls, logs <id>, send <id> "...", permit ls
```

- **`--repo`:** a folder name under the other machine's repos folder, or a full path there.
- **`--branch`:** needs `--repo`. The agent works in a separate worktree, never on `main`/`master`.
- **`--detach`:** start the agent and return straight away. Check later with `claude-wingman status` and `claude-wingman logs <id>`.
- **`--timeout`:** how long to wait for the report (default 9 minutes).

The exit code says what happened:

| Exit code | Meaning |
|---|---|
| `0` | Done |
| `1` | Error |
| `3` | Waiting for a permission: `claude-wingman <machine> permit ls`, then `permit allow <id>` |
| `4` | Still running: `claude-wingman <machine> wait <id>` |

## Commands

| Command | What it does |
|---|---|
| `pair [<machine>...] [--all] [--as <name>] [--repos <dir>]` | Set this machine up if needed, then pair with your other machines: the ones named, all of them (`--all`), or the ones you pick |
| `dispatch <machine> [--repo] [--branch] [--detach] [--timeout] [--model] [--json] "<task>"` | Run an agent on a paired machine and print its report |
| `<machine> [paseo args]` | Any `paseo` command against a paired machine |
| `status [<machine>...] [--all] [--watch] [--json]` | Every machine: reachable or not, its version, and its agents and remote commands (running, needing permission, paused, finished). `peers` is the same. |
| `logs <id> [--follow] [--tail <n>]` | An agent's activity, wherever it runs |
| `pause <id>` / `resume <id> ["<message>"]` | Interrupt an agent, keeping its conversation / let it carry on |
| `cancel <id>` | Stop an agent, or a remote command, for good |
| `verify [--round-trip]` | Check security and connectivity end to end |
| `doctor` | Check prerequisites |
| `setup [--name] [--repos <dir>] [--rotate-password] [--no-restart]` | Change this machine's settings. Safe to re-run; restarts the daemon only if something changed. |
| `update [<machine>...]` | Install this machine's version on paired machines (all by default) and apply it there |
| `remote <machine>\|--all <command>` | Run a claude-wingman command on other machines and show the output |
| `run <machine>\|--all [--cwd <dir>] [--timeout 10m] -- <command>` | Run any shell command there and print its output, like SSH (for you, not for agents) |
| `skill` | Rewrite the Claude skills (after an update) |
| `restart` | Restart this machine's daemon |
| `unpair <machine>` | Forget a paired machine |
| `uninstall --yes` | Remove everything claude-wingman set up (Paseo stays installed) |

**Options for `pair`:**
- `--as <name>` sets this machine's short name.
- `--repos <dir>` sets where dispatched agents find your repos. Default: the first of `~/src`, `~/code`, `~/projects`, `~/repos`, `~/dev`, `~/git`, `~/ws`, `~/workspace` that exists, otherwise your home folder.
- `--name <name>` sets what this machine calls the other one (with a single machine).

**To update:** install the new version on one machine (`npm install -g claude-wingman@latest`), then run `claude-wingman update` there to bring every other machine to the same version.

## Security

The short version is below; [SECURITY.md](SECURITY.md) has the threat model and how to report a vulnerability.

- **Reachable only over Tailscale.** The daemon binds to this machine's Tailscale address (`100.x.y.z:6767`). Localhost and LAN addresses are refused, and Paseo's relay stays off.
- **Password on every connection.** Each daemon has a random 24-character password that you never see or type. The daemon keeps only a bcrypt hash (mode 600). The plaintext is kept:
  - **macOS:** in the Keychain;
  - **Windows:** in DPAPI-encrypted files that only your Windows user can decrypt;
  - **Linux:** in files readable only by you (mode 600, like SSH keys), under `~/.claude-wingman/secrets`.
- **Safe pairing.** Credentials go only to your own computers on Tailscale, never to shared-in or tagged devices. They travel over Taildrop and are deleted as soon as they're imported. Only a file whose address matches a machine being paired is accepted, and every field is validated first.
- **Safety checks stay on.** Agents run in Claude Code's *auto* permission mode, never `bypassPermissions`. Anything needing admin rights or `sudo` on the other machine can't be done remotely.
- **Pairing means shell access, like an SSH key.** A paired machine can start agents on the other *and* open a terminal there (that's how `update`, `remote` and `run` work), so pair only machines you own. `run` executes your command with your rights and without the safety checks agents have. Native Windows has no sandbox.
- **Credentials between paired machines** (password changes, introductions) go through a single-use, unguessable link on the sender's Tailscale address, which stops working after one download.
- **A record on each machine.** Every machine logs the remote commands it receives, with time and sender, in `~/.claude-wingman/remote-commands.log`.

To change a password: `claude-wingman setup --rotate-password` (or `claude-wingman remote <machine> setup --rotate-password` for another machine). Every paired machine gets the new one automatically.

## Staying reachable

- **Everywhere:** if the daemon's worker crashes, Paseo's supervisor restarts it within seconds.
- **macOS:** launchd starts the daemon at login and restarts it if it exits. `caffeinate` keeps the Mac from idle-sleeping, on power or battery. Closing the lid on battery still sleeps it.
- **Windows:** a logon task starts the daemon and checks every 2 minutes that it's still running, starting it again if not (without opening a window). The machine never sleeps on AC power.
- **Linux:** a systemd user service starts the daemon and restarts it if it exits; with linger enabled it also runs after a reboot before you log in. On **WSL**, a Windows logon task also keeps WSL itself running in the background (WSL otherwise stops when its last window closes, and doesn't start with Windows), and starts it again within 2 minutes if it stops. `systemd-inhibit` blocks idle sleep, and suspend where the system allows it (setup tells you if it doesn't).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `status` shows a machine as unreachable | It's asleep or offline, or Tailscale is down on it. |
| `Incorrect password` | That machine's password changed. Run `claude-wingman pair` on both machines. |
| `pair` times out | The other machine hasn't run `pair` yet. Run it there, then `claude-wingman pair <machine> --receive-only` here. |
| Tailscale IP changed | Run `claude-wingman setup`, then pair again. |
| Linux: Taildrop "access denied" | `sudo tailscale set --operator=$USER` |
| WSL: `node: not found` from `/mnt/c/...` | WSL is using Windows' Node. Install Node inside WSL (`nvm install 22` in a new terminal), so `which npm` shows a Linux path. |
| Linux: "systemd user services aren't available" | Use a distribution with systemd. On WSL, enable it in `/etc/wsl.conf` and run `wsl --shutdown`. |
| Windows PowerShell won't run `claude-wingman` | Use `claude-wingman.cmd`, or allow local scripts. |
| macOS: "Dispatched agents can read …" fails | macOS keeps background processes out of `~/Documents`, `~/Desktop` and `~/Downloads`. Keep repos elsewhere (e.g. `~/src`) or give `node` Full Disk Access (System Settings › Privacy & Security). |
| Switched Node versions (nvm) | Run `npx claude-wingman pair` again (or reinstall), then `claude-wingman setup`. |

Logs: `~/.paseo/daemon.log`; on macOS also `~/.paseo/launchd.log`; on Linux `journalctl --user -u claude-wingman`.

## Development

```sh
git clone https://github.com/dpkay-io/claude-wingman.git && cd claude-wingman
npm install
npm install -g .   # a linked install: your edits apply immediately
npm test           # unit tests (node --test); OS-specific ones skip elsewhere
npm run e2e        # end-to-end, against your real paired machines (CLAUDE_WINGMAN_E2E_AGENTS=1 also starts agents)
npm run check      # release checks: package.json, the published files, no credentials or personal details
npm run docs       # re-embed the sources into SETUP.md (a test fails if it drifts)
```

CI runs the unit tests on Linux, macOS and Windows, the release checks, and a real install of the package, on every push to `main`.

[`SETUP.md`](SETUP.md) is a self-contained runbook for AI agents: the procedure, the steps only a human can do, the verification, and the lessons behind the design, with every source file embedded.

## License

[MIT](LICENSE). claude-wingman is an independent project. It is not affiliated with or endorsed by Anthropic; Claude and Claude Code are Anthropic's products, which claude-wingman runs on your own machines with your own sign-in.
