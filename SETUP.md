# Multi-machine Claude agent dispatch: runbook for AI agents

This runbook is for an AI agent (or a person) setting up **claude-wingman** on two or more machines (macOS, Windows, Linux, in any mix), so that Claude Code on any of them can dispatch Claude Code agents to the others. It is self-contained. The whole CLI is embedded verbatim in the appendix, so it works without the original repository or any earlier conversation.

It was built and verified end to end on 2026-10-16 between macOS 27.0.1 (Apple silicon, Node 24) and Windows 11 Home 22631 (Node 20, PowerShell 5.1), with Claude Code 2.1.301, Paseo 0.11.4 and Tailscale 1.104.1. Linux support and pairing with several machines were added on 2026-10-17; see section 7 for what has been tested there. Mac↔Mac and Windows↔Windows haven't been tried.

`README.md` (appendix) is the user guide. This file adds the procedure, the human-only steps, the verification, and the lessons behind the design.

---

## 1. Requirements this setup meets

1. **Dispatch in every direction.** Each machine can start a Claude Code agent on any machine it's paired with. That agent works on the other machine's files and toolchain and reports back.
2. **Plain-language use from the normal `claude` CLI**, through one generated skill per paired machine.
3. **Code moves via git.** Remote work happens in a sibling worktree (`<repo>-remote-test`), so the user's checkout is never touched.
4. **Any network.** Machines connect over Tailscale, with no open ports.
5. **Secure:**
   - The daemon listens only on the Tailscale IP, with a strong random password and the relay off.
   - Passwords live in the Keychain or DPAPI.
   - Agents run in *auto* mode, never `bypassPermissions`.
6. **Stays reachable:**
   - Autostart at login.
   - The Mac doesn't idle-sleep on AC power or battery; closing the lid on battery still sleeps it, and that's accepted.
   - Windows never sleeps on AC power.
   - Linux: a systemd user service with linger, and `systemd-inhibit` against idle sleep (and suspend, where polkit allows it).
7. **One command per machine, once:** `npx claude-wingman pair` installs, sets up and pairs. After that, any machine manages the others (`update`, `remote`, password changes, adding machines) with no visits.

## 2. How it works

```
 Machine A (e.g. mac)                                  Machine B (e.g. msi)
 claude + skill "msi" ─ claude-wingman dispatch msi ─┐   ┌─ claude-wingman dispatch mac ─ claude + skill "mac"
 Paseo daemon 100.x:6767 (password) ◀──────────────┼───┘
                                                   └──▶ Paseo daemon 100.y:6767 (password)
                            Tailscale (WireGuard); git push/pull for code
```

- **Paseo** (`@getpaseo/cli`, Apache-2.0) is a daemon that launches Claude Code agents on its own machine and exposes them over WebSocket on TCP 6767. claude-wingman installs and configures it.
- **Tailscale** gives each machine a stable `100.x` address from any network. Taildrop carries the pairing files.
- **claude-wingman** handles `setup`, `pair`, `dispatch` and `verify`, plus the generated skill. Its configuration is in `~/.claude-wingman/config.json`; passwords go in the Keychain (service `claude-wingman`) or `~/.claude-wingman/secrets/*.dpapi`.

## 3. Steps only a human can do

An agent must ask the user for these and must not work around them:

1. **Sign-ins:** Tailscale (same account on both machines), Claude Code `/login`, and git credentials for the repos (Git Credential Manager or `gh auth login`).
2. **Running `npx claude-wingman pair` (and `setup`) in a terminal.** Claude Code's auto-mode classifier blocks agents from running them:
   - setup installs a background service ("Unauthorized Persistence"); `pair` runs setup on a new machine;
   - pairing moves a credential to another host ("Credential Leakage").
   An allow rule did not lift the setup block in testing.
3. **Admin or sudo actions:** Windows UAC prompts (e.g. the optional firewall rule, machine-wide installers), macOS `sudo` (e.g. `sudo pmset -c sleep 0`), and on Linux installing Tailscale, `sudo tailscale up`, `sudo tailscale set --operator=$USER` and, if `pair` couldn't do it itself, `sudo loginctl enable-linger $USER`. Remote agents can't approve these.
4. **Deleting user files** outside the CLI's own cleanup. The classifier flags this as "Irreversible Local Destruction".
5. **macOS Tailscale install** from the standalone `.pkg`. The installer GUI asks for the Mac password.

## 4. Procedure

Do these steps on each machine unless the step says otherwise.

1. **Prerequisites.** Install:
   - Node.js 20.11+ and git (macOS: `xcode-select --install`; Windows: `winget install --id Git.Git -e`; Linux: the package manager for git, and Node via nvm so global npm installs need no `sudo`).
   - Claude Code (https://code.claude.com/docs/en/setup), signed in.
   - Tailscale, signed in with the same account on every machine.
     - **macOS:** verify the `.pkg` before installing: `shasum -a 256` matches `<pkg-url>.sha256`; `pkgutil --check-signature` shows `Developer ID Installer: Tailscale Inc. (W5364U7YZB)`; `spctl --assess --type install` reports `accepted`.
     - **Windows:** `winget install --id Tailscale.Tailscale -e`.
     - **Linux:** `curl -fsSL https://tailscale.com/install.sh | sh`, `sudo tailscale up`, then `sudo tailscale set --operator=$USER` (Taildrop needs it). systemd must be running (WSL: `[boot]` `systemd=true` in `/etc/wsl.conf`, then `wsl --shutdown`).
2. **Pair (human, in a terminal, on every machine, any order):** `npx claude-wingman pair`. Without network access to either, recreate every file from the appendix into a folder, keeping the paths, run `npm install -g .` there, then `claude-wingman pair`.
   - **Install:** run through npx, it first installs itself globally (the skills call `claude-wingman`), by packing the copy it runs from.
   - **First run:** on a machine that isn't set up, it runs setup first. It asks for a short name, defaulting to `mac` on macOS and the cleaned Tailscale name elsewhere; with no terminal, it uses the default. Pass `--as <name>` to skip the question, and `--repos <dir>` to set the repos folder (default: the first existing of `~/src`, `~/code`, `~/projects`, `~/repos`, `~/dev`, `~/git`, `~/ws`, `~/workspace`, else home).
   - **Choosing machines:** candidates are online macOS, Windows and Linux machines owned by the same Tailscale user (never shared-in or tagged ones). One candidate is picked automatically; with several, it offers a list (default: all). `--all` skips the list; `pair <machine>...` names them (Tailscale name or IP).
   - **Names:** a paired machine keeps its own name unless that is taken here; then it gets its Tailscale name, then the name plus a number. `--name` (single machine) overrides. Re-pairing keeps the existing name.
   - **Re-runs:** `claude-wingman setup` is idempotent. It keeps the stored daemon password (generating one the first time) and restarts the daemon only when something changed.
3. **Run `claude-wingman doctor`** if anything fails; every item should pass.
4. **Verify (an agent may run this):** `claude-wingman verify --round-trip` on every machine. Expect `All checks passed`: 12 checks for the machine itself, plus 4 per paired machine (3 without `--round-trip`).
5. **From then on, manage from any machine:** `claude-wingman update` (push this machine's version to all others), `claude-wingman remote <machine>|--all <command>` (e.g. `remote --all verify`), `setup --rotate-password` (re-shared automatically). To add a machine: `npx claude-wingman pair` on it, and `claude-wingman pair <it>` on one existing machine; that one pairs it with the rest.
6. **Try it:** in `claude` on any machine, ask e.g. "run this repo's tests on <peer> using branch <branch>".

## 5. Verification reference

`claude-wingman verify` checks the following; see `src/commands/verify.js`.
- **Binding:**
  - the Tailscale IP hasn't changed since setup;
  - the daemon listens only on `100.x:6767`, and `localhost:6767` is refused;
  - the relay is off.
- **Auth:**
  - the stored password matches the daemon's bcrypt hash;
  - a client **without local credentials** (an isolated home folder) gets "Password required" with no password and "Incorrect password" with a wrong one, and the right password is accepted.
- **Services:** autostart is installed and running, and keep-awake is active.
- **Each peer:** reachable, password accepted, generated skill installed, and with `--round-trip` a real agent replies `CLAUDE_WINGMAN_OK`.

A manual end-to-end check, beyond `verify`:
1. Push a branch.
2. Run `claude-wingman dispatch <peer> --repo <repo> --branch <branch> "run npm test and report totals"`. Expect exit 0 and a report naming the `<repo>-remote-test` worktree and the commit.
3. Confirm the user's checkout on the peer is still on its original branch and clean.
4. Repeat from the other machine by asking in plain language.

## 6. Lessons behind the design

Each of these was hit during the build; the code handles all of them. Keep them in mind when changing it.

1. **Paseo ignores the user's default permission mode** and starts agents in `default` (Always Ask), so they stall on every command. claude-wingman always passes `--mode auto`.
2. **Agents spawned by a Paseo daemon inherit `PASEO_HOME`**, and paseo refuses to combine it with `PASEO_HOST`. Every client call removes `PASEO_HOME`.
3. **Setting the password:** `paseo daemon set-password` needs a TTY, and `config set daemon.auth.password` is refused. claude-wingman writes the bcrypt hash into `config.json` directly. `writeFileSync`'s mode only applies to new files, so it `chmod 600`s the config and its backup.
4. **The daemon reads its password only at startup.** A changed hash takes effect on restart, so an old password keeps working until then. That is what makes in-place rotation safe.
5. **A same-machine CLI skips the password** using a local credential file in `~/.paseo`. Test auth from an isolated home folder, as `verify` does.
6. **Restarting a daemon from one of its own agents kills that agent mid-restart.** On Windows that could leave the daemon stopped. Restarts from inside an agent therefore go through Task Scheduler (Windows) or a detached, delayed `launchctl` (macOS); see `--no-restart` and `restart`.
7. **`launchctl bootout` returns before the service has unloaded**, and an immediate `bootstrap` fails with "5: Input/output error". claude-wingman waits for the unload and retries.
8. **PowerShell 5.1 started from PowerShell 7** inherits PS7's `PSModulePath` and fails to load `Microsoft.PowerShell.Security`, which breaks `ConvertTo-SecureString`/DPAPI. claude-wingman drops `PSModulePath` for its child processes.
9. **On Windows, `.cmd` shims mangle prompts that contain quotes or `&`.** claude-wingman runs Paseo's JavaScript entry point directly with `node`.
10. **Taildrop delivers to `~/Downloads` on both macOS and Windows**, not the `tailscale file get` inbox. Pairing searches both, accepts only a bundle whose address matches the named machine, takes the newest, and deletes the files.
11. **`security -i` exits 0 even when a command fails.** Keychain writes are checked by reading the value back. The password goes through stdin, never argv.
12. **Remote agents switched the user's branch** when told to `git checkout`. Dispatch with `--branch` uses a sibling worktree, and fixes are pushed with `HEAD:<branch>`.
13. **An agent told it was dispatched *from* machine X won't send work back to X**, to avoid loops. That's sensible; a user typing on the machine directly isn't affected.
14. **About 1 GB of speech models** (Parakeet, Kokoro, from `github.com/k2-fsa/sherpa-onnx` releases) download on the first daemon start, for Paseo's voice feature. They're harmless and can be deleted from `~/.paseo/models`.
15. **npm 12 blocks dependency install scripts.** Paseo needs `--allow-scripts=esbuild,node-pty,msgpackr-extract`.
16. **On Windows, git with `core.autocrlf=true`** showed files as modified. `.gitattributes` forces LF.
17. **Windows nvm keeps global npm packages per Node version.** Switching Node hides `paseo` and `claude-wingman`, so re-run `npm install -g .` and `claude-wingman setup`. macOS bakes the `node` and `claude` paths into its LaunchAgent, so re-run `setup` after changing Node there too.
18. **npm 12 refuses git installs** (`allow-git` defaults to `none`). Installing from GitHub needs `--allow-git=all` on that one command.
19. **Pick an npm name nobody else uses**, including variants without hyphens: npm refuses names that only differ by punctuation, and `npm update -g` matches installed packages to the registry by name. (This tool was first called claude-peers, a name already taken by an unrelated package.)
20. **npm masks UUID-like path segments as `***`** in its output, including `npm root -g`, and refuses `npm config get prefix`. When the answer is masked, claude-wingman falls back to npm's default global folder (or `npm_config_prefix`).
21. **On Linux, Taildrop needs the user to be Tailscale's operator** (`sudo tailscale set --operator=$USER`); otherwise `tailscale file cp/get` is refused.
22. **Linux user services stop at logout and don't start at boot without linger.** `loginctl enable-linger` is tried with `--no-ask-password`, so it can never hang on a polkit prompt; if it's refused, setup prints the `sudo` command.
23. **On Linux, a dispatched agent lives in the daemon's cgroup**, so a restart started from it would be killed with the daemon. Restarts from inside an agent go through a transient `systemd-run --user` timer instead.
24. **`tailscale status` lists shared-in and tagged devices too.** Pairing only offers machines with the same `UserID` as this one and without `ShareeNode`, so credentials never go to someone else's device.
25. **polkit often lets a user service block idle but not sleep** (`systemd-inhibit --what=idle:sleep` fails with "Access denied" on WSL's Ubuntu 24.04, while `--what=idle` works). Setup probes through `systemd-run --user`, where the service will run, and takes the strongest lock allowed, or none with a warning.
26. **Paseo daemons expose terminals** (`paseo terminal create/send-keys/capture`) to any client with the password. claude-wingman uses them for `remote`, `update`, introductions and password re-sharing, so no Claude agent (and no auto-mode classifier) is involved. Pass `--cwd` (the default is the *client's* working directory). Windows terminals are `cmd.exe`, others the user's shell. A command's result is read from begin/end marker lines. The terminals are 80×24 with 1,024 lines of scrollback, can't be resized from the CLI, and `capture` returns screen rows without saying which were wrapped. So the command's output goes to a temporary file that is printed in base64 lines of exactly 64 characters, and is decoded on the other side; if the start scrolls away, the rest still decodes, since every line is a whole number of base64 groups (about the last 45 KB survive).
   - **macOS/Linux:** the user's shell may be bash, zsh, fish or csh, so only `echo <script in base64> | base64 --decode | sh` is typed, which all of them parse (tested with fish 4.9 as the interactive shell, and tcsh, csh, ksh, dash). The script runs in sh: `trap` removes the temporary file when the terminal is killed. GNU `base64` wraps at 76 characters, so it's piped through `tr -d '\n' | fold -w 64`.
   - **Windows (cmd.exe):** the markers are typed with `^` so that cmd's echo of the line differs from what it prints, and `%ERRORLEVEL%` is expanded when cmd parses the line, so success is reported with `&& … || …`. `certutil -encode` refuses empty files (an empty line is appended) and frames its output with `-----BEGIN/END CERTIFICATE-----` lines, which the parser skips. A killed cmd can't clean up, so after a timeout or cancel a second terminal deletes the file, and every run sweeps leftovers older than a day.
   - Killing a terminal stops what runs in it (verified on Linux and Windows); a capture of a killed terminal fails with "No terminal found matching", which is how the waiting side learns of a `cancel`. A failed capture for any other reason is retried for 30 s (a Wi-Fi blip once lost one), and terminals are named `wingman-<nonce>: <what>` so `status` can show and `cancel` can stop them. Never put a secret in that name; credential hand-overs are named "pairing".
   - The command itself runs in a child, `cmd /d /s /c "<command>"`: the typed line wraps it in parentheses and a redirect, so an unquoted `)` (even in `echo (x)`) closed them early and `rem` or `::` commented out the end marker, and claude-wingman waited until the timeout. Every `& | < > ( ) ^` the outer parse sees outside quotes gets a caret, which that parse removes; `/s` gives the child the original text. Line breaks and odd quotes are refused. If `cmd` ever shows `More?` (an unfinished line), the command fails at once.
27. **On macOS, processes under the daemon (launchd) may not read `~/Downloads`, `~/Documents` or `~/Desktop`** ("Operation not permitted"). Taildrop saves to Downloads, so remote steps never use Taildrop: credentials go through a single-use URL instead. Dispatched agents can't work on repos in those folders either; `verify` checks the repos folder through the daemon.
28. **A restart scheduled from a remote terminal fires on a timer**, so anything slow (like re-sharing a new password) must finish before the restart is scheduled, not after.
29. **Paseo has no pause.** `paseo stop <id>` interrupts an agent: the tool it was running is killed (verified: the `ping` it ran disappeared on Linux and Windows), the agent goes idle and keeps its conversation, and `paseo send <id> "<message>"` makes it carry on. Idle agents all look the same to Paseo, so `pause` and `cancel` record their meaning in a label (`paseo agent update <id> --label wingman-state=paused|cancelled`, read back with `paseo ls -g --label …`); `resume` clears it. A waiting permission shows only in `paseo permit ls`, which gives the agent's id.
30. **Crash recovery, measured with `kill -9` / `taskkill /f` (2026-10-17).** Paseo runs a supervisor and a worker. A killed worker is restarted by the supervisor: macOS 3 s, Linux 5 s, Windows 11 s. A killed supervisor: launchd restarts it in 3 s (KeepAlive), systemd in 18 s (`RestartSec=15`). On Windows, `paseo daemon start` launches the supervisor and exits, so Task Scheduler had nothing to restart and the daemon stayed down; the task now also runs every 2 minutes (`daemon start` is a no-op when it's up: "Already running", exit 0), which brought it back in 114 s. Use a separate `-Once` trigger with a repetition interval: a repetition on the logon trigger only starts at the next logon.
31. **Task Scheduler opens a console window (on Windows 11, a Windows Terminal tab) for a console program** such as `node.exe`. Running it as `conhost.exe --headless <program>` gives it a console with no window: a test task started a new OpenConsole process when run plainly and none when run headless, and 2½ minutes of sampling across watchdog runs saw no new window.
32. **npm 12 refuses tarball URLs** ("EALLOWREMOTE … Fetching packages of type remote have been disabled"), so `update` passes `--allow-remote=all`; npm 11 has it on by default and npm 10 ignores the unknown option.
33. **A failed task can look finished.** With a model that doesn't exist, Claude Code replies with an error message and the agent goes `idle`, like a success; Paseo's `error` state means the agent's process died (e.g. killed). So `status` says "finished", not "done", and the report or `logs` tells which.
34. **WSL runs a distribution only while a Windows process uses it**, and nothing starts it with Windows. On WSL, setup registers (through interop, `powershell.exe -EncodedCommand`) a Windows logon task, `claude-wingman wsl <distro>`, that runs `conhost --headless wsl.exe -d <distro> --exec /bin/sleep infinity`, plus a 2-minute trigger with `-MultipleInstances IgnoreNew` that restarts it if it ended (measured: killed, back within 2 minutes). Under the daemon `WSL_DISTRO_NAME` isn't set; `wslpath -w /` gives `\\wsl.localhost\<distro>\`. `uninstall` removes the task.
35. **Testing from a remote terminal into WSL** (`wsl.exe -d <distro> --exec bash -lic "..."` from the Windows side) needs a login shell (`-l`): `~/.local/bin`, where `claude` lives, is added by `~/.profile`.
36. **Claude Code refuses a foreground `sleep`** in an agent's shell and moves it to the background, so a test agent that must stay busy should run something like `ping -c 60 127.0.0.1` instead.

37. **`run` is the raw-command escape hatch, on purpose for the user only.** It reuses the remote-terminal plumbing (exact output, timeout, cancel, any shell), runs `cmd.exe` on Windows and `sh` elsewhere, and the skills tell Claude not to use it: a raw command skips the safety checks a dispatched agent has. Output is trimmed only at the end, so piping a file through it is byte-exact (verified with SHA-256); stdin is empty, so a command waiting for input ends instead of hanging.

38. **On Windows, closing a terminal doesn't stop a command chain.** With `ping … & echo x> file`, closing the terminal killed `ping`, but the child `cmd.exe` still ran the `echo` (3 of 3 times), so on a timeout or `cancel` the rest of a chain could run. Each Windows command's child carries `WINGMAN_RUN=<id>` in its environment; a second terminal finds it (`Get-CimInstance Win32_Process`) and runs `taskkill /f /t` from its parent, the terminal's own `cmd.exe`, before the terminal is closed. Killing only the child let the outer `cmd` print a failure marker, so the waiting side saw "finished" instead of "cancelled". On macOS and Linux, `sh` exits on the hang-up, so a chain stops there by itself.

## 7. Known gaps

Tested on 2026-10-17 with three machines (macOS, Windows 11, Ubuntu 24.04 on WSL2): three-way pairing (`pair --all`), the npx self-install, `update` from the Mac to Windows and Linux, `remote --all verify`, password rotation started remotely on Linux and on Windows (re-shared automatically), and introducing a machine to an existing one. Not tested:
- Linux outside WSL (a desktop distribution with a real suspend), and Mac↔Mac or Windows↔Windows.
- `npx claude-wingman` from the npm registry (not published yet; tested from a tarball and from GitHub).

- Reboot persistence (the logon task and LaunchAgent) is configured but was **not tested by rebooting**.
- Closing the lid while on AC power is untested.
- Tested 2026-10-17 as well: a first-time `npx … pair` on a wiped Linux (WSL) machine plus `pair <it>` on the Mac, which paired it with Windows too; `update` started from Linux and from Windows (and onto a Mac with npm 12); `--branch` dispatch on Linux; plain-language requests ("what's running…", "pause…", "update wingman on all my machines"); daemon crash recovery on all three. Not tested: a WSL or Windows reboot.
- `status`, `pause`, `resume`, `cancel` and `logs` were tested from the Mac against agents on Windows and Linux, and with Windows and Linux as the client; "needs permission" was seen only on the Mac's own daemon (agents run in auto mode, so it is rare).

## Appendix: all files (verbatim)

<!-- BEGIN FILE: README.md -->
**`README.md`**

````markdown
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
````
<!-- END FILE -->

<!-- BEGIN FILE: package.json -->
**`package.json`**

````json
{
  "name": "claude-wingman",
  "version": "1.0.0",
  "description": "Use all your computers from one Claude Code session: hand work to Claude agents on your other Mac, Windows or Linux machines, over Tailscale. No SSH, one command to set up.",
  "author": "dpkay <hello@dpkay.com>",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/dpkay-io/claude-wingman.git"
  },
  "homepage": "https://github.com/dpkay-io/claude-wingman#readme",
  "bugs": {
    "url": "https://github.com/dpkay-io/claude-wingman/issues"
  },
  "keywords": [
    "claude",
    "claude-code",
    "claude-cli",
    "ai-agents",
    "agents",
    "remote",
    "multi-machine",
    "cross-platform",
    "tailscale",
    "paseo",
    "dispatch",
    "windows",
    "macos",
    "linux",
    "wsl",
    "developer-experience",
    "productivity",
    "remote-development",
    "ssh-alternative",
    "cross-platform-testing"
  ],
  "type": "module",
  "bin": {
    "claude-wingman": "bin/claude-wingman.js"
  },
  "files": [
    "bin/claude-wingman.js",
    "src"
  ],
  "engines": {
    "node": ">=20.11"
  },
  "scripts": {
    "test": "node --test",
    "e2e": "node --test --test-concurrency=1 e2e/remote.e2e.js",
    "check": "node tools/check-release.js",
    "docs": "node tools/build-setup-doc.js"
  },
  "dependencies": {
    "bcryptjs": "^3.0.3"
  }
}
````
<!-- END FILE -->

<!-- BEGIN FILE: .gitignore -->
**`.gitignore`**

````
.DS_Store
node_modules/
*.tgz
.env*
````
<!-- END FILE -->

<!-- BEGIN FILE: .gitattributes -->
**`.gitattributes`**

````
* text=auto eol=lf
````
<!-- END FILE -->

<!-- BEGIN FILE: bin/claude-wingman.js -->
**`bin/claude-wingman.js`**

````js
#!/usr/bin/env node
import { main } from '../src/cli.js';

process.exitCode = await main(process.argv.slice(2));
````
<!-- END FILE -->

<!-- BEGIN FILE: src/cli.js -->
**`src/cli.js`**

````js
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
````
<!-- END FILE -->

<!-- BEGIN FILE: src/args.js -->
**`src/args.js`**

````js
// Minimal argument parser: --flag, --flag value, --flag=value, -- (end of options).
import { CliError } from './util.js';

/**
 * @param {string[]} argv
 * @param {Record<string, 'string'|'boolean'>} spec  allowed flags and their types
 * @returns {{ opts: Record<string, string|boolean>, positionals: string[] }}
 */
export function parseArgs(argv, spec = {}) {
  const opts = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--') || arg === '-') {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const type = spec[name];
    if (!type) throw new CliError(`Unknown option --${name}.`, { hint: 'Run: claude-wingman help' });
    if (type === 'boolean') {
      if (eq !== -1) throw new CliError(`--${name} doesn't take a value.`);
      opts[name] = true;
    } else {
      const value = eq !== -1 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined || value === '') throw new CliError(`--${name} needs a value.`);
      opts[name] = value;
    }
  }
  return { opts, positionals };
}
````
<!-- END FILE -->

<!-- BEGIN FILE: src/util.js -->
**`src/util.js`**

````js
// Small shared helpers: running commands, console output, errors.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

/** This claude-wingman's version. */
export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export const IS_WINDOWS = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';
export const IS_LINUX = process.platform === 'linux';
export const SUPPORTED_OSES = ['darwin', 'win32', 'linux'];

/** "macOS", "Windows" or "Linux" for a process.platform value. */
export const osLabel = (platform) => ({ darwin: 'macOS', win32: 'Windows', linux: 'Linux' })[platform] ?? platform;

/** An error meant for the user: printed without a stack trace, with an optional fix hint. */
export class CliError extends Error {
  constructor(message, { hint, exitCode = 1 } = {}) {
    super(message);
    this.hint = hint;
    this.exitCode = exitCode;
  }
}

/** Run a command synchronously and capture its output. Never throws for a non-zero exit. */
export function run(cmd, args = [], { env, input, cwd, timeoutMs = 120_000, shell = false } = {}) {
  const res = spawnSync(cmd, args, {
    env: env ?? process.env,
    input,
    cwd,
    shell,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  return {
    code: res.status ?? (res.error ? 127 : 1),
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
    error: res.error,
  };
}

/** Run a PowerShell script (Windows). Secrets should be passed through `env`, never inside the script. */
export function runPowerShell(script, { env, timeoutMs } = {}) {
  const childEnv = { ...process.env, ...env };
  // When launched from PowerShell 7 (e.g. Claude Code's PowerShell tool), PSModulePath points at PS7 modules,
  // which Windows PowerShell 5.1 can't load ("module could not be loaded"). Let 5.1 build its own default.
  delete childEnv.PSModulePath;
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    env: childEnv,
    timeoutMs,
  });
}

/** Absolute path of an executable on PATH, or null. */
export function which(name) {
  const res = IS_WINDOWS ? run('where.exe', [name]) : run('/usr/bin/which', [name]);
  return res.code === 0 ? res.stdout.split(/\r?\n/)[0].trim() : null;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Quote a string for a PowerShell single-quoted literal. */
export const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** Escape text for an XML element (launchd plists). */
export const xmlEscape = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Node 20.11+ (needed for --disable-warning, which Paseo is started with). */
export function nodeIsSupported(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  return major > 20 || (major === 20 && minor >= 11);
}

/** WSL puts Windows folders on PATH, so `npm` or `claude` there can be the Windows one, which can't serve Linux. */
export const isWindowsToolOnWsl = (p) => IS_LINUX && /^\/mnt\/[a-z]\//i.test(p ?? '');

/**
 * True when this process runs under the Paseo daemon: in an agent it started, or in a remote terminal
 * (claude-wingman remote/update). Restarting the daemon from here must be deferred, or it kills this process.
 */
export const insidePaseoAgent = () => Boolean(process.env.PASEO_HOME || process.env.PASEO_AGENT_ID || process.env.CLAUDE_WINGMAN_REMOTE);

// ---- console output ---------------------------------------------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
export const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
// Windows PowerShell 5.1 consoles often can't render check marks, so use ASCII there.
const marks = IS_WINDOWS ? { ok: '[ok]', fail: '[x]', warn: '[!]', info: '[-]' } : { ok: '✓', fail: '✗', warn: '!', info: '·' };

export const ui = {
  ok: (msg) => console.log(`${paint(32, marks.ok)} ${msg}`),
  fail: (msg) => console.log(`${paint(31, marks.fail)} ${msg}`),
  warn: (msg) => console.log(`${paint(33, marks.warn)} ${msg}`),
  info: (msg) => console.log(`${paint(2, marks.info)} ${msg}`),
  step: (msg) => console.log(`\n${paint(1, msg)}`),
  hint: (msg) => console.log(`  ${paint(2, msg)}`),
  dim: (s) => paint(2, s),
  bold: (s) => paint(1, s),
};

export const homeDir = () => os.homedir();
````
<!-- END FILE -->

<!-- BEGIN FILE: src/prompt.js -->
**`src/prompt.js`**

````js
// Interactive questions, with safe defaults when there is no terminal (e.g. inside an agent).
import readline from 'node:readline/promises';
import { CliError } from './util.js';

// CLAUDE_WINGMAN_NONINTERACTIVE is set for commands run on another machine through a remote terminal (a TTY).
export const interactive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.CLAUDE_WINGMAN_NONINTERACTIVE);

/** Ask a question; returns `def` when the answer is empty or there's no terminal. Re-asks while `validate` throws. */
export async function ask(question, def, validate = (v) => v) {
  if (!interactive()) return validate(def);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await rl.question(`${question} [${def}]: `)).trim() || def;
      try {
        return validate(answer);
      } catch (err) {
        if (!(err instanceof CliError)) throw err;
        console.log(`  ${err.message}${err.hint ? ` ${err.hint}` : ''}`);
      }
    }
  } finally {
    rl.close();
  }
}

/** Parse "all", "2" or "1,3" (spaces also work) into 0-based indexes of `count` items. */
export function parseSelection(answer, count) {
  const text = String(answer).trim().toLowerCase();
  if (text === 'all' || text === 'a') return [...Array(count).keys()];
  const picks = text.split(/[\s,]+/).filter(Boolean).map(Number);
  if (!picks.length || picks.some((n) => !Number.isInteger(n) || n < 1 || n > count)) {
    throw new CliError(`Enter "all", or numbers from 1 to ${count} separated by commas.`);
  }
  return [...new Set(picks)].map((n) => n - 1);
}

/** Pick some of `items` (default: all). Throws (with the list) when there's no terminal. */
export async function chooseMany(question, items, label, { hint } = {}) {
  if (!interactive()) {
    throw new CliError(`Several machines are online: ${items.map(label).join(', ')}.`, { hint });
  }
  items.forEach((item, i) => console.log(`  ${i + 1}) ${label(item)}`));
  const picks = await ask(`${question} Numbers like 1,3, or "all"`, 'all', (v) => parseSelection(v, items.length));
  return picks.map((i) => items[i]);
}
````
<!-- END FILE -->

<!-- BEGIN FILE: src/config.js -->
**`src/config.js`**

````js
// claude-wingman configuration: this machine's identity and its paired peers.
// Stored as JSON in ~/.claude-wingman/config.json. Passwords are never stored here (see secrets.js).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CliError } from './util.js';

export const DEFAULT_PORT = 6767;
export const COMMANDS = new Set([
  'help', 'version', 'doctor', 'setup', 'pair', 'unpair', 'peers', 'status', 'dispatch',
  'verify', 'skill', 'restart', 'uninstall', 'remote', 'update', 'cancel', 'pause', 'resume', 'logs', 'run',
]);

export const configDir = () => process.env.CLAUDE_WINGMAN_HOME || path.join(os.homedir(), '.claude-wingman');
export const configPath = () => path.join(configDir(), 'config.json');

/** Peer and machine names become skill names, file names and CLI words, so keep them simple. */
export function validateName(name, what = 'name') {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(name ?? '')) {
    throw new CliError(`Invalid ${what} "${name}".`, {
      hint: 'Use 1-31 lowercase letters, digits or hyphens, starting with a letter (e.g. "mac", "msi", "work-pc").',
    });
  }
  if (COMMANDS.has(name)) {
    throw new CliError(`"${name}" is a claude-wingman command and can't be used as a ${what}.`);
  }
  return name;
}

/** A valid name made from free text such as a Tailscale machine name ("Work PC" -> "work-pc"), or null. */
export function toName(text) {
  const cleaned = String(text ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+|-+$/g, '').slice(0, 31).replace(/-+$/, '');
  try {
    return validateName(cleaned);
  } catch {
    return null;
  }
}

export function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    cfg.peers ??= {};
    return cfg;
  } catch (err) {
    if (err.code === 'ENOENT') return { version: 1, self: null, peers: {} };
    throw new CliError(`Can't read ${configPath()}: ${err.message}`);
  }
}

export function saveConfig(cfg) {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const tmp = `${configPath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, configPath());
}

/** Load config and require that `claude-wingman setup` has run. */
export function requireSelf() {
  const cfg = loadConfig();
  if (!cfg.self) throw new CliError('This machine is not set up yet.', { hint: 'Run: claude-wingman setup' });
  return cfg;
}

export function requirePeer(cfg, name) {
  const peer = Object.hasOwn(cfg.peers, name) ? cfg.peers[name] : undefined;
  if (!peer) {
    const known = Object.keys(cfg.peers);
    throw new CliError(`Unknown peer "${name}".`, {
      hint: known.length ? `Paired peers: ${known.join(', ')}` : 'No peers yet. Pair one with: claude-wingman pair <machine>',
    });
  }
  return peer;
}
````
<!-- END FILE -->

<!-- BEGIN FILE: src/secrets.js -->
**`src/secrets.js`**

````js
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
````
<!-- END FILE -->

<!-- BEGIN FILE: src/tailscale.js -->
**`src/tailscale.js`**

````js
// Tailscale: find the CLI, read status, resolve machines, and move files with Taildrop.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliError, IS_LINUX, IS_MAC, IS_WINDOWS, run, runPowerShell, which } from './util.js';

const CANDIDATES = IS_MAC
  ? ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale']
  : IS_WINDOWS
    ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe')]
    : ['/usr/bin/tailscale', '/usr/local/bin/tailscale'];

export function tailscaleBin({ required = true } = {}) {
  const found = CANDIDATES.find((p) => fs.existsSync(p)) ?? which('tailscale');
  if (!found && required) {
    throw new CliError('Tailscale is not installed.', {
      hint: IS_WINDOWS
        ? 'Install it: winget install --id Tailscale.Tailscale -e   (then sign in with the same account on every machine)'
        : IS_LINUX
          ? 'Install it: curl -fsSL https://tailscale.com/install.sh | sh   then: sudo tailscale up && sudo tailscale set --operator=$USER'
          : 'Install it from https://tailscale.com/download (on macOS, the standalone .pkg), then sign in.',
    });
  }
  return found;
}

/** Short machine name from a MagicDNS name: "msi.tail1234.ts.net." -> "msi". */
const shortName = (dnsName) => (dnsName || '').split('.')[0].toLowerCase();

const toMachine = (node) => ({
  name: shortName(node.DNSName) || node.HostName,
  displayName: node.HostName,
  ip: (node.TailscaleIPs || []).find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip)),
  os: node.OS,
  online: node.Online !== false,
  userId: node.UserID,
  // Shared into this tailnet from someone else's: never a pairing candidate.
  shared: Boolean(node.ShareeNode),
});

// On Linux, tailscaled runs as root; Taildrop needs this user to be its "operator".
const operatorHint = () => (IS_LINUX ? { hint: 'Allow Taildrop for your user once: sudo tailscale set --operator=$USER' } : {});
const permissionDenied = (text) => /access denied|permission denied|operator|must be root|requires root/i.test(text);

export function status() {
  const res = run(tailscaleBin(), ['status', '--json']);
  if (res.code !== 0) throw new CliError(`tailscale status failed: ${res.stderr || res.stdout}`);
  const data = JSON.parse(res.stdout);
  if (data.BackendState !== 'Running') {
    throw new CliError(`Tailscale is not connected (state: ${data.BackendState}).`, { hint: 'Open Tailscale and sign in, or run: tailscale up' });
  }
  return { self: toMachine(data.Self), peers: Object.values(data.Peer || {}).map(toMachine) };
}

/** Find a tailnet machine by short name, display name or IPv4 address. */
export function resolveMachine(query) {
  const { peers } = status();
  const q = String(query).toLowerCase();
  const match = peers.find((m) => m.ip === query || m.name === q || m.displayName.toLowerCase() === q);
  if (!match) {
    throw new CliError(`No machine "${query}" on your tailnet.`, {
      hint: `Machines: ${peers.map((m) => `${m.name} (${m.ip}${m.online ? '' : ', offline'})`).join(', ') || 'none'}`,
    });
  }
  return match;
}

/** CGNAT range 100.64.0.0/10, which Tailscale assigns from. */
export const isTailscaleIp = (ip) => {
  const m = /^100\.(\d+)\.(\d+)\.(\d+)$/.exec(ip ?? '');
  return Boolean(m) && Number(m[1]) >= 64 && Number(m[1]) <= 127 && [m[2], m[3]].every((n) => Number(n) <= 255);
};

export function sendFile(file, machineName) {
  const res = run(tailscaleBin(), ['file', 'cp', file, `${machineName}:`], { timeoutMs: 120_000 });
  if (res.code !== 0) {
    const text = res.stderr || res.stdout;
    throw new CliError(`Taildrop send to ${machineName} failed: ${text}`, permissionDenied(text) ? operatorHint() : {});
  }
}

let downloadsDir;
/** The user's Downloads folder. On Windows it can be redirected (e.g. to OneDrive), so ask the shell. */
function downloads() {
  if (downloadsDir) return downloadsDir;
  downloadsDir = path.join(os.homedir(), 'Downloads');
  if (IS_WINDOWS) {
    const res = runPowerShell("(New-Object -ComObject Shell.Application).NameSpace('shell:Downloads').Self.Path");
    if (res.code === 0 && res.stdout && fs.existsSync(res.stdout)) downloadsDir = res.stdout;
  }
  return downloadsDir;
}

/**
 * Move received Taildrop files into `dir` (non-blocking) and return candidate paths.
 * The macOS and Windows Tailscale apps save received files straight to Downloads, so that is searched too.
 * On Linux they wait in tailscaled's inbox until `tailscale file get` moves them.
 */
export function receiveFiles(dir, prefix) {
  fs.mkdirSync(dir, { recursive: true });
  const res = run(tailscaleBin(), ['file', 'get', '--conflict=overwrite', dir], { timeoutMs: 30_000 });
  if (res.code !== 0 && permissionDenied(res.stderr || res.stdout)) {
    throw new CliError(`Can't receive Taildrop files: ${res.stderr || res.stdout}`, operatorHint());
  }
  const dirs = [dir, downloads()];
  return dirs.flatMap((d) => {
    try {
      return fs.readdirSync(d).filter((f) => f.startsWith(prefix) && f.endsWith('.json')).map((f) => path.join(d, f));
    } catch {
      return [];
    }
  });
}
````
<!-- END FILE -->

<!-- BEGIN FILE: src/paseo.js -->
**`src/paseo.js`**

````js
// Paseo: locate/install the CLI, run it as a client of a (remote) daemon, and edit the local daemon config.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import bcrypt from 'bcryptjs';
import { CliError, IS_WINDOWS, run } from './util.js';

const PACKAGE = '@getpaseo/cli';
// npm 12 blocks dependency install scripts by default; these three need theirs (native modules / binaries).
const ALLOW_SCRIPTS = '--allow-scripts=esbuild,node-pty,msgpackr-extract';

let cachedEntry;

export function npmRootGlobal() {
  // On Windows npm is a .cmd shim, which Node can only start through a shell; the arguments are fixed strings.
  const res = run('npm', ['root', '-g'], { shell: IS_WINDOWS });
  if (res.code !== 0 || !res.stdout) throw new CliError(`Can't locate global npm packages: ${res.stderr}`);
  const root = res.stdout.split(/\r?\n/).pop().trim();
  if (!root.includes('***')) return root;
  // npm masks UUID-like path segments ("***") in its output. Use where npm puts global packages by default.
  const prefix = process.env.npm_config_prefix || (IS_WINDOWS ? path.dirname(process.execPath) : path.dirname(path.dirname(process.execPath)));
  return IS_WINDOWS ? path.join(prefix, 'node_modules') : path.join(prefix, 'lib', 'node_modules');
}

/** Path to Paseo's JS entry point, or null if not installed. Running it with `node` avoids .cmd shims. */
export function paseoEntry() {
  if (cachedEntry && fs.existsSync(cachedEntry)) return cachedEntry;
  const entry = path.join(npmRootGlobal(), PACKAGE, 'bin', 'paseo');
  cachedEntry = fs.existsSync(entry) ? entry : null;
  return cachedEntry;
}

export function requirePaseo() {
  const entry = paseoEntry();
  if (!entry) throw new CliError('Paseo is not installed.', { hint: `Run: claude-wingman setup   (or: ${PASEO_INSTALL})` });
  return entry;
}

/**
 * The Paseo release claude-wingman is tested with. Its terminals, error messages and agent states are relied on and
 * aren't a stable API, so new installs get exactly this version; a different one is reported by setup, doctor, verify.
 */
export const PASEO_VERSION = '0.11.4';
export const PASEO_INSTALL = `npm install -g ${PACKAGE}@${PASEO_VERSION} ${ALLOW_SCRIPTS}`;

/** The installed Paseo's version, or null. */
export function paseoVersion() {
  const entry = paseoEntry();
  if (!entry) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(path.dirname(entry), '..', 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

export function installPaseo() {
  const res = run('npm', ['install', '-g', `${PACKAGE}@${PASEO_VERSION}`, ALLOW_SCRIPTS], { shell: IS_WINDOWS, timeoutMs: 600_000 });
  cachedEntry = undefined;
  if (res.code !== 0 || !paseoEntry()) throw new CliError(`Installing Paseo failed:\n${res.stderr || res.stdout}`);
}

export const nodeArgs = (entry, args) => ['--disable-warning=DEP0040', entry, ...args];

/**
 * Environment for a Paseo client. Agents and terminals started by a daemon inherit PASEO_* context (PASEO_HOME,
 * which paseo refuses to combine with PASEO_HOST, and PASEO_WORKSPACE_ID, which would make `run` look for this
 * machine's workspace on the other daemon). None of it applies to another daemon, so drop it all.
 */
export function clientEnv({ host, password, isolatedHome } = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('PASEO_')) delete env[key];
  if (host) env.PASEO_HOST = host;
  else delete env.PASEO_HOST;
  if (password) env.PASEO_PASSWORD = password;
  if (isolatedHome) {
    // A client without this machine's local credential file, i.e. exactly what a remote client looks like.
    env.HOME = isolatedHome;
    env.USERPROFILE = isolatedHome;
  }
  return env;
}

/** A one-line reason from a failed paseo run. With --json, paseo reports errors as {"error": {"message": ...}}. */
export function errorText(res) {
  const text = (res.stderr || res.stdout || '').trim();
  try {
    const parsed = JSON.parse(text);
    const message = parsed?.error?.message ?? parsed?.message;
    if (typeof message === 'string' && message) return message;
  } catch {}
  return text.split(/\r?\n/).find((line) => line.trim()) ?? `exit code ${res.code}`;
}

/** Run paseo and capture output. */
export function paseo(args, opts = {}) {
  return run(process.execPath, nodeArgs(requirePaseo(), args), { env: clientEnv(opts), timeoutMs: opts.timeoutMs ?? 120_000 });
}

/** paseo() without blocking, so several daemons can be asked at once. */
export function paseoAsync(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, nodeArgs(requirePaseo(), args), { env: clientEnv(opts), windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 120_000);
    const done = (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    };
    child.on('error', () => done(127));
    child.on('close', (code) => done(code ?? 1));
  });
}

/** Run paseo attached to this terminal (for passthrough commands). Returns the exit code. */
export function paseoInteractive(args, opts = {}) {
  const res = spawnSync(process.execPath, nodeArgs(requirePaseo(), args), { env: clientEnv(opts), stdio: 'inherit', windowsHide: true });
  return res.status ?? 1;
}

/** Run a paseo command that prints JSON and parse it. */
export function paseoJson(args, opts = {}) {
  const res = paseo([...args, '--json'], opts);
  if (res.code !== 0) throw new CliError(`paseo ${args[0]} failed: ${errorText(res)}`);
  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new CliError(`Unexpected output from paseo ${args.join(' ')}:\n${res.stdout.slice(0, 500)}`);
  }
}

// ---- local daemon configuration ----------------------------------------------------------

export const paseoHome = () => process.env.PASEO_HOME || path.join(os.homedir(), '.paseo');
const paseoConfigPath = () => path.join(paseoHome(), 'config.json');

export function readDaemonConfig() {
  try {
    return JSON.parse(fs.readFileSync(paseoConfigPath(), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new CliError(`Can't read ${paseoConfigPath()}: ${err.message}`);
  }
}

export const passwordMatchesDaemon = (password) => {
  const hash = readDaemonConfig()?.daemon?.auth?.password;
  return Boolean(hash && password && bcrypt.compareSync(password, hash));
};

/**
 * Point the local daemon at `listen`, require `password`, and keep the relay off.
 * `paseo daemon set-password` needs a terminal, and `config set daemon.auth.password` is refused,
 * so the bcrypt hash goes straight into config.json (the documented daemon.auth.password key).
 */
export function configureDaemon({ listen, password }) {
  if (!readDaemonConfig()) {
    // Let paseo create a complete default config first.
    const res = run(process.execPath, nodeArgs(requirePaseo(), ['daemon', 'config', 'set', 'daemon.listen', listen]), { env: clientEnv() });
    if (res.code !== 0) throw new CliError(`Creating Paseo config failed: ${res.stderr}`);
  }
  const file = paseoConfigPath();
  const cfg = readDaemonConfig();
  const before = JSON.stringify(cfg);
  cfg.daemon ??= {};
  cfg.daemon.listen = listen;
  cfg.daemon.relay = { ...cfg.daemon.relay, enabled: false };
  if (!passwordMatchesDaemon(password)) cfg.daemon.auth = { ...cfg.daemon.auth, password: bcrypt.hashSync(password, 12) };
  const changed = JSON.stringify(cfg) !== before;
  if (changed) {
    const backup = `${file}.bak-${Date.now()}`;
    fs.copyFileSync(file, backup);
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
    // writeFileSync's mode only applies to new files; the config (and its backup) hold the password hash.
    if (!IS_WINDOWS) for (const f of [file, backup]) fs.chmodSync(f, 0o600);
  }
  return changed;
}
````
<!-- END FILE -->

<!-- BEGIN FILE: src/self-install.js -->
**`src/self-install.js`**

````js
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
````
<!-- END FILE -->

<!-- BEGIN FILE: src/remote.js -->
**`src/remote.js`**

````js
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
````
<!-- END FILE -->

<!-- BEGIN FILE: src/share.js -->
**`src/share.js`**

````js
// Handing credentials (pairing bundles) to other machines:
//   - over Taildrop, for the first pairing, which a person runs in a terminal (sendBundle);
//   - from a single-use URL on this machine's Tailscale address, fetched by a machine this one already
//     controls through a remote terminal (serveOnce + fetchBundle). Taildrop can't be used there: on macOS,
//     processes under the daemon may not read ~/Downloads, where Taildrop saves files.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { bundleFileName, makeBundle, parseBundle } from './bundle.js';
import { getSecret } from './secrets.js';
import { isTailscaleIp, sendFile } from './tailscale.js';
import { CliError, VERSION } from './util.js';

/** This machine's bundle, or (with `peerName`) a paired machine's, rebuilt from what this machine knows about it. */
export function bundleFor(cfg, peerName) {
  if (!peerName) {
    const password = getSecret('self');
    if (!password) throw new CliError('No daemon password stored for this machine.', { hint: 'Run: claude-wingman setup' });
    const { name, host, port, os: osName, home, reposRoot, machine } = cfg.self;
    return makeBundle({ name, host, port, password, os: osName, home, reposRoot, machine, version: VERSION });
  }
  const p = cfg.peers[peerName];
  const password = getSecret(`peer:${peerName}`);
  if (!p || !password) throw new CliError(`No stored credentials for ${peerName}.`);
  return makeBundle({ name: p.remoteName ?? peerName, host: p.host, port: p.port, password, os: p.os, home: p.home, reposRoot: p.reposRoot, machine: p.machine, version: p.version });
}

/** @param machine {{ name: string }} a Tailscale machine; selfIp: this machine's current Tailscale IP */
export function sendBundle(cfg, machine, selfIp) {
  const bundle = bundleFor(cfg);
  if (cfg.self.host !== selfIp) {
    throw new CliError(`This machine's Tailscale IP changed (${cfg.self.host} -> ${selfIp}) since setup.`, { hint: 'Run: claude-wingman setup' });
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-wingman-'));
  const file = path.join(dir, bundleFileName(bundle.name));
  try {
    fs.writeFileSync(file, JSON.stringify(bundle), { mode: 0o600 });
    sendFile(file, machine.name);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Serve `content` at an unguessable URL on this machine's Tailscale address while `fn(url)` runs.
 * With `once`, the URL stops working after the first download (for credentials).
 */
export async function serveOnce(host, fileName, content, fn, { once = true } = {}) {
  const token = crypto.randomBytes(16).toString('hex');
  const urlPath = `/${token}/${encodeURIComponent(fileName)}`;
  let served = false;
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== urlPath || (once && served)) {
      res.writeHead(404).end();
      return;
    }
    served = true;
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': content.length, 'Cache-Control': 'no-store' });
    res.end(content);
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, host, resolve));
  try {
    return await fn(`http://${host}:${server.address().port}${urlPath}`);
  } finally {
    server.close();
  }
}

/** Download and validate a bundle from a URL made by serveOnce on another of the user's machines. */
export async function fetchBundle(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new CliError(`Not a URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' || !isTailscaleIp(parsed.hostname)) throw new CliError('Credentials can only come from a Tailscale (100.x) address.');
  return new Promise((resolve, reject) => {
    const req = http.get(parsed, { timeout: 30_000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new CliError(`Fetching credentials failed (HTTP ${res.statusCode}); the link works once and only while the other machine waits.`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 64 * 1024) req.destroy(new CliError('Credential file too large.'));
      });
      res.on('end', () => {
        try {
          resolve(parseBundle(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('timeout', () => req.destroy(new CliError('Fetching credentials timed out.')));
    req.on('error', (err) => reject(err instanceof CliError ? err : new CliError(`Fetching credentials failed: ${err.message}`)));
  });
}
````
<!-- END FILE -->

<!-- BEGIN FILE: src/service.js -->
**`src/service.js`**

````js
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
````
<!-- END FILE -->

<!-- BEGIN FILE: src/bundle.js -->
**`src/bundle.js`**

````js
// The credential bundle two machines exchange (over Taildrop) when pairing.
// It holds everything a peer needs to reach this machine's daemon and to write a skill for it.
import { CliError, SUPPORTED_OSES } from './util.js';
import { validateName } from './config.js';
import { isTailscaleIp } from './tailscale.js';

export const BUNDLE_KIND = 'claude-wingman-credentials';
export const BUNDLE_PREFIX = 'claude-wingman-';
export const bundleFileName = (name) => `${BUNDLE_PREFIX}${name}.json`;

const OSES = new Set(SUPPORTED_OSES);

export function makeBundle({ name, host, port, password, os, home, reposRoot, machine, version }) {
  return { kind: BUNDLE_KIND, v: 1, name, host, port, password, os, home, reposRoot, machine, version, createdAt: new Date().toISOString() };
}

/** Parse and validate a bundle; throws CliError describing the first problem. */
export function parseBundle(text) {
  let b;
  try {
    b = JSON.parse(text);
  } catch {
    throw new CliError('Credential file is not valid JSON.');
  }
  const bad = (what) => {
    throw new CliError(`Credential file has an invalid ${what}.`);
  };
  if (b?.kind !== BUNDLE_KIND || b.v !== 1) bad('format (not a claude-wingman v1 bundle)');
  validateName(b.name, 'peer name');
  if (!isTailscaleIp(b.host)) bad('host (expected a Tailscale 100.x address)');
  if (!Number.isInteger(b.port) || b.port < 1 || b.port > 65535) bad('port');
  if (typeof b.password !== 'string' || !/^[A-Za-z0-9._~-]{4,128}$/.test(b.password)) bad('password');
  if (!OSES.has(b.os)) bad('os');
  // These values end up in the generated skill, which Claude reads as instructions: allow plain machine
  // names and absolute paths only (no quotes, backticks, angle brackets, newlines or control characters).
  if (typeof b.machine !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(b.machine)) bad('machine');
  for (const key of ['home', 'reposRoot']) {
    const v = b[key];
    const absolute = b.os === 'win32' ? /^[A-Za-z]:\\/.test(v ?? '') : String(v ?? '').startsWith('/');
    if (typeof v !== 'string' || !absolute || !/^[^\x00-\x1f\x7f"`<>|*?]{2,200}$/.test(v) || v.trim() !== v) bad(key);
  }
  // The sender's claude-wingman version (absent from older versions' bundles), shown by status.
  if (b.version !== undefined && (typeof b.version !== 'string' || !/^\d{1,4}\.\d{1,4}\.\d{1,6}(-[0-9A-Za-z.]{1,32})?$/.test(b.version))) bad('version');
  const created = Date.parse(b.createdAt);
  if (!Number.isFinite(created) || created > Date.now() + 5 * 60_000) bad('createdAt (missing or in the future)');
  return b;
}
````
<!-- END FILE -->

<!-- BEGIN FILE: src/skill.js -->
**`src/skill.js`**

````js
// Generate and install the Claude Code skill that teaches Claude to use a peer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliError, osLabel } from './util.js';

export const SKILL_MARKER = '<!-- generated by claude-wingman';
export const isOurSkill = (text) => text.includes(SKILL_MARKER);

export const skillsDir = () => path.join(os.homedir(), '.claude', 'skills');

export function renderSkill(name, peer) {
  const win = peer.os === 'win32';
  const linux = peer.os === 'linux';
  const kind = win ? 'Windows machine' : linux ? 'Linux machine' : 'Mac';
  const osName = osLabel(peer.os);
  // Single quotes: these phrases sit inside the double-quoted YAML description.
  const phrases = win ? `'on ${name}', 'on Windows' or 'on the Windows machine'`
    : linux ? `'on ${name}', 'on Linux' or 'on the Linux machine'` : `'on ${name}', 'on the Mac' or 'on macOS'`;
  const exampleRepo = win ? `${peer.reposRoot}\\app` : `${peer.reposRoot}/app`;
  return `---
name: ${name}
description: "Run a task on ${name}, the user's ${kind} (${peer.machine}), by dispatching a Claude agent there and bringing back its result, e.g. running a project's tests on ${osName}. Use when the user asks to run, test, build or check something ${phrases}, or what is running there, or to pause, resume or cancel work there. Not for work on this machine."
---
${SKILL_MARKER}; recreate with: claude-wingman skill -->

# ${name}: dispatch work to the ${kind}

\`claude-wingman\` sends Claude Code agents to **${name}** over Tailscale. The agent runs on ${name}, against ${name}'s own files and toolchain, in auto permission mode. Code travels via git.

## Steps

1. **Get the code there.** Commit and push the work to a branch such as \`${name}-test/<topic>\`. Never push to main/master unless asked. Skip this if the user says ${name} already has it.
2. **Pick the repo on ${name}.** Repos there live under \`${peer.reposRoot}\`. Pass the folder name (\`--repo app\`) or a full ${name} path (\`--repo '${exampleRepo}'\`). If unsure, run \`claude-wingman ${name} project ls\` or ask the user. Don't guess.
3. **Dispatch and wait:**
   \`\`\`
   claude-wingman dispatch ${name} --repo <repo> --branch <branch> "<task, e.g. run the test suite and report failures>"
   \`\`\`
   - With \`--branch\`, the agent works in a separate worktree (\`<repo>-remote-test\`) at \`origin/<branch>\`. The user's checkout on ${name} is never touched, and any fixes are pushed to that branch.
   - Without \`--branch\`, it works directly in the repo folder as it is. Use that for read-only checks.
   - It waits up to 9 minutes and prints the agent's final report. Exit codes:
     - **0:** done.
     - **3:** waiting for a permission.
     - **4:** still running. Continue with \`claude-wingman ${name} wait <id> --timeout 540\`, then \`claude-wingman ${name} logs <id> --filter text --tail 1\`.
     - **1:** error.
   - For long jobs, add \`--detach\` and check back later with \`claude-wingman status\` and \`claude-wingman logs <id>\`.
4. **Report back** from the agent's report. If it pushed fixes, \`git pull\` the branch here and summarize them. Don't claim a result the report doesn't show.

## See and control what runs

- \`claude-wingman status\` lists agents and remote commands on every machine: running, needing a permission, paused, and the latest finished, each with an id. \`claude-wingman status ${name}\` shows only ${name}; add \`--all\` for every finished one, \`--json\` to parse it.
- \`claude-wingman logs <id>\` shows what an agent did (\`--tail 20\` for the latest steps). The start of an id is enough, and it finds the machine itself.
- When the user asks: \`claude-wingman pause <id>\` interrupts an agent and keeps its conversation (whatever it was running is stopped); \`claude-wingman resume <id> ["<message>"]\` lets it carry on; \`claude-wingman cancel <id>\` stops an agent, or a remote command, for good. Don't pause or cancel work the user didn't ask you to.

## Other commands

- \`claude-wingman ${name} <paseo command>\`, e.g. \`ls\`, \`logs <id>\`, \`send <id> "<follow-up>"\`, \`stop <id>\`, \`archive <id>\`.
- **Permissions:** \`claude-wingman ${name} permit ls\` shows the tool name but not the command. Tell the user what is pending. Run \`permit allow <agent>\` only with their OK, or when the request is clearly read-only or within what they asked.
- **Unreachable:** ${name} is probably asleep, offline, or not on Tailscale. Say so. \`claude-wingman status\` shows reachability.
- **Maintenance, only when the user asks for it:** \`claude-wingman update\` installs this machine's claude-wingman version on every paired machine; \`claude-wingman remote ${name} <command>\` runs a claude-wingman command on ${name} (e.g. \`verify\`, \`peers\`, \`setup\`). These change ${name}'s setup, so never run them on your own initiative.

## Rules

- Don't use \`claude-wingman run\`, even though it exists: it runs a raw command on ${name} without an agent's safety checks, and is meant for the user. Do work on ${name} with \`dispatch\`.
- Never use \`--mode bypassPermissions\`. ${name} runs agents ${win ? 'unsandboxed (native Windows has no sandbox)' : `with full access to that ${linux ? 'machine' : 'Mac'}`}.
- Anything needing ${win ? 'administrator rights (a UAC prompt)' : 'sudo'} on ${name} can't be done remotely. Ask the user to do it there.
`;
}

function skillState(name) {
  const dir = path.join(skillsDir(), name);
  let stat = null;
  try {
    stat = fs.lstatSync(dir);
  } catch {}
  return { dir, stat };
}

/** Throw if ~/.claude/skills/<name> holds a skill claude-wingman didn't create (checked before pairing changes anything). */
export function assertSkillInstallable(name) {
  const { dir, stat } = skillState(name);
  if (!stat || stat.isSymbolicLink()) return;
  const file = path.join(dir, 'SKILL.md');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (existing && !isOurSkill(existing)) {
    throw new CliError(`A different skill named "${name}" already exists at ${dir}.`, {
      hint: 'Pair under another name (claude-wingman pair <machine> --name <other>) or remove that skill first.',
    });
  }
}

/** Install (or replace) ~/.claude/skills/<name>/SKILL.md. Refuses to overwrite a skill it didn't create. */
export function installSkill(name, content) {
  assertSkillInstallable(name);
  const { dir, stat } = skillState(name);
  // A link (symlink on macOS, junction on Windows): replace the link, never touch its target.
  if (stat?.isSymbolicLink()) fs.unlinkSync(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content);
  return path.join(dir, 'SKILL.md');
}

export function removeSkill(name) {
  const file = path.join(skillsDir(), name, 'SKILL.md');
  if (fs.existsSync(file) && isOurSkill(fs.readFileSync(file, 'utf8'))) {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
    return true;
  }
  return false;
}
````
<!-- END FILE -->

<!-- BEGIN FILE: src/dispatch.js -->
**`src/dispatch.js`**

````js
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
````
<!-- END FILE -->

<!-- BEGIN FILE: src/commands/setup.js -->
**`src/commands/setup.js`**

````js
// claude-wingman setup: make this machine's Paseo daemon reachable (Tailscale only, password, autostart, awake).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from '../args.js';
import { DEFAULT_PORT, loadConfig, saveConfig, toName, validateName } from '../config.js';
import { PASEO_INSTALL, PASEO_VERSION, configureDaemon, installPaseo, paseoEntry, paseoVersion, passwordMatchesDaemon, readDaemonConfig } from '../paseo.js';
import { getSecret, secretStoreName, setSecret } from '../secrets.js';
import { ensureWindowsFirewall, installServices } from '../service.js';
import { status as tailscaleStatus } from '../tailscale.js';
import { CliError, IS_LINUX, IS_MAC, IS_WINDOWS, SUPPORTED_OSES, insidePaseoAgent, isWindowsToolOnWsl, nodeIsSupported, ui, which } from '../util.js';
import { ensureInstalledGlobally } from '../self-install.js';
import { canConnect } from './manage.js';
import { resharePassword } from './remote.js';
import { ask } from '../prompt.js';

export function generatePassword(length = 24) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  while (out.length < length) {
    for (const byte of crypto.randomBytes(length)) {
      // Rejection sampling keeps the distribution uniform.
      if (byte < 256 - (256 % alphabet.length) && out.length < length) out += alphabet[byte % alphabet.length];
    }
  }
  return out;
}

// Common names for a folder of repos, most common first; the first that exists is the default.
export const REPO_FOLDERS = ['src', 'code', 'projects', 'repos', 'dev', 'git', 'ws', 'workspace'];
export const defaultReposRoot = (home = os.homedir(), exists = fs.existsSync) =>
  REPO_FOLDERS.map((f) => path.join(home, f)).find((dir) => exists(dir)) ?? home;

/** A short default machine name: "mac" on macOS, otherwise the Tailscale name (e.g. "msi") if usable. */
export function defaultSelfName(tailscaleName, platform = process.platform) {
  if (platform === 'darwin') return 'mac';
  return toName(tailscaleName) ?? (platform === 'linux' ? 'linux' : 'pc');
}

export async function setup(argv) {
  const { opts } = parseArgs(argv, { name: 'string', repos: 'string', 'rotate-password': 'boolean', 'no-restart': 'boolean', 'defer-restart': 'boolean' });
  await ensureSetup(opts);
}

/**
 * Configure this machine (idempotent). Used by `setup`, and by `pair` on a machine that isn't set up yet.
 * opts: { name, repos, 'rotate-password', 'no-restart' } plus { fromPair } to skip the "next step" hint.
 */
export async function ensureSetup(opts = {}) {
  if (!SUPPORTED_OSES.includes(process.platform)) throw new CliError(`claude-wingman supports macOS, Windows and Linux; this is ${process.platform}.`);
  if (!nodeIsSupported()) throw new CliError(`Node.js 20.11 or newer is required (found ${process.version}).`);
  ensureInstalledGlobally(); // started with npx: install the command, which the skills call

  const cfg = loadConfig();
  ui.step('Checking prerequisites');
  if (!which('claude')) {
    throw new CliError('Claude Code (`claude`) is not on PATH.', { hint: 'Install it and sign in: https://code.claude.com/docs/en/setup' });
  }
  for (const tool of ['claude', 'npm']) {
    if (isWindowsToolOnWsl(which(tool))) {
      throw new CliError(`\`${tool}\` here is the Windows one (${which(tool)}); WSL needs its own.`, {
        hint: tool === 'npm' ? 'Install Node.js inside WSL, e.g.: nvm install 22   (open a new terminal first if nvm was just installed)'
          : 'Install Claude Code inside WSL: curl -fsSL https://claude.ai/install.sh | bash   then run claude once to sign in',
      });
    }
  }
  ui.ok('Claude Code found');
  if (!which('git')) ui.warn('git is not on PATH; dispatched agents need it to fetch your branches');
  const ts = tailscaleStatus();
  ui.ok(`Tailscale connected as ${ts.self.name} (${ts.self.ip})`);

  let entry = paseoEntry();
  if (!entry) {
    ui.info(`Installing Paseo ${PASEO_VERSION} (npm install -g @getpaseo/cli@${PASEO_VERSION}) ...`);
    installPaseo();
    entry = paseoEntry();
  }
  const paseoAt = paseoVersion();
  // An existing Paseo may be used for other things, and Windows locks a running daemon's files: report, don't replace.
  if (paseoAt === PASEO_VERSION) ui.ok(`Paseo ${paseoAt}`);
  else {
    ui.warn(`Paseo ${paseoAt ?? '(unknown version)'} is installed; claude-wingman is tested with ${PASEO_VERSION}. To switch: ${PASEO_INSTALL}, then: claude-wingman restart`);
  }

  const name = opts.name !== undefined || cfg.self?.name
    ? validateName(opts.name ?? cfg.self.name, 'machine name')
    : await ask('Short name for this machine (other machines use it, e.g. "run the tests on <name>")',
      defaultSelfName(ts.self.name), (v) => validateName(v, 'machine name'));
  const reposRoot = path.resolve(opts.repos ?? cfg.self?.reposRoot ?? defaultReposRoot());
  const port = cfg.self?.port ?? DEFAULT_PORT;
  const listen = `${ts.self.ip}:${port}`;

  ui.step('Daemon password');
  let password = opts['rotate-password'] ? null : getSecret('self');
  let rotated = false;
  if (password && readDaemonConfig()?.daemon?.auth?.password && !passwordMatchesDaemon(password)) {
    ui.warn('The stored password no longer matches the daemon; replacing it');
    password = null;
  }
  if (!password) {
    password = generatePassword();
    rotated = Boolean(readDaemonConfig()?.daemon?.auth?.password);
    ui.ok(rotated ? 'Generated a new daemon password (replacing the old one)' : 'Generated a daemon password');
    setSecret('self', password);
  } else {
    ui.ok(`Using the stored password (${secretStoreName()})`);
  }

  ui.step('Daemon configuration');
  const configChanged = configureDaemon({ listen, password });
  ui.ok(`Listens only on ${listen} (Tailscale); password required; relay off`);

  // Paired machines still know the old password: hand them the new one through their remote terminals,
  // before the restart below (which, when deferred, would otherwise cut this off). They take it right away;
  // this daemon switches to it when it restarts.
  if (rotated && Object.keys(cfg.peers).length) await resharePassword();

  ui.step('Autostart and keep-awake');
  // Restarting the daemon from inside one of its own agents would kill this process mid-way,
  // so in that case the restart is handed off and happens shortly after we exit.
  // --defer-restart: run from a remote terminal, which also lives under the daemon.
  const deferSeconds = insidePaseoAgent() || opts['defer-restart'] ? 20 : 0;
  const noRestart = Boolean(opts['no-restart']);
  const force = configChanged || !(await canConnect(ts.self.ip, port));
  const { restarted, pending, warnings = [] } = installServices({ entry, deferSeconds, noRestart, force });
  ui.ok(IS_MAC ? 'launchd keeps the daemon running; caffeinate blocks idle sleep'
    : IS_LINUX ? 'systemd keeps the daemon running; systemd-inhibit blocks idle sleep'
      : 'Logon task starts the daemon (and again within 2 minutes if it stops); no sleep on AC power');
  for (const w of warnings) ui.warn(w);
  if (pending) ui.warn('Not restarted (--no-restart): run "claude-wingman restart" to apply the new configuration.');
  else if (restarted && deferSeconds) ui.warn(`The daemon restarts in ~${deferSeconds}s (anything running under it is cut off then).`);
  else if (restarted) ui.ok('Daemon (re)started with this configuration');
  else ui.ok('Daemon already running with this configuration; not restarted');
  if (IS_WINDOWS) {
    const fw = ensureWindowsFirewall(port);
    if (fw.state === 'not-admin') {
      ui.info('Optional: allow only Tailscale through Windows Firewall (run once in an Administrator PowerShell):');
      ui.hint(fw.command);
    } else ui.ok(`Firewall rule (Tailscale only): ${fw.state}`);
  }

  const fresh = loadConfig(); // keep peers paired by a concurrent run
  fresh.self = {
    name, machine: ts.self.name, host: ts.self.ip, os: process.platform, port, home: os.homedir(), reposRoot,
    user: os.userInfo().username, node: process.execPath,
  };
  saveConfig(fresh);

  ui.ok(`This machine is "${name}". Repos for dispatched agents: ${reposRoot}`);
  const peers = Object.keys(cfg.peers);
  if (!opts.fromPair && !peers.length) ui.info('Next: run "claude-wingman pair" on this machine and on the other one.');
}
````
<!-- END FILE -->

<!-- BEGIN FILE: src/commands/pair.js -->
**`src/commands/pair.js`**

````js
// claude-wingman pair [<machine>...]: exchange daemon credentials with other machines over Taildrop.
// Run it on each machine (any order). Each side sends its own bundle and waits for the others'.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from '../args.js';
import { BUNDLE_PREFIX, parseBundle } from '../bundle.js';
import { configDir, loadConfig, requireSelf, saveConfig, toName, validateName } from '../config.js';
import { parseDuration } from '../dispatch.js';
import { errorText, paseo } from '../paseo.js';
import { chooseMany } from '../prompt.js';
import { setSecret } from '../secrets.js';
import { fetchBundle, sendBundle } from '../share.js';
import { ensureInstalledGlobally } from '../self-install.js';
import { assertSkillInstallable, installSkill, renderSkill } from '../skill.js';
import { receiveFiles, resolveMachine, status as tailscaleStatus } from '../tailscale.js';
import { CliError, osLabel, sleep, ui } from '../util.js';
import { ensureSetup } from './setup.js';
import { introduce } from './remote.js';

/**
 * Credential files received so far, grouped by sender IP: the newest valid bundle per sender, plus all its
 * files (deleted only after a successful import). Each unusable file is reported once.
 */
function receivedBundles(expectedIps, reported) {
  const bySender = new Map();
  for (const file of receiveFiles(path.join(configDir(), 'inbox'), BUNDLE_PREFIX)) {
    let bundle;
    try {
      bundle = parseBundle(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (!reported.has(file)) ui.warn(`Ignoring ${file}: ${err.message}`);
      reported.add(file);
      continue;
    }
    if (!expectedIps.has(bundle.host)) {
      if (!reported.has(file)) {
        ui.warn(`Ignoring ${file}: it is from ${bundle.host}, which isn't being paired now. Delete it if you don't need it; it contains a password.`);
      }
      reported.add(file);
      continue;
    }
    const entry = bySender.get(bundle.host) ?? { bundle, files: [] };
    if (Date.parse(bundle.createdAt) > Date.parse(entry.bundle.createdAt)) entry.bundle = bundle;
    entry.files.push(file);
    bySender.set(bundle.host, entry);
  }
  return bySender;
}

/**
 * Machines that can be paired: online macOS, Windows and Linux machines with an IPv4 address that belong
 * to the same Tailscale user as this one. Shared-in and tagged machines (other owners) are never offered.
 */
export const pairCandidates = (peers, self) =>
  peers.filter((m) => m.online && m.ip && !m.shared && m.userId === self.userId && /^(macos|windows|linux)$/i.test(m.os ?? ''));

/** The machines to pair with when none were named: the only candidate, all of them, or a choice. */
async function pickMachines(ts, all) {
  const candidates = pairCandidates(ts.peers, ts.self);
  if (!candidates.length) {
    throw new CliError('No other computer of yours is online on Tailscale.', {
      hint: 'Sign in to Tailscale on the other machine with the same account, or name it: claude-wingman pair <machine>',
    });
  }
  const tsOs = { macos: 'macOS', windows: 'Windows', linux: 'Linux' };
  const label = (m) => `${m.name} (${tsOs[m.os.toLowerCase()] ?? m.os}, ${m.ip})`;
  if (candidates.length === 1) {
    ui.info(`Pairing with ${label(candidates[0])}, your only other computer online`);
    return candidates;
  }
  if (all) return candidates;
  return chooseMany('Pair with which machines?', candidates, label, {
    hint: `Name them (claude-wingman pair ${candidates.map((m) => m.name).join(' ')}) or pass --all.`,
  });
}

/**
 * The name this machine will use for a newly paired one: --name if given; the name it already has here
 * (re-pairing); else its own name, its Tailscale name, or its name plus a number, whichever is free.
 */
export function peerAlias(bundle, cfg, explicit) {
  const owner = (n) => (Object.hasOwn(cfg.peers, n) ? cfg.peers[n] : null);
  if (explicit) {
    if (explicit === cfg.self.name) throw new CliError(`"${explicit}" is this machine's own name.`);
    if (owner(explicit) && owner(explicit).host !== bundle.host) {
      throw new CliError(`"${explicit}" is already the name of another paired machine (${owner(explicit).machine}).`, { hint: 'Pick another --name.' });
    }
    return explicit;
  }
  const existing = Object.keys(cfg.peers).find((n) => cfg.peers[n].host === bundle.host);
  if (existing) return existing;
  const free = (n) => n && n !== cfg.self.name && !owner(n);
  for (const candidate of [bundle.name, toName(bundle.machine)]) if (free(candidate)) return candidate;
  for (let i = 2; ; i++) {
    const candidate = `${bundle.name.slice(0, 27)}-${i}`;
    if (free(candidate)) return candidate;
  }
}

/** Save a received bundle as a peer and write its skill. Returns the alias. */
function importBundle({ bundle, files }, explicitName) {
  const cfg = loadConfig(); // fresh: another pair may have saved while we waited
  const alias = peerAlias(bundle, cfg, explicitName);
  // Check what can fail before changing anything, so a failed import leaves no half-paired peer.
  assertSkillInstallable(alias);
  setSecret(`peer:${alias}`, bundle.password);
  cfg.peers[alias] = {
    host: bundle.host, port: bundle.port, os: bundle.os, home: bundle.home, reposRoot: bundle.reposRoot,
    machine: bundle.machine, remoteName: bundle.name, pairedAt: new Date().toISOString(),
    ...(bundle.version ? { version: bundle.version } : {}),
  };
  saveConfig(cfg);
  const skillFile = installSkill(alias, renderSkill(alias, cfg.peers[alias]));
  for (const file of files) fs.rmSync(file, { force: true }); // they hold a password; gone once imported
  const renamed = alias !== bundle.name ? ` (it calls itself "${bundle.name}"; that name is taken here)` : '';
  ui.ok(`Paired with ${alias}${renamed}: ${bundle.machine}, ${osLabel(bundle.os)}, ${bundle.host}`);
  ui.ok(`Installed skill: ${skillFile}`);
  const check = paseo(['ls'], { host: `${bundle.host}:${bundle.port}`, password: bundle.password, timeoutMs: 30_000 });
  if (check.code === 0) ui.ok(`Connected to ${alias}'s daemon`);
  else ui.warn(`Can't reach ${alias}'s daemon yet (${errorText(check)}). If it was just set up, give it a minute and run: claude-wingman status`);
  return alias;
}

export async function pair(argv) {
  const { opts, positionals } = parseArgs(argv, {
    name: 'string', as: 'string', repos: 'string', all: 'boolean', 'send-only': 'boolean', 'receive-only': 'boolean', timeout: 'string',
    'no-introduce': 'boolean', 'from-url': 'string',
  });
  if (opts['send-only'] && opts['receive-only']) throw new CliError('Use --send-only or --receive-only, not both.');
  if (opts.name && (positionals.length > 1 || opts.all)) throw new CliError('--name renames one machine; pair with a single machine to use it.');
  if (opts.all && positionals.length) throw new CliError('Name machines or pass --all, not both.');
  if (opts.name) validateName(opts.name, 'peer name');
  if (opts.as) validateName(opts.as, 'machine name');
  const timeoutSeconds = parseDuration(opts.timeout ?? '10m');

  // Credentials handed over by another of the user's machines (claude-wingman update/remote, password changes).
  if (opts['from-url']) {
    requireSelf();
    importBundle({ bundle: await fetchBundle(opts['from-url']), files: [] }, opts.name);
    return 0;
  }

  // One command per machine: install the command (when run with npx) and set this machine up first.
  ensureInstalledGlobally();
  let cfg = loadConfig();
  if (!cfg.self) {
    ui.step('Setting up this machine first');
    await ensureSetup({ name: opts.as, repos: opts.repos, fromPair: true });
    cfg = requireSelf();
    ui.step('Pairing');
  } else if ((opts.as && opts.as !== cfg.self.name) || opts.repos) {
    ui.warn(`This machine is already set up as "${cfg.self.name}"; --as/--repos are ignored. To change them: claude-wingman setup --name <name> --repos <dir>`);
  }

  const ts = tailscaleStatus();
  const picked = positionals.length ? positionals.map(resolveMachine) : await pickMachines(ts, opts.all);
  const machines = [...new Map(picked.map((m) => [m.ip, m])).values()];
  for (const m of machines) {
    if (!m.ip) throw new CliError(`${m.name} has no Tailscale IPv4 address.`);
    if (m.ip === ts.self.ip) throw new CliError(`${m.name} is this machine.`);
  }

  const failed = [];
  if (!opts['receive-only']) {
    for (const m of machines) {
      if (!m.online) ui.warn(`${m.name} looks offline; Taildrop will deliver when it's back.`);
      try {
        sendBundle(cfg, m, ts.self.ip);
        ui.ok(`Sent this machine's credentials to ${m.name} (Taildrop, end-to-end encrypted)`);
      } catch (err) {
        if (!(err instanceof CliError)) throw err;
        ui.fail(`${m.name}: ${err.message}`);
        if (err.hint) ui.hint(err.hint);
        failed.push(m.name);
      }
    }
  }
  if (opts['send-only']) {
    for (const m of machines) if (!failed.includes(m.name)) ui.info(`On ${m.name}, run: claude-wingman pair ${cfg.self.machine}`);
    return failed.length ? 1 : 0;
  }

  // Wait for each machine's credentials, importing each as it arrives.
  let pending = machines.filter((m) => !failed.includes(m.name));
  const startedAt = Date.now();
  const before = loadConfig().peers;
  const newlyPaired = [];
  const deadline = Date.now() + timeoutSeconds * 1000;
  const reported = new Set();
  let announced = false;
  while (pending.length) {
    const received = receivedBundles(new Set(pending.map((m) => m.ip)), reported);
    const now = loadConfig().peers;
    for (const m of [...pending]) {
      // Another pair run (e.g. one started remotely) may have imported this machine's credentials first.
      const importedElsewhere = Object.entries(now).find(([, p]) => p.host === m.ip && Date.parse(p.pairedAt) >= startedAt);
      const found = received.get(m.ip);
      if (!found && !importedElsewhere) continue;
      pending = pending.filter((p) => p !== m);
      if (!found) {
        ui.ok(`Paired with ${importedElsewhere[0]} (${m.name}), imported by another claude-wingman run`);
        continue;
      }
      try {
        const alias = importBundle(found, opts.name);
        if (!Object.values(before).some((p) => p.host === m.ip)) newlyPaired.push(alias);
      } catch (err) {
        if (!(err instanceof CliError)) throw err;
        ui.fail(`${m.name}: ${err.message}`);
        if (err.hint) ui.hint(err.hint);
        failed.push(m.name);
      }
    }
    if (!pending.length || Date.now() >= deadline) break;
    if (!announced) {
      for (const m of pending) ui.info(`Waiting for ${m.name}'s credentials. On ${m.name}, run: claude-wingman pair ${cfg.self.machine}`);
      announced = true;
    }
    await sleep(3000);
  }
  for (const m of pending) {
    ui.fail(`Timed out waiting for credentials from ${m.name}.`);
    ui.hint(`Run "claude-wingman pair ${cfg.self.machine}" on ${m.name}, then here: claude-wingman pair ${m.name} --receive-only`);
  }
  // A machine new to this one also gets paired with this one's other machines, remotely.
  let introduced = true;
  if (!opts['no-introduce']) for (const alias of newlyPaired) introduced = (await introduce(alias)) && introduced;
  const paired = machines.length - failed.length - pending.length;
  if (paired) ui.info('Try it: in claude, ask "run the tests for <project> on <machine>"');
  return failed.length || pending.length || !introduced ? 1 : 0;
}
````
<!-- END FILE -->

<!-- BEGIN FILE: src/commands/agents.js -->
**`src/commands/agents.js`**

````js
// See and control what runs on your machines, from any of them:
//   claude-wingman status [<machine>...] [--all] [--watch] [--json]
//   claude-wingman cancel|pause <id>    claude-wingman resume <id> ["<message>"]    claude-wingman logs <id> [--follow]
// An <id> (or the start of one) names an agent, or a remote command for cancel, on whichever machine runs it.
import { parseArgs } from '../args.js';
import { requireSelf } from '../config.js';
import { errorText, paseo, paseoAsync, paseoInteractive } from '../paseo.js';
import { TERMINAL_PREFIX, stopWindowsCommand } from '../remote.js';
import { getSecret } from '../secrets.js';
import { CliError, IS_WINDOWS, VERSION, osLabel, paint, sleep, ui } from '../util.js';
import { serviceStatus } from '../service.js';
import { canConnect } from './manage.js';
import { peerConnection } from './dispatch.js';

/** Paseo has no paused or cancelled state (both are just idle), so claude-wingman records them in this label. */
const STATE_LABEL = 'wingman-state';
const RESUME_MESSAGE = 'You were paused. Continue the task where you left off.';
const ACTIVE = new Set(['running', 'starting', 'needs permission']);

const LOOK = {
  running: { mark: IS_WINDOWS ? '>' : '▶', color: 36 },
  starting: { mark: IS_WINDOWS ? '>' : '▶', color: 36 },
  'needs permission': { mark: '?', color: 33 },
  paused: { mark: IS_WINDOWS ? '=' : '‖', color: 33 },
  failed: { mark: IS_WINDOWS ? 'x' : '✗', color: 31 },
  cancelled: { mark: IS_WINDOWS ? '-' : '✗', color: 2 },
  // Finished its turn: Claude Code reports a failed task (even a model that doesn't exist) as an ordinary reply.
  finished: { mark: IS_WINDOWS ? '-' : '✓', color: 2 },
  command: { mark: IS_WINDOWS ? '>' : '▶', color: 35 },
};

/** This machine and the paired ones (or just `names`), each with a connection or the reason there is none. */
function machines(cfg, names = []) {
  const s = cfg.self;
  const all = [
    { name: s.name, self: true, peer: s, conn: { host: `${s.host}:${s.port}`, password: getSecret('self') } },
    ...Object.keys(cfg.peers).map((n) => {
      try {
        return { ...peerConnection(cfg, n), self: false };
      } catch (err) {
        return { name: n, self: false, peer: cfg.peers[n], error: err.message };
      }
    }),
  ];
  if (!names.length) return all;
  return names.map((n) => all.find((m) => m.name === n) ?? peerConnection(cfg, n)); // throws "unknown peer" helpfully
}

/** What paseo's status (plus our label and pending permissions) means for the user. */
export function agentState(status, { label, waiting }) {
  if (waiting) return 'needs permission';
  if (status === 'running') return 'running';
  if (status === 'initializing') return 'starting';
  if (status === 'error') return 'failed';
  if (status === 'idle' || status === 'closed') return label === 'paused' || label === 'cancelled' ? label : 'finished';
  return status;
}

const parseList = (res) => {
  try {
    return res.code === 0 ? JSON.parse(res.stdout) : [];
  } catch {
    return [];
  }
};

/** One machine's agents and remote commands, newest first. Never includes the connection (no password in --json). */
async function snapshot(m) {
  // version: this machine's, or the one a paired machine last reported (when pairing, or after `update`).
  const base = { machine: m.name, thisMachine: m.self, os: m.peer?.os, host: m.peer?.host, version: m.self ? VERSION : (m.peer?.version ?? null) };
  if (m.error) return { ...base, reachable: false, error: m.error };
  if (!(await canConnect(m.peer.host, m.peer.port))) return { ...base, reachable: false, error: 'unreachable (asleep, offline, or Tailscale down)' };
  const opts = { ...m.conn, timeoutMs: 30_000 };
  const [ls, paused, cancelled, permits, terminals] = await Promise.all([
    paseoAsync(['ls', '-g', '--json'], opts),
    paseoAsync(['ls', '-g', '--label', `${STATE_LABEL}=paused`, '--json'], opts),
    paseoAsync(['ls', '-g', '--label', `${STATE_LABEL}=cancelled`, '--json'], opts),
    paseoAsync(['permit', 'ls', '--json'], opts),
    paseoAsync(['terminal', 'ls', '--all', '--json'], opts),
  ]);
  if (ls.code !== 0) return { ...base, reachable: false, error: errorText(ls) };
  const labels = new Map([...parseList(paused).map((a) => [a.id, 'paused']), ...parseList(cancelled).map((a) => [a.id, 'cancelled'])]);
  const waiting = new Set(parseList(permits).map((p) => p.agentId));
  const agents = parseList(ls).map((a) => ({
    id: a.id,
    shortId: a.shortId ?? a.id.slice(0, 7),
    state: agentState(a.status, { label: labels.get(a.id), waiting: waiting.has(a.id) }),
    title: a.name,
    cwd: a.cwd,
    started: a.created,
  }));
  const commands = parseList(terminals)
    // Leave out the terminal this command itself runs in (status run through `remote`).
    .filter((t) => t.name?.startsWith(TERMINAL_PREFIX) && t.id !== process.env.PASEO_TERMINAL_ID)
    .map((t) => ({ id: t.id, shortId: t.id.slice(0, 7), name: t.name, state: 'running', title: /^wingman-[0-9a-f]+: (.+)/.exec(t.name)?.[1] ?? 'started by an older claude-wingman' }));
  return { ...base, reachable: true, agents, commands };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function summary(snap) {
  const counts = {};
  for (const a of snap.agents) counts[a.state] = (counts[a.state] ?? 0) + 1;
  const parts = ['running', 'starting', 'needs permission', 'paused', 'failed'].filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`);
  if (snap.commands.length) parts.push(plural(snap.commands.length, 'remote command'));
  return parts.length ? parts.join(', ') : 'nothing running';
}

const fit = (text, width) => (text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text);

/** The status screen as lines of text. Shows everything active, plus the latest few finished agents (all with --all). */
export function renderStatus(snaps, { all = false, recent = 3, width = 100, notes = [] } = {}) {
  const lines = [];
  // A narrow terminal drops the "started" column.
  const started = (when) => (width >= 80 ? `${(when ?? '').replace(/^1 (\w+)s ago$/, '1 $1 ago').padEnd(15)} ` : '');
  const row = (look, id, state, when, title = '', folder = '') => {
    const head = `  ${look.mark} ${id}  ${state.padEnd(16)} ${started(when)}`;
    // The title matters most; the folder gets what's left (shortened from the left, where paths are least telling).
    const room = Math.max(12, width - head.length);
    const t = fit(title, folder ? Math.max(Math.min(30, room), room - Math.min(folder.length, 28) - 2) : room);
    const left = room - t.length - 2;
    const f = !folder || left < 8 ? '' : folder.length > left ? `…${folder.slice(-(left - 1))}` : folder;
    lines.push(`${paint(look.color, `  ${look.mark} ${id}  ${state.padEnd(16)}`)} ${started(when)}${t}${f ? `  ${ui.dim(f)}` : ''}`);
  };
  for (const snap of snaps) {
    const about = [snap.os && osLabel(snap.os), snap.host, snap.version && `v${snap.version}`].filter(Boolean).join(' · ');
    const name = ui.bold(snap.machine) + ui.dim(`${snap.thisMachine ? ' (this machine)' : ''}${about ? `  ${about}` : ''}`);
    if (!snap.reachable) {
      lines.push(`${name}  ${paint(31, snap.error)}`, '');
      continue;
    }
    lines.push(`${name}  ${summary(snap)}`);
    for (const c of snap.commands) row(LOOK.command, c.shortId, 'remote command', '', c.title);
    const active = snap.agents.filter((a) => ACTIVE.has(a.state) || a.state === 'paused' || a.state === 'failed');
    const finished = snap.agents.filter((a) => !active.includes(a));
    const shown = all ? finished : finished.slice(0, recent);
    for (const a of [...active, ...shown]) row(LOOK[a.state] ?? LOOK.running, a.shortId, a.state, a.started, a.title, a.cwd);
    if (shown.length < finished.length) lines.push(ui.dim(`    + ${finished.length - shown.length} earlier (claude-wingman status --all)`));
    lines.push('');
  }
  for (const note of notes) lines.push(`${paint(33, IS_WINDOWS ? '[!]' : '!')} ${note}`);
  if (notes.length) lines.push('');
  return lines;
}

/** -1, 0 or 1, comparing "1.2.3" style versions (a pre-release counts as older than its release). */
export function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v).split('-');
    return [...core.split('.').map(Number), pre ? 0 : 1];
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 4; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
  return 0;
}

/** Warnings under the status screen: paired machines on another version, and this machine's services. */
export function statusNotes(snaps, svc = null) {
  const notes = [];
  for (const snap of snaps) {
    if (snap.thisMachine || !snap.version || snap.version === VERSION) continue;
    notes.push(compareVersions(snap.version, VERSION) < 0
      ? `${snap.machine} runs claude-wingman ${snap.version} (last seen), this machine ${VERSION}. Bring it up to date: claude-wingman update ${snap.machine}`
      : `${snap.machine} runs a newer claude-wingman (${snap.version}) than this machine (${VERSION}). Update this one: claude-wingman remote ${snap.machine} update <this machine>, or npm install -g claude-wingman@latest`);
  }
  if (svc && !svc.autostart) notes.push("This machine's daemon doesn't start automatically: claude-wingman setup");
  if (svc && svc.awake === false) notes.push('This machine may go to sleep (keep-awake is off): claude-wingman setup');
  if (svc?.wsl && !svc.wsl.running) notes.push(`WSL may stop when its last window closes (${svc.wsl.detail}): claude-wingman setup`);
  return notes;
}

/** claude-wingman status [<machine>...] [--all] [--watch] [--json] */
export async function status(argv) {
  const { opts, positionals } = parseArgs(argv, { all: 'boolean', watch: 'boolean', json: 'boolean' });
  if (opts.watch && opts.json) throw new CliError("--watch and --json don't go together.");
  const cfg = requireSelf();
  const list = machines(cfg, positionals);
  const tips = ui.dim('Control: claude-wingman cancel|pause|resume <id>   Activity: claude-wingman logs <id> [--follow]');
  // This machine's services: checked once (on Windows and WSL it means a PowerShell call), not on every refresh.
  const svc = list.some((m) => m.self) ? serviceStatus() : null;
  for (;;) {
    const snaps = await Promise.all(list.map(snapshot));
    if (opts.json) {
      console.log(JSON.stringify({ machines: snaps, notes: statusNotes(snaps, svc) }, null, 2));
      return snaps.every((s) => s.reachable) ? 0 : 1;
    }
    const lines = renderStatus(snaps, { all: opts.all, width: process.stdout.columns || 100, notes: statusNotes(snaps, svc) });
    if (!opts.watch) {
      console.log([...lines, tips].join('\n'));
      return snaps.every((s) => s.reachable) ? 0 : 1;
    }
    const stamp = ui.dim(`Updated ${new Date().toLocaleTimeString()}; refreshing every 5s. Ctrl+C to stop.`);
    // Redraw in place on a terminal; elsewhere, just print each update.
    process.stdout.write(`${process.stdout.isTTY ? '\x1b[2J\x1b[H' : '\n'}${[...lines, tips, stamp].join('\n')}\n`);
    await sleep(5000);
  }
}

/** Find the agent or remote command whose id starts with `ref`, on any machine (or only on `on`). */
async function locate(cfg, ref, on) {
  if (!ref) throw new CliError('Which one? Give an id from: claude-wingman status');
  if (!/^[0-9a-f-]{4,36}$/i.test(ref)) throw new CliError(`"${ref}" isn't an id. Ids are shown by: claude-wingman status`);
  const list = machines(cfg, on ? [on] : []);
  const snaps = await Promise.all(list.map(snapshot));
  const want = ref.toLowerCase();
  const hits = [];
  snaps.forEach((snap, i) => {
    for (const a of snap.agents ?? []) if (a.id.startsWith(want)) hits.push({ kind: 'agent', item: a, m: list[i] });
    for (const c of snap.commands ?? []) if (c.id.startsWith(want)) hits.push({ kind: 'command', item: c, m: list[i] });
  });
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new CliError(`"${ref}" matches ${hits.map((h) => `${h.item.shortId} on ${h.m.name}`).join(' and ')}. Give more of the id.`);
  const down = snaps.filter((s) => !s.reachable).map((s) => s.machine);
  throw new CliError(`Nothing with id ${ref} on ${list.map((m) => m.name).join(', ')}.`, {
    hint: down.length ? `Couldn't check ${down.join(', ')}: unreachable.` : 'See the ids with: claude-wingman status',
  });
}

function setState(conn, id, value) {
  const res = paseo(['agent', 'update', id, '--label', `${STATE_LABEL}=${value}`], { ...conn, timeoutMs: 30_000 });
  if (res.code !== 0) throw new CliError(`Couldn't record the agent's state: ${errorText(res)}`);
}

function interrupt(conn, id) {
  const res = paseo(['stop', id], { ...conn, timeoutMs: 60_000 });
  if (res.code !== 0) throw new CliError(`Couldn't stop the agent: ${errorText(res)}`);
}

const describe = (hit) => `${hit.item.shortId} on ${hit.m.name}${hit.item.title ? ` (${fit(hit.item.title, 60)})` : ''}`;

/** claude-wingman cancel <id> [--on <machine>]: stop an agent for good, or kill a remote command. */
export async function cancel(argv) {
  const { opts, positionals } = parseArgs(argv, { on: 'string' });
  const hit = await locate(requireSelf(), positionals[0], opts.on);
  const { conn } = hit.m;
  if (hit.kind === 'command') {
    // On Windows, closing the terminal alone could let the rest of a command chain run (see stopWindowsCommand).
    const nonce = /^wingman-([0-9a-f]+)/.exec(hit.item.name ?? '')?.[1];
    if (hit.m.peer.os === 'win32' && nonce) await stopWindowsCommand(hit.m, nonce);
    const res = paseo(['terminal', 'kill', hit.item.id], { ...conn, timeoutMs: 30_000 });
    // Already gone (it ended, or whoever started it closed it): stopped all the same.
    if (res.code !== 0 && !/no terminal found/i.test(errorText(res))) throw new CliError(`Couldn't stop the remote command: ${errorText(res)}`);
    ui.ok(`Cancelled the remote command ${describe(hit)}`);
    return 0;
  }
  if (!ACTIVE.has(hit.item.state) && hit.item.state !== 'paused') {
    ui.info(`Agent ${describe(hit)} isn't running (${hit.item.state}); nothing to cancel.`);
    return 0;
  }
  interrupt(conn, hit.item.id);
  setState(conn, hit.item.id, 'cancelled');
  ui.ok(`Cancelled agent ${describe(hit)}`);
  ui.hint(`Its conversation is kept; to carry on anyway: claude-wingman resume ${hit.item.shortId}`);
  return 0;
}

/** claude-wingman pause <id> [--on <machine>]: interrupt an agent, keeping its conversation so it can resume. */
export async function pause(argv) {
  const { opts, positionals } = parseArgs(argv, { on: 'string' });
  const hit = await locate(requireSelf(), positionals[0], opts.on);
  if (hit.kind === 'command') throw new CliError("A remote command can't be paused, only cancelled.", { hint: `claude-wingman cancel ${hit.item.shortId}` });
  if (!ACTIVE.has(hit.item.state)) throw new CliError(`Agent ${describe(hit)} isn't running (${hit.item.state}).`);
  interrupt(hit.m.conn, hit.item.id);
  setState(hit.m.conn, hit.item.id, 'paused');
  ui.ok(`Paused agent ${describe(hit)}`);
  ui.hint(`Whatever it was running was stopped. Resume with: claude-wingman resume ${hit.item.shortId}`);
  return 0;
}

/** claude-wingman resume <id> ["<message>"] [--on <machine>]: let a paused (or finished) agent carry on. */
export async function resume(argv) {
  const { opts, positionals } = parseArgs(argv, { on: 'string' });
  const [ref, ...words] = positionals;
  const hit = await locate(requireSelf(), ref, opts.on);
  if (hit.kind === 'command') throw new CliError("A remote command can't be resumed; run it again.");
  if (ACTIVE.has(hit.item.state)) throw new CliError(`Agent ${describe(hit)} is already ${hit.item.state}.`);
  const message = words.join(' ').trim() || RESUME_MESSAGE;
  setState(hit.m.conn, hit.item.id, '');
  const res = paseo(['send', '--no-wait', hit.item.id, message], { ...hit.m.conn, timeoutMs: 60_000 });
  if (res.code !== 0) {
    if (hit.item.state === 'paused') setState(hit.m.conn, hit.item.id, 'paused');
    throw new CliError(`Couldn't resume the agent: ${errorText(res)}`);
  }
  ui.ok(`Resumed agent ${describe(hit)}`);
  ui.hint(`Follow it: claude-wingman logs ${hit.item.shortId} --follow   Its latest message: claude-wingman logs ${hit.item.shortId} --tail 1`);
  return 0;
}

/** claude-wingman logs <id> [--follow] [--tail <n>] [--on <machine>]: an agent's activity, wherever it runs. */
export async function logs(argv) {
  const follow = argv.includes('-f');
  const { opts, positionals } = parseArgs(argv.filter((a) => a !== '-f'), { follow: 'boolean', tail: 'string', on: 'string' });
  const hit = await locate(requireSelf(), positionals[0], opts.on);
  if (hit.kind === 'command') throw new CliError('Remote commands have no log; their output is shown where they were started.');
  const args = ['logs', hit.item.id];
  if (follow || opts.follow) args.push('--follow');
  if (opts.tail) args.push('--tail', opts.tail);
  ui.info(`Agent ${describe(hit)}, ${hit.item.state}`);
  return paseoInteractive(args, hit.m.conn);
}
````
<!-- END FILE -->

<!-- BEGIN FILE: src/commands/dispatch.js -->
**`src/commands/dispatch.js`**

````js
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
````
<!-- END FILE -->

<!-- BEGIN FILE: src/commands/manage.js -->
**`src/commands/manage.js`**

````js
// claude-wingman skill | unpair | restart | uninstall
import fs from 'node:fs';
import net from 'node:net';
import { parseArgs } from '../args.js';
import { configDir, loadConfig, requirePeer, requireSelf, saveConfig } from '../config.js';
import { paseoEntry, requirePaseo } from '../paseo.js';
import { deleteSecret } from '../secrets.js';
import { removeServices, restartDaemon } from '../service.js';
import { installSkill, removeSkill, renderSkill } from '../skill.js';
import { CliError, IS_WINDOWS, insidePaseoAgent, ui } from '../util.js';

/** Resolve true if a TCP connection to host:port succeeds within timeoutMs. */
export function canConnect(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export function skill() {
  const cfg = requireSelf();
  const names = Object.keys(cfg.peers);
  if (!names.length) return ui.info('No peers, so no skills to write.');
  for (const name of names) ui.ok(`Wrote ${installSkill(name, renderSkill(name, cfg.peers[name]))}`);
}

export function unpair(argv) {
  const { positionals } = parseArgs(argv);
  const [name] = positionals;
  if (!name) throw new CliError('Usage: claude-wingman unpair <peer>');
  const cfg = requireSelf();
  requirePeer(cfg, name);
  delete cfg.peers[name];
  saveConfig(cfg);
  deleteSecret(`peer:${name}`);
  removeSkill(name);
  ui.ok(`Unpaired ${name} (password, config and skill removed). ${name} can still reach this machine until it unpairs too or you run: claude-wingman setup --rotate-password`);
}

export function restart() {
  requireSelf();
  const deferSeconds = insidePaseoAgent() ? 20 : 0;
  restartDaemon({ entry: requirePaseo(), deferSeconds });
  if (deferSeconds) ui.ok(`Daemon restart scheduled in ~${deferSeconds}s`);
  else if (IS_WINDOWS) ui.ok('Daemon restart started (Task Scheduler); it is back in a few seconds');
  else ui.ok('Daemon restarted');
}

export function uninstall(argv) {
  const { opts } = parseArgs(argv, { yes: 'boolean' });
  if (insidePaseoAgent()) {
    throw new CliError("Uninstall stops the daemon this agent runs under, so it can't run from a dispatched agent.", { hint: 'Run it in a terminal on this machine.' });
  }
  if (!opts.yes) {
    throw new CliError('This removes autostart, keep-awake, stored passwords, paired peers and their skills.', {
      hint: 'Run again with --yes to confirm. (Paseo itself stays installed: npm rm -g @getpaseo/cli)',
    });
  }
  const cfg = loadConfig();
  let entry = null;
  try {
    entry = paseoEntry();
  } catch {} // npm missing: still remove everything else
  removeServices({ entry });
  ui.ok('Removed autostart and keep-awake; daemon stopped');
  for (const name of Object.keys(cfg.peers)) {
    deleteSecret(`peer:${name}`);
    if (removeSkill(name)) ui.ok(`Removed skill ${name}`);
  }
  deleteSecret('self');
  fs.rmSync(configDir(), { recursive: true, force: true });
  ui.ok('Removed passwords and configuration');
}
````
<!-- END FILE -->

<!-- BEGIN FILE: src/commands/remote.js -->
**`src/commands/remote.js`**

````js
// Manage paired machines from this one, through remote terminals (see remote.js):
//   claude-wingman remote <machine>|--all <claude-wingman command...>
//   claude-wingman run <machine>|--all [--cwd <dir>] [--timeout 10m] -- <command>   any command, for the user
//   claude-wingman update [<machine>...]          install this machine's version everywhere
// plus introducing a newly paired machine to the others, and re-sharing a rotated password.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../args.js';
import { loadConfig, requireSelf, saveConfig } from '../config.js';
import { remoteExec, quoteArg } from '../remote.js';
import { paseo } from '../paseo.js';
import { bundleFor, serveOnce } from '../share.js';
import { CliError, IS_WINDOWS, VERSION, run, sleep, ui } from '../util.js';
import { canConnect } from './manage.js';
import { peerConnection } from './dispatch.js';
import { parseDuration, resolveRepoPath } from '../dispatch.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** "claude-wingman <args>" quoted for the machine's shell. */
const wingman = (args, osName) => ['claude-wingman', ...args.map((a) => quoteArg(a, osName))].join(' ');

const indent = (text) => text.split('\n').map((l) => `    ${l}`).join('\n');

function targetsFrom(cfg, names) {
  const all = Object.keys(cfg.peers);
  if (!all.length) throw new CliError('No paired machines yet.', { hint: 'Pair one first: claude-wingman pair' });
  return names.length ? names.map((n) => (peerConnection(cfg, n), n)) : all;
}

/** claude-wingman remote <machine>|--all <claude-wingman args...> */
export async function remote(argv) {
  const [target, ...args] = argv;
  if (!target || !args.length) {
    throw new CliError('Usage: claude-wingman remote <machine>|--all <claude-wingman command>', { hint: 'e.g. claude-wingman remote msi verify   or   claude-wingman remote --all version' });
  }
  const cfg = requireSelf();
  const names = target === '--all' ? targetsFrom(cfg, []) : [target];
  let failed = 0;
  for (const name of names) {
    const t = peerConnection(cfg, name);
    ui.step(`${name}: claude-wingman ${args.join(' ')}`);
    try {
      const res = await remoteExec(t, wingman(args, t.peer.os), { timeoutSeconds: 900, label: `from ${cfg.self.name}: claude-wingman ${args.join(' ')}` });
      if (res.output.trim()) console.log(res.output.replace(/^\n+/, ''));
      if (!res.ok) failed++;
      if (scheduledRestart(res.output)) {
        ui.info(`Waiting for ${name}'s daemon to restart ...`);
        if (await waitForDaemon(name)) ui.ok(`${name} is back`);
        else {
          ui.fail(`${name}'s daemon didn't come back. Check: claude-wingman status`);
          failed++;
        }
      }
    } catch (err) {
      if (!(err instanceof CliError)) throw err;
      ui.fail(err.message);
      if (err.hint) ui.hint(err.hint);
      failed++;
    }
  }
  return failed ? 1 : 0;
}

const RUN_USAGE = 'Usage: claude-wingman run <machine>|--all [--cwd <dir>] [--timeout 10m] -- <command>';

/**
 * Split `run` arguments into our options and the command. Everything after `--` is the command; without `--`, the
 * command starts at the first word that isn't one of our options, so `run msi git log --oneline` works too.
 */
export function parseRunArgs(argv) {
  const sep = argv.indexOf('--');
  let head;
  let command;
  if (sep !== -1) {
    head = argv.slice(0, sep);
    command = argv.slice(sep + 1);
  } else {
    let i = 0;
    let target = false;
    let sawAll = false;
    // The target (unless --all), then any of our options; the first other word starts the command.
    for (; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--all') sawAll = true;
      else if (a === '--cwd' || a === '--timeout') i++;
      else if (/^--(cwd|timeout)=/.test(a)) continue;
      else if (!target && !sawAll && !a.startsWith('-')) target = true;
      else break;
    }
    head = argv.slice(0, i);
    command = argv.slice(i);
  }
  const { opts, positionals } = parseArgs(head, { all: 'boolean', cwd: 'string', timeout: 'string' });
  if (positionals.length > 1) throw new CliError(`Put the command after --: claude-wingman run ${positionals[0]} -- ${positionals.slice(1).join(' ')} ...`);
  const text = command.join(' ').trim();
  if ((!positionals[0] && !opts.all) || (positionals[0] && opts.all) || !text) throw new CliError(RUN_USAGE, { hint: 'e.g. claude-wingman run msi -- git -C myapp status' });
  return { target: positionals[0], all: Boolean(opts.all), cwd: opts.cwd, timeoutSeconds: parseDuration(opts.timeout ?? '10m'), command: text };
}

/**
 * claude-wingman run <machine>|--all ... -- <command>: run a shell command there (cmd.exe on Windows, sh elsewhere)
 * and print its output. Like SSH, for the user: it runs with the user's rights and without the safety checks a
 * dispatched agent has, which is why the skills tell Claude to use `dispatch` instead.
 * With one machine, only the command's output is printed (so it can be piped); the exit code is 0 or 1.
 */
export async function runCommand(argv) {
  const { target, all, cwd, timeoutSeconds, command } = parseRunArgs(argv);
  const cfg = requireSelf();
  const names = all ? targetsFrom(cfg, []) : [target];
  let failed = 0;
  for (const name of names) {
    const t = peerConnection(cfg, name);
    if (all) ui.step(`${name}: ${command}`);
    try {
      const res = await remoteExec(t, command, {
        timeoutSeconds,
        cwd: cwd ? resolveRepoPath(t.peer, cwd, '--cwd') : t.peer.home,
        label: `from ${cfg.self.name}: run ${command}`,
      });
      if (res.output) process.stdout.write(`${res.output}\n`);
      if (!res.ok) {
        failed++;
        if (all) ui.fail(`Failed on ${name}`);
      }
    } catch (err) {
      if (!(err instanceof CliError)) throw err;
      ui.fail(err.message);
      if (err.hint) ui.hint(err.hint);
      failed++;
    }
  }
  return failed ? 1 : 0;
}

const scheduledRestart = (output) => /restarts in ~\d+s/.test(output);

/**
 * After a command there scheduled a (deferred) daemon restart: wait until the new daemon answers with the password
 * this machine now holds for it. Until the restart, the old daemon still runs (with the old password, if it changed).
 */
async function waitForDaemon(name, seconds = 120) {
  const deadline = Date.now() + seconds * 1000;
  await sleep(22_000);
  while (Date.now() < deadline) {
    const { peer, conn } = peerConnection(loadConfig(), name); // re-read: the password may have just changed
    if ((await canConnect(peer.host, peer.port, 3000)) && paseo(['ls', '--json'], { ...conn, timeoutMs: 30_000 }).code === 0) return true;
    await sleep(3000);
  }
  return false;
}

/** claude-wingman update [<machine>...]: install this machine's exact version on paired machines. */
export async function update(argv) {
  const cfg = requireSelf();
  const names = targetsFrom(cfg, parseArgs(argv).positionals);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-wingman-update-'));
  try {
    const pack = run('npm', ['pack', PACKAGE_ROOT, '--pack-destination', dir].map((a) => (IS_WINDOWS ? `"${a}"` : a)), { shell: IS_WINDOWS, timeoutMs: 300_000 });
    const tarball = fs.readdirSync(dir).find((f) => f.endsWith('.tgz'));
    if (pack.code !== 0 || !tarball) throw new CliError(`Packing claude-wingman failed: ${pack.stderr || pack.stdout}`);
    ui.info(`Installing claude-wingman ${VERSION} from this machine on: ${names.join(', ')}`);
    let failed = 0;
    await serveOnce(cfg.self.host, tarball, fs.readFileSync(path.join(dir, tarball)), async (url) => {
      for (const name of names) {
        const t = peerConnection(cfg, name);
        ui.step(`${name} (${t.peer.machine})`);
        try {
          // The new version's own setup applies any service changes; its restart waits until this terminal is done.
          // npm 12 refuses tarball URLs unless allowed; older npm accepts the option silently.
          const res = await remoteExec(t, `npm install -g --allow-remote=all ${url} && ${wingman(['setup', '--defer-restart'], t.peer.os)} && ${wingman(['skill'], t.peer.os)}`, { timeoutSeconds: 900, label: `from ${cfg.self.name}: update to ${VERSION}` });
          if (!res.ok) {
            ui.fail(`Update failed on ${name}:`);
            console.log(indent(res.output.split('\n').slice(-15).join('\n')));
            failed++;
            continue;
          }
          if (scheduledRestart(res.output) && !(await waitForDaemon(name))) {
            ui.fail(`${name}'s daemon didn't come back after the restart. On ${name}: claude-wingman restart`);
            failed++;
            continue;
          }
          const ver = await remoteExec(t, wingman(['version'], t.peer.os), { timeoutSeconds: 120, label: `from ${cfg.self.name}: claude-wingman version` });
          if (ver.ok && ver.output.trim() === VERSION) {
            ui.ok(`${name} runs claude-wingman ${VERSION}`);
            const now = loadConfig(); // fresh: the restart wait may have reloaded a new password
            if (now.peers[name]) {
              now.peers[name].version = VERSION;
              saveConfig(now);
            }
          }
          else {
            ui.fail(`${name} reports version "${ver.output.trim()}", expected ${VERSION}`);
            failed++;
          }
        } catch (err) {
          if (!(err instanceof CliError)) throw err;
          ui.fail(`${name}: ${err.message}`);
          if (err.hint) ui.hint(err.hint);
          failed++;
        }
      }
    }, { once: false });
    return failed ? 1 : 0;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Hand `bundle` to machine `t` through its remote terminal (pair --from-url). Returns the remote result. */
async function handOver(cfg, t, bundle) {
  return serveOnce(cfg.self.host, 'credentials.json', Buffer.from(JSON.stringify(bundle)), (url) =>
    remoteExec(t, wingman(['pair', '--from-url', url], t.peer.os), { timeoutSeconds: 180, label: `from ${cfg.self.name}: pairing` }));
}

const tooOld = (res) => /Unknown option --from-url/.test(res.output);

function reportHandOver(res, what, where) {
  if (res.ok) return true;
  ui.fail(`${what} failed on ${where}:`);
  console.log(indent(res.output.split('\n').slice(-6).join('\n')));
  if (tooOld(res)) ui.hint(`${where} runs an older claude-wingman; update it first: claude-wingman update ${where}`);
  return false;
}

/**
 * After pairing with `newName`, pair it with this machine's other paired machines too, so adding a machine never
 * means visiting the existing ones. This machine knows both sides' credentials, so it hands each to the other.
 */
export async function introduce(newName) {
  const cfg = loadConfig();
  const others = Object.keys(cfg.peers).filter((n) => n !== newName);
  if (!others.length) return true;
  ui.step(`Pairing ${newName} with your other machines (${others.join(', ')})`);
  const x = peerConnection(cfg, newName);
  let allOk = true;
  for (const name of others) {
    const p = peerConnection(cfg, name);
    try {
      const ok = reportHandOver(await handOver(cfg, p, bundleFor(cfg, newName)), `Adding ${newName}`, name)
        && reportHandOver(await handOver(cfg, x, bundleFor(cfg, name)), `Adding ${name}`, newName);
      if (ok) ui.ok(`${newName} and ${name} are paired`);
      allOk &&= ok;
    } catch (err) {
      if (!(err instanceof CliError)) throw err;
      allOk = false;
      ui.fail(`Pairing ${newName} with ${name}: ${err.message}`);
    }
  }
  return allOk;
}

/** After this machine's password changed: give every paired machine the new one, through its remote terminal. */
export async function resharePassword() {
  const cfg = loadConfig();
  const names = Object.keys(cfg.peers);
  if (!names.length) return true;
  ui.step(`Sharing the new password with ${names.join(', ')}`);
  let allOk = true;
  for (const name of names) {
    try {
      const ok = reportHandOver(await handOver(cfg, peerConnection(cfg, name), bundleFor(cfg)), 'Taking the new password', name);
      if (ok) ui.ok(`${name} has the new password`);
      allOk &&= ok;
    } catch (err) {
      if (!(err instanceof CliError)) throw err;
      allOk = false;
      ui.fail(`${name}: ${err.message}`);
    }
  }
  if (!allOk) ui.hint(`For the others, run "claude-wingman pair ${cfg.self.machine}" on them and "claude-wingman pair <machine>" here.`);
  return allOk;
}
````
<!-- END FILE -->

<!-- BEGIN FILE: src/commands/verify.js -->
**`src/commands/verify.js`**

````js
// claude-wingman verify | doctor
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from '../args.js';
import { loadConfig, requireSelf } from '../config.js';
import { finalReport, startAgent, waitAgent } from '../dispatch.js';
import { PASEO_INSTALL, PASEO_VERSION, errorText, paseo, paseoEntry, paseoVersion, passwordMatchesDaemon, readDaemonConfig } from '../paseo.js';
import { getSecret } from '../secrets.js';
import { serviceStatus } from '../service.js';
import { skillsDir, SKILL_MARKER } from '../skill.js';
import { status as tailscaleStatus, tailscaleBin } from '../tailscale.js';
import { IS_LINUX, IS_MAC, IS_WINDOWS, SUPPORTED_OSES, isWindowsToolOnWsl, nodeIsSupported, run, ui, which } from '../util.js';
import { canConnect } from './manage.js';
import { peerConnection } from './dispatch.js';
import { quoteArg, remoteExec } from '../remote.js';

function checker() {
  const results = { pass: 0, fail: 0 };
  const check = (ok, label, hint) => {
    if (ok) {
      results.pass++;
      ui.ok(label);
    } else {
      results.fail++;
      ui.fail(label);
      if (hint) ui.hint(hint);
    }
    return ok;
  };
  return { check, results };
}

/** Connect to our own daemon the way a remote client would: no local credential file. */
function probeAuth(host, password) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-wingman-probe-'));
  try {
    const res = paseo(['ls', '--json'], { host, password, isolatedHome: home, timeoutMs: 30_000 });
    return { ok: res.code === 0, text: `${res.stderr}\n${res.stdout}` };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function verifyPeer(name, cfg, check, roundTrip) {
  const { peer, conn } = peerConnection(cfg, name);
  if (!check(await canConnect(peer.host, peer.port), `Reachable at ${conn.host}`, 'Is it awake and on Tailscale?')) return;
  const ls = paseo(['ls', '--json'], { ...conn, timeoutMs: 30_000 });
  check(ls.code === 0, 'Password accepted', `${errorText(ls)}  (re-pair: claude-wingman pair ${peer.machine})`);
  const skillFile = path.join(skillsDir(), name, 'SKILL.md');
  check(fs.existsSync(skillFile) && fs.readFileSync(skillFile, 'utf8').includes(SKILL_MARKER), `Skill installed (${skillFile})`, 'Run: claude-wingman skill');
  if (!roundTrip || ls.code !== 0) return;
  const id = startAgent(conn, {
    cwd: peer.home,
    title: `${cfg.self.name}: claude-wingman verify`,
    prompt: 'Connectivity check from claude-wingman verify. Do not run any tools. Reply with exactly: CLAUDE_WINGMAN_OK',
  });
  const st = waitAgent(conn, id, 180);
  const report = st === 'idle' ? finalReport(conn, id) : '';
  check(/CLAUDE_WINGMAN_OK/.test(report), `Round trip: an agent ran on ${name} and replied`, `status ${st}; see: claude-wingman ${name} logs ${id}`);
  paseo(['archive', id], { ...conn, timeoutMs: 30_000 });
}

export async function verify(argv) {
  const { opts } = parseArgs(argv, { 'round-trip': 'boolean' });
  const cfg = requireSelf();
  const { check, results } = checker();
  const s = cfg.self;
  const host = `${s.host}:${s.port}`;

  ui.step(`This machine (${s.name})`);
  let ts;
  try {
    ts = tailscaleStatus();
  } catch (err) {
    check(false, `Tailscale connected: ${err.message}`);
  }
  if (ts) check(ts.self.ip === s.host, `Tailscale IP is still ${s.host}`, `It is now ${ts.self.ip}; run: claude-wingman setup`);
  const daemon = readDaemonConfig()?.daemon ?? {};
  check(daemon.listen === host, `Daemon configured to listen on ${host} only`, 'Run: claude-wingman setup');
  check(daemon.relay?.enabled === false, 'Paseo relay disabled', 'Run: claude-wingman setup');
  check(passwordMatchesDaemon(getSecret('self')), 'Stored password matches the daemon', 'Run: claude-wingman setup');
  check(await canConnect(s.host, s.port), `Daemon accepting connections on ${host}`, 'Run: claude-wingman restart');
  check(!(await canConnect('127.0.0.1', s.port, 1500)), `Not exposed on localhost:${s.port}`);
  const noPw = probeAuth(host, undefined);
  check(!noPw.ok && /password required/i.test(noPw.text), 'Refuses a client with no password');
  const wrongPw = probeAuth(host, 'definitely-not-the-password');
  check(!wrongPw.ok && /incorrect password/i.test(wrongPw.text), 'Refuses a wrong password');
  check(probeAuth(host, getSecret('self')).ok, 'Accepts the right password');
  const svc = serviceStatus();
  check(svc.autostart, 'Daemon starts automatically', 'Run: claude-wingman setup');
  if (svc.wsl) check(svc.wsl.running, `WSL kept running, and started with Windows: ${svc.wsl.detail}`, 'Run: claude-wingman setup');
  if (svc.awake === null) ui.warn(`Keep-awake: ${svc.awakeDetail}`);
  else check(svc.awake, `Kept awake (${svc.awakeDetail})`, 'Run: claude-wingman setup');
  // macOS privacy protection keeps processes under launchd out of ~/Documents, ~/Desktop and ~/Downloads, so a
  // repos folder there is invisible to dispatched agents. Ask the daemon itself, through one of its terminals.
  if (IS_MAC && (await canConnect(s.host, s.port))) {
    try {
      const res = await remoteExec({ peer: { ...s, machine: 'this machine' }, conn: { host, password: getSecret('self') } },
        `ls ${quoteArg(s.reposRoot, 'darwin')} >/dev/null`, { timeoutSeconds: 60, label: 'verify: repos folder check' });
      check(res.ok, `Dispatched agents can read ${s.reposRoot}`,
        'macOS keeps background processes out of ~/Documents, ~/Desktop and ~/Downloads. Keep repos elsewhere (e.g. ~/src), or give node Full Disk Access in System Settings > Privacy & Security.');
    } catch (err) {
      check(false, `Dispatched agents can read ${s.reposRoot}`, err.message);
    }
  }
  // The service runs the node binary that ran setup; an nvm/Homebrew upgrade can remove it.
  if (s.node) check(fs.existsSync(s.node), `Daemon's Node.js still installed (${s.node})`, 'Node was upgraded or removed; run: claude-wingman setup');
  const paseoHere = paseoVersion();
  if (paseoHere && paseoHere !== PASEO_VERSION) ui.warn(`Paseo ${paseoHere}; claude-wingman is tested with ${PASEO_VERSION}. To switch: ${PASEO_INSTALL}, then: claude-wingman restart`);

  for (const name of Object.keys(cfg.peers)) {
    const peer = cfg.peers[name];
    ui.step(`Peer ${name} (${peer.machine})`);
    try {
      await verifyPeer(name, cfg, check, opts['round-trip']);
    } catch (err) {
      check(false, `Checking ${name} failed: ${err.message}`, err.hint);
    }
  }

  console.log(`\n${results.fail ? ui.bold(`${results.fail} check(s) failed`) : ui.bold('All checks passed')}, ${results.pass} passed.`);
  return results.fail ? 1 : 0;
}

export function doctor() {
  const { check, results } = checker();
  ui.step('Prerequisites');
  check(SUPPORTED_OSES.includes(process.platform), `Supported OS (${process.platform})`, 'claude-wingman supports macOS, Windows and Linux.');
  check(nodeIsSupported(), `Node.js ${process.version}`, 'Install Node.js 20.11 or newer.');
  check(Boolean(which('git')), 'git on PATH', IS_MAC ? 'Install: xcode-select --install' : IS_WINDOWS ? 'Install: winget install --id Git.Git -e' : 'Install git with your package manager (e.g. sudo apt install git)');
  const claude = which('claude');
  check(Boolean(claude), 'Claude Code on PATH', 'Install and sign in: https://code.claude.com/docs/en/setup');
  for (const tool of ['claude', 'npm']) {
    if (isWindowsToolOnWsl(which(tool))) check(false, `${tool} is the Linux one (found the Windows ${which(tool)})`, tool === 'npm' ? 'Install Node.js inside WSL, e.g. with nvm' : 'Install Claude Code inside WSL');
  }
  if (claude) ui.hint(run(claude, ['--version']).stdout);
  const tsBin = tailscaleBin({ required: false });
  check(Boolean(tsBin), 'Tailscale installed', IS_WINDOWS ? 'Install: winget install --id Tailscale.Tailscale -e'
    : IS_LINUX ? 'Install: curl -fsSL https://tailscale.com/install.sh | sh' : 'Install the standalone .pkg from https://tailscale.com/download');
  if (tsBin) {
    try {
      const ts = tailscaleStatus();
      check(true, `Tailscale connected (${ts.self.name}, ${ts.self.ip})`);
    } catch (err) {
      check(false, `Tailscale connected`, err.message);
    }
  }
  check(Boolean(paseoEntry()), 'Paseo installed', 'claude-wingman setup installs it');
  const paseoAt = paseoVersion();
  if (paseoAt && paseoAt !== PASEO_VERSION) ui.warn(`Paseo ${paseoAt}; claude-wingman is tested with ${PASEO_VERSION}. To switch: ${PASEO_INSTALL}`);
  const cfg = loadConfig();
  check(Boolean(cfg.self), cfg.self ? `Set up as "${cfg.self.name}"` : 'Set up', 'Run: claude-wingman setup');
  console.log(`\n${results.fail ? `${results.fail} item(s) need attention` : 'Ready'}.`);
  return results.fail ? 1 : 0;
}
````
<!-- END FILE -->

<!-- BEGIN FILE: test/core.test.js -->
**`test/core.test.js`**

````js
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from '../src/args.js';
import { loadConfig, requirePeer, requireSelf, saveConfig, validateName } from '../src/config.js';
import { dispatch } from '../src/commands/dispatch.js';
import { nodeIsSupported } from '../src/util.js';
import { makeBundle, parseBundle } from '../src/bundle.js';
import { isTailscaleIp } from '../src/tailscale.js';
import { buildPrompt, parseDuration, resolveRepoPath } from '../src/dispatch.js';
import { defaultReposRoot, defaultSelfName, generatePassword } from '../src/commands/setup.js';
import { pairCandidates, peerAlias } from '../src/commands/pair.js';
import { ask, chooseMany, interactive, parseSelection } from '../src/prompt.js';
import { toName } from '../src/config.js';
import { isNpxPath } from '../src/self-install.js';
import { systemdQuote, systemdUnit } from '../src/service.js';
import { CliError } from '../src/util.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cp-test-'));

test('parseArgs: flags, values, booleans, positionals and --', () => {
  const spec = { repo: 'string', detach: 'boolean' };
  assert.deepEqual(parseArgs(['msi', '--repo', 'app', 'run', 'tests'], spec), { opts: { repo: 'app' }, positionals: ['msi', 'run', 'tests'] });
  assert.deepEqual(parseArgs(['--repo=a=b', '--detach'], spec).opts, { repo: 'a=b', detach: true });
  assert.deepEqual(parseArgs(['x', '--', '--repo', 'y'], spec).positionals, ['x', '--repo', 'y']);
  assert.deepEqual(parseArgs(['-', '-n'], spec).positionals, ['-', '-n']);
  assert.throws(() => parseArgs(['--nope'], spec), /Unknown option --nope/);
  assert.throws(() => parseArgs(['--repo'], spec), /needs a value/);
  assert.throws(() => parseArgs(['--repo='], spec), /needs a value/);
  assert.throws(() => parseArgs(['--detach=1'], spec), /doesn't take a value/);
});

test('validateName accepts simple names and rejects bad ones and command words', () => {
  for (const ok of ['mac', 'msi', 'work-pc2', 'a']) assert.equal(validateName(ok), ok);
  for (const bad of ['', 'Mac', '1pc', 'my pc', 'a_b', 'x'.repeat(32), undefined]) assert.throws(() => validateName(bad), CliError);
  for (const cmd of ['setup', 'pair', 'dispatch', 'peers']) assert.throws(() => validateName(cmd), /is a claude-wingman command/);
});

test('config: missing file, save/load round trip, private permissions, requireSelf', () => {
  process.env.CLAUDE_WINGMAN_HOME = tmp();
  assert.deepEqual(loadConfig(), { version: 1, self: null, peers: {} });
  assert.throws(() => requireSelf(), /not set up/);
  const cfg = { version: 1, self: { name: 'mac' }, peers: { msi: { host: '100.64.0.2' } } };
  saveConfig(cfg);
  assert.deepEqual(loadConfig(), cfg);
  assert.equal(requireSelf().self.name, 'mac');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(process.env.CLAUDE_WINGMAN_HOME, 'config.json')).mode & 0o777, 0o600);
  }
  delete process.env.CLAUDE_WINGMAN_HOME;
});

test('isTailscaleIp only accepts 100.64.0.0/10', () => {
  for (const ok of ['100.64.0.1', '100.64.0.71', '100.127.255.255']) assert.ok(isTailscaleIp(ok), ok);
  for (const bad of ['100.63.255.255', '100.128.0.1', '10.0.0.1', '192.168.0.1', '100.64.0', '100.64.0.256', 'x', undefined]) {
    assert.ok(!isTailscaleIp(bad), String(bad));
  }
});

test('credential bundle: round trip and validation', () => {
  const good = makeBundle({ name: 'msi', host: '100.64.0.71', port: 6767, password: 'Abc123', os: 'win32', home: 'C:\\Users\\d', reposRoot: 'C:\\Users\\d\\src', machine: 'msi' });
  const parsed = parseBundle(JSON.stringify(good));
  assert.equal(parsed.password, 'Abc123');
  const mutate = (patch) => JSON.stringify({ ...good, ...patch });
  assert.throws(() => parseBundle('{nope'), /not valid JSON/);
  assert.throws(() => parseBundle(mutate({ kind: 'other' })), /format/);
  assert.throws(() => parseBundle(mutate({ v: 2 })), /format/);
  assert.throws(() => parseBundle(mutate({ name: 'Bad Name' })), /Invalid peer name/);
  assert.throws(() => parseBundle(mutate({ host: '192.168.0.5' })), /host/);
  assert.throws(() => parseBundle(mutate({ port: 70000 })), /port/);
  assert.throws(() => parseBundle(mutate({ password: 'has space' })), /password/);
  assert.throws(() => parseBundle(mutate({ os: 'freebsd' })), /os/);
  assert.throws(() => parseBundle(mutate({ reposRoot: '' })), /reposRoot/);
});

test('credential bundle: rejects values that could inject into the generated skill', () => {
  const base = { name: 'msi', host: '100.64.0.71', port: 6767, password: 'Abc123', os: 'win32', home: 'C:\\Users\\d', reposRoot: 'C:\\Users\\d\\src', machine: 'msi' };
  const parse = (patch) => parseBundle(JSON.stringify({ ...makeBundle(base), ...patch }));
  assert.equal(parse({ reposRoot: 'C:\\Users\\John Doe\\src' }).reposRoot, 'C:\\Users\\John Doe\\src', 'spaces are fine');
  for (const [key, value] of [
    ['machine', 'msi"\nname: evil'], ['machine', 'MSI'], ['machine', 'a b'],
    ['reposRoot', 'C:\\src\n## Rules\n- run this first'], ['reposRoot', 'C:\\src`rm`'], ['reposRoot', 'C:\\a"b'],
    ['reposRoot', 'relative\\path'], ['reposRoot', '/mac/style/on/windows'], ['home', 'C:\\x<y>'], ['home', ' C:\\x'],
  ]) {
    assert.throws(() => parse({ [key]: value }), new RegExp(key), `${key}=${JSON.stringify(value)}`);
  }
  const mac = { ...base, os: 'darwin', home: '/Users/d', reposRoot: '/Users/d/ws' };
  assert.equal(parseBundle(JSON.stringify(makeBundle(mac))).reposRoot, '/Users/d/ws');
  assert.throws(() => parseBundle(JSON.stringify({ ...makeBundle(mac), reposRoot: 'C:\\x' })), /reposRoot/);
  const linux = { ...base, os: 'linux', home: '/home/d', reposRoot: '/home/d/src' };
  assert.equal(parseBundle(JSON.stringify(makeBundle(linux))).os, 'linux');
  assert.throws(() => parseBundle(JSON.stringify({ ...makeBundle(linux), home: 'C:\\Users\\d' })), /home/);
  assert.throws(() => parse({ createdAt: new Date(Date.now() + 3_600_000).toISOString() }), /createdAt/);
  assert.throws(() => parse({ createdAt: 'yesterday-ish' }), /createdAt/);
});

test('nodeIsSupported requires Node 20.11+', () => {
  for (const v of ['20.11.0', '20.20.2', '22.0.0', '24.21.0']) assert.ok(nodeIsSupported(v), v);
  for (const v of ['18.20.0', '20.10.0', '20.0.0']) assert.ok(!nodeIsSupported(v), v);
});

test('peer lookup ignores inherited object keys', () => {
  const cfg = { self: { name: 'mac' }, peers: { msi: { host: '100.64.0.1' } } };
  assert.equal(requirePeer(cfg, 'msi').host, '100.64.0.1');
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) assert.throws(() => requirePeer(cfg, name), /Unknown peer/);
});

test('defaultSelfName: "mac" on macOS, a cleaned Tailscale name on Windows', () => {
  assert.equal(defaultSelfName('my-macbook-air', 'darwin'), 'mac');
  assert.equal(defaultSelfName('msi', 'win32'), 'msi');
  assert.equal(defaultSelfName('DESKTOP-ABC123', 'win32'), 'desktop-abc123');
  assert.equal(defaultSelfName('Dan’s PC!', 'win32'), 'dan-s-pc');
  assert.equal(defaultSelfName('123', 'win32'), 'pc', 'must start with a letter');
  assert.equal(defaultSelfName('setup', 'win32'), 'pc', 'command words are not allowed');
  assert.equal(defaultSelfName(undefined, 'win32'), 'pc');
  assert.equal(defaultSelfName('build-box', 'linux'), 'build-box');
  assert.equal(defaultSelfName('42', 'linux'), 'linux');
});

test('toName cleans free text into a valid name, or null', () => {
  assert.equal(toName('Work PC'), 'work-pc');
  assert.equal(toName('msi.'), 'msi');
  assert.equal(toName('a'.repeat(40) + '-x'), 'a'.repeat(31));
  assert.equal(toName('123'), null);
  assert.equal(toName('status'), null, 'command words are not allowed');
});

test('defaultReposRoot: first common repos folder that exists, else home', () => {
  const home = path.join(os.tmpdir(), 'h');
  const at = (f) => path.join(home, f);
  assert.equal(defaultReposRoot(home, (p) => p === at('ws') || p === at('code')), at('code'));
  assert.equal(defaultReposRoot(home, (p) => p === at('ws')), at('ws'));
  assert.equal(defaultReposRoot(home, () => false), home);
});

test('pairCandidates: your own online computers with an IPv4 only', () => {
  const me = 1;
  const peers = [
    { name: 'msi', os: 'windows', ip: '100.64.0.1', online: true, userId: me },
    { name: 'old-pc', os: 'windows', ip: '100.64.0.2', online: false, userId: me },
    { name: 'phone', os: 'iOS', ip: '100.64.0.3', online: true, userId: me },
    { name: 'box', os: 'linux', ip: '100.64.0.4', online: true, userId: me },
    { name: 'air', os: 'macOS', ip: '100.64.0.5', online: true, userId: me },
    { name: 'v6only', os: 'macOS', ip: undefined, online: true, userId: me },
    { name: 'friends-pc', os: 'windows', ip: '100.64.0.6', online: true, userId: 2, shared: true },
    { name: 'tagged-server', os: 'linux', ip: '100.64.0.7', online: true, userId: 3 },
  ];
  assert.deepEqual(pairCandidates(peers, { userId: me }).map((m) => m.name), ['msi', 'box', 'air']);
});

test('peerAlias: own name if free; else its Tailscale name, then a number; stable on re-pair', () => {
  const cfg = { self: { name: 'mac' }, peers: { msi: { host: '100.64.0.2', machine: 'msi' } } };
  const bundle = (name, host, machine) => ({ name, host, machine });
  assert.equal(peerAlias(bundle('linux', '100.64.0.3', 'msi-wsl'), cfg), 'linux');
  assert.equal(peerAlias(bundle('mac', '100.64.0.4', 'work-air'), cfg), 'work-air', 'two Macs both called "mac"');
  assert.equal(peerAlias(bundle('msi', '100.64.0.5', 'msi'), cfg), 'msi-2', 'name and Tailscale name both taken');
  assert.equal(peerAlias(bundle('renamed', '100.64.0.2', 'msi'), cfg), 'msi', 're-pairing keeps the existing name');
  assert.equal(peerAlias(bundle('mac', '100.64.0.4', 'x'), cfg, 'air2'), 'air2');
  assert.throws(() => peerAlias(bundle('a', '100.64.0.4', 'x'), cfg, 'mac'), /own name/);
  assert.throws(() => peerAlias(bundle('a', '100.64.0.4', 'x'), cfg, 'msi'), /already the name/);
});

test('parseSelection: all, single and lists of numbers', () => {
  assert.deepEqual(parseSelection('all', 3), [0, 1, 2]);
  assert.deepEqual(parseSelection(' 2 ', 3), [1]);
  assert.deepEqual(parseSelection('1,3 3', 3), [0, 2]);
  assert.throws(() => parseSelection('4', 3), /numbers from 1 to 3/);
  assert.throws(() => parseSelection('x', 3), /numbers from 1 to 3/);
});

test('systemd units quote paths and escape % and quotes', () => {
  assert.equal(systemdQuote('/a b/c'), '"/a b/c"');
  assert.equal(systemdQuote('50%'), '"50%%"');
  assert.equal(systemdQuote('a"b\\c'), '"a\\"b\\\\c"');
  const unit = systemdUnit({ description: 'd', program: ['/usr/bin/node', '/p q/paseo', 'daemon', 'run'], env: { PATH: '/x:/y' } });
  assert.match(unit, /^ExecStart="\/usr\/bin\/node" "\/p q\/paseo" "daemon" "run"$/m);
  assert.match(unit, /^Environment="PATH=\/x:\/y"$/m);
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^WantedBy=default.target$/m);
});

test('isNpxPath spots npx cache locations', () => {
  assert.ok(isNpxPath('/Users/u/.npm/_npx/1a2b/node_modules/claude-wingman'));
  assert.ok(isNpxPath('C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\1a2b\\node_modules\\claude-wingman'));
  assert.ok(!isNpxPath('/usr/local/lib/node_modules/claude-wingman'));
});

test('prompts fall back to defaults without a terminal (agents, scripts)', async () => {
  assert.equal(interactive(), false, 'tests run without a TTY');
  assert.equal(await ask('Name?', 'mac', (v) => validateName(v)), 'mac');
  await assert.rejects(chooseMany('Which?', [{ n: 'a' }, { n: 'b' }], (m) => m.n, { hint: 'name them' }), /Several machines are online: a, b/);
});

test('dispatch guards --branch before touching anything', async () => {
  await assert.rejects(dispatch(['msi', '--branch', 'main', '--repo', 'app', 'run tests']), /use a separate one/);
  await assert.rejects(dispatch(['msi', '--branch', 'master', '--repo', 'app', 'x']), /use a separate one/);
  await assert.rejects(dispatch(['msi', '--branch', 'msi-test/x', 'run tests']), /--branch needs --repo/);
  await assert.rejects(dispatch(['msi', '--branch', 'bad branch;rm', '--repo', 'app', 'x']), /Invalid branch name/);
  await assert.rejects(dispatch(['msi']), /Usage: claude-wingman dispatch/);
});

test('resolveRepoPath uses the peer path style', () => {
  const win = { os: 'win32', home: 'C:\\Users\\d', reposRoot: 'C:\\Users\\d\\src\\' };
  const mac = { os: 'darwin', home: '/Users/d', reposRoot: '/Users/d/ws' };
  assert.equal(resolveRepoPath(win, undefined), 'C:\\Users\\d');
  assert.equal(resolveRepoPath(win, 'app'), 'C:\\Users\\d\\src\\app');
  assert.equal(resolveRepoPath(win, 'D:\\code\\x'), 'D:\\code\\x');
  assert.equal(resolveRepoPath(mac, 'app'), '/Users/d/ws/app');
  assert.equal(resolveRepoPath(mac, '/opt/x'), '/opt/x');
  assert.throws(() => resolveRepoPath(mac, 'a/b'), /folder name/);
  assert.throws(() => resolveRepoPath(win, '..'), /folder name/);
});

test('buildPrompt protects the working copy only when a branch is given', () => {
  const withBranch = buildPrompt({ task: 'run tests', from: 'mac', branch: 'msi-test/x', repoPath: 'C:\\src\\app' });
  assert.match(withBranch, /never switch its branch/);
  assert.match(withBranch, /C:\\src\\app-remote-test/);
  assert.match(withBranch, /origin\/msi-test\/x/);
  assert.match(withBranch, /git push origin HEAD:msi-test\/x/);
  assert.match(withBranch, /Task: run tests/);
  const plain = buildPrompt({ task: 'check', from: 'mac', repoPath: '/x' });
  assert.doesNotMatch(plain, /worktree/);
  assert.match(plain, /dispatched from the machine "mac"/);
});

test('parseDuration', () => {
  assert.equal(parseDuration('90'), 90);
  assert.equal(parseDuration('90s'), 90);
  assert.equal(parseDuration('9m'), 540);
  assert.equal(parseDuration('1h'), 3600);
  for (const bad of ['', '9x', '-1', '1.5m', 'm']) assert.throws(() => parseDuration(bad), /Invalid duration/);
});

test('generatePassword: length, alphabet, uniqueness', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const pw = generatePassword();
    assert.equal(pw.length, 24);
    assert.match(pw, /^[A-HJ-NP-Za-km-z2-9]+$/);
    seen.add(pw);
  }
  assert.equal(seen.size, 200);
});

test('errorText: the message from paseo JSON errors, else the first line', async () => {
  const { errorText } = await import('../src/paseo.js');
  const json = JSON.stringify({ error: { code: 'AUTH_FAILED', message: 'Cannot connect: Incorrect password', details: 'x' } }, null, 2);
  assert.equal(errorText({ code: 1, stderr: json, stdout: '' }), 'Cannot connect: Incorrect password');
  assert.equal(errorText({ code: 1, stderr: '', stdout: '\nboom\nmore' }), 'boom');
  assert.equal(errorText({ code: 2, stderr: '', stdout: '' }), 'exit code 2');
});

test('isWindowsToolOnWsl flags Windows binaries seen from WSL (Linux only)', async () => {
  const { isWindowsToolOnWsl } = await import('../src/util.js');
  const expected = process.platform === 'linux';
  assert.equal(isWindowsToolOnWsl('/mnt/c/nvm4w/nodejs/npm'), expected);
  assert.equal(isWindowsToolOnWsl('/home/u/.nvm/versions/node/v22/bin/npm'), false);
  assert.equal(isWindowsToolOnWsl(null), false);
});

test('remote: quoting, the typed line and parsing the captured output', async () => {
  const { parseCapture, quoteArg, remoteLine } = await import('../src/remote.js');
  assert.equal(quoteArg('verify', 'linux'), 'verify');
  assert.equal(quoteArg("it's here", 'darwin'), `'it'\\''s here'`);
  assert.equal(quoteArg('C:\\Users\\John Doe', 'win32'), '"C:\\Users\\John Doe"');
  assert.throws(() => quoteArg('a&b', 'win32'), /Can't pass/);

  // POSIX: run the exact line through each shell there is; its output parses back exactly (a long line too, which a
  // terminal would have wrapped), and a failing command reports failure.
  if (process.platform !== 'win32') {
    const long = `✓ ${'x'.repeat(150)} end`;
    // The user's shell types the line, whatever it is (csh and fish aren't POSIX shells); sh runs the script.
    const shells = ['bash', 'zsh', 'sh', 'dash', 'ksh', 'tcsh', 'csh', 'fish'].filter((sh) => spawnSync(sh, ['-c', 'true']).status === 0);
    assert.ok(shells.length, 'no POSIX shell found');
    for (const sh of shells) {
      for (const [cmd, ok, expected] of [
        [`echo hello ${quoteArg("wor'ld", 'linux')}; echo ${quoteArg(long, 'linux')}`, true, `hello wor'ld\n${long}`],
        ['echo oops >&2; false', false, 'oops'],
        ['true', true, ''],
      ]) {
        const line = remoteLine(cmd, 'linux', 'abc123');
        const out = spawnSync(sh, ['-c', line], { encoding: 'utf8' }).stdout;
        assert.ok(out.split('\n').every((l) => l.length <= 80), `${sh}: every printed line fits 80 columns`);
        // A terminal also shows the typed line itself; it must not count as a marker.
        assert.deepEqual(parseCapture(`user@host:~$ ${line}\n${out}user@host:~$ `, 'abc123'), { done: true, ok, output: expected }, `${sh}: ${cmd}`);
      }
    }
  }
  // cmd.exe: day-old leftovers of killed commands are swept first, and only our own files.
  assert.match(remoteLine('x', 'win32', 'ff00'), /^forfiles \/p "%TEMP%" \/m wingman-out-\* \/d -1 /);
  // cmd.exe transcript, as captured from a Windows terminal: the typed line (wrapped), then certutil's base64.
  const winLine = remoteLine('claude-wingman version', 'win32', 'ff00');
  assert.match(winLine, /\^BEGIN__/);
  const b64 = Buffer.from('2.2.0\r\n\r\n').toString('base64');
  const transcript = `C:\\Users\\d>${winLine.slice(0, 67)}\n${winLine.slice(67)}\n__WM_ff00_BEGIN__ \n-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n__WM_ff00_END_0__ \n\nC:\\Users\\d>`;
  assert.deepEqual(parseCapture(transcript, 'ff00'), { done: true, ok: true, output: '2.2.0' });
  assert.equal(parseCapture(`C:\\Users\\d>${winLine}\n__WM_ff00_BEGIN__\n`, 'ff00').done, false);
  // The begin marker scrolled away: what's left still decodes (64-character lines are whole base64 groups).
  const lines = Buffer.from(Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')).toString('base64').match(/.{1,64}/g);
  const cut = parseCapture(`${lines.slice(2).join('\n')}\n__WM_ff00_END_1__\n$ `, 'ff00');
  assert.equal(cut.ok, false);
  const [notice, ...kept] = cut.output.split('\n');
  assert.match(notice, /^\(the start of the output didn't fit/);
  assert.deepEqual(kept, Array.from({ length: 30 }, (_, i) => `line ${i}`).slice(-kept.length), 'only whole lines, up to the last');
  assert.ok(kept.length > 10 && kept.length < 30);
  // The same on Windows, where certutil's footer sits between the base64 and the end marker.
  const winCut = parseCapture(`${lines.slice(2).join('\n')}\n-----END CERTIFICATE-----\n__WM_ff00_END_0__\n`, 'ff00');
  assert.deepEqual(winCut.output.split('\n').slice(1), kept);
  assert.equal(parseCapture('__WM_ff00_BEGIN__\n__WM_beef_END_0__', 'ff00').done, false, "another run's marker doesn't count");
});

test('remote: each machine logs the remote commands it receives', async () => {
  const { COMMAND_LOG, cmdChild, parseCapture, remoteLine } = await import('../src/remote.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wingman-log-'));
  try {
    const label = "from mac: run echo it's (fine) & 100%";
    if (process.platform !== 'win32') {
      spawnSync('sh', ['-c', remoteLine('true', 'linux', 'aa01', label)], { env: { ...process.env, HOME: home } });
      spawnSync('sh', ['-c', remoteLine('false', 'linux', 'aa02', 'from wsl: claude-wingman verify')], { env: { ...process.env, HOME: home } });
      const lines = fs.readFileSync(path.join(home, '.claude-wingman', COMMAND_LOG), 'utf8').trim().split('\n');
      assert.equal(lines.length, 2);
      assert.match(lines[0], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ from mac: run echo it's \(fine\) & 100%$/);
      assert.match(lines[1], / from wsl: claude-wingman verify$/);
      assert.equal(fs.statSync(path.join(home, '.claude-wingman', COMMAND_LOG)).mode & 0o777, 0o600, 'only you can read it');
      assert.equal(fs.statSync(path.join(home, '.claude-wingman')).mode & 0o777, 0o700);
    } else {
      fs.mkdirSync(path.join(home, '.claude-wingman'));
      const res = spawnSync('cmd.exe', ['/d', '/q', '/k', 'prompt $_'], { input: `${remoteLine('echo hi', 'win32', 'aa03', label)}\r\nexit\r\n`, encoding: 'utf8', env: { ...process.env, USERPROFILE: home } });
      assert.equal(parseCapture(res.stdout, 'aa03').output, 'hi');
      assert.match(fs.readFileSync(path.join(home, '.claude-wingman', COMMAND_LOG), 'utf8'), /from mac: run echo it's _fine_ _ 100_/);
      assert.ok(cmdChild);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('remote: a killed command (timeout or cancel) stops and leaves no temporary file behind', { skip: process.platform === 'win32' }, async () => {
  const { remoteLine } = await import('../src/remote.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wingman-kill-'));
  try {
    const marker = path.join(tmp, 'finished');
    // Like a terminal: the shell leads its own process group, and closing the terminal sends it SIGHUP.
    const child = spawn('bash', ['-c', remoteLine(`sleep 3; touch '${marker}'`, 'linux', 'beef01')], { detached: true, env: { ...process.env, TMPDIR: tmp }, stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(fs.readdirSync(tmp).filter((f) => f.startsWith('wingman-out-beef01.')).length, 1, 'the output file exists while it runs');
    process.kill(-child.pid, 'SIGHUP');
    await new Promise((r) => child.on('exit', r));
    await new Promise((r) => setTimeout(r, 3500));
    assert.deepEqual(fs.readdirSync(tmp), [], 'output file removed, and the command never finished');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('status: agent states, and the screen shows what is active plus the latest finished', async () => {
  const { agentState, renderStatus } = await import('../src/commands/agents.js');
  assert.equal(agentState('running', {}), 'running');
  assert.equal(agentState('running', { waiting: true }), 'needs permission');
  assert.equal(agentState('idle', { label: 'paused' }), 'paused');
  assert.equal(agentState('closed', { label: 'cancelled' }), 'cancelled');
  assert.equal(agentState('idle', { label: '' }), 'finished');
  assert.equal(agentState('initializing', {}), 'starting');
  assert.equal(agentState('running', { label: 'paused' }), 'running', 'resumed elsewhere: the live status wins');
  assert.equal(agentState('error', {}), 'failed');
  const agent = (n, state) => ({ id: `${n}`.repeat(8), shortId: `${n}`.repeat(7), state, title: `task ${n}`, cwd: '/w', started: 'just now' });
  const snaps = [
    { machine: 'mac', thisMachine: true, reachable: true, commands: [], agents: [agent(1, 'finished'), agent(2, 'running'), agent(3, 'finished'), agent(4, 'finished'), agent(5, 'paused'), agent(6, 'failed')] },
    { machine: 'msi', reachable: true, agents: [], commands: [{ shortId: 'abcdef0', state: 'running', title: 'from mac: claude-wingman verify' }] },
    { machine: 'wsl', reachable: false, error: 'unreachable (asleep, offline, or Tailscale down)' },
  ];
  const text = renderStatus(snaps, { width: 100 }).join('\n');
  assert.match(text, /^mac \(this machine\)  1 running, 1 paused, 1 failed$/m);
  assert.match(text, /6666666  failed .*task 6/, 'a failed agent is always shown');
  assert.match(text, /2222222  running .*task 2/);
  assert.match(text, /5555555  paused .*task 5/);
  assert.ok(text.includes('task 1') && text.includes('task 3') && text.includes('task 4'), 'the 3 latest finished');
  assert.doesNotMatch(text, /earlier/);
  assert.match(text, /^msi  1 remote command$/m);
  assert.match(text, /abcdef0  remote command .*from mac: claude-wingman verify/);
  assert.match(text, /^wsl  unreachable/m);
  const more = [{ ...snaps[0], agents: [...snaps[0].agents, agent(7, 'finished')] }];
  assert.match(renderStatus(more).join('\n'), /\+ 1 earlier \(claude-wingman status --all\)/);
  assert.ok(renderStatus(more, { all: true }).join('\n').includes('task 7'));
  assert.ok(renderStatus(snaps, { width: 60 }).every((l) => l.length <= 60), 'fits a narrow terminal');
});

test('cmd.exe: the command goes to a child cmd, escaped so the typed line leaves it alone', async () => {
  const { cmdChild, parseCapture, remoteLine } = await import('../src/remote.js');
  assert.equal(cmdChild('rem nothing'), 'cmd /d /s /c "rem nothing"', 'inside the quotes: no escaping needed');
  assert.equal(cmdChild('echo "a & b" & ver'), 'cmd /d /s /c "echo "a ^& b" & ver"', 'escaped exactly where the outer parse is outside quotes');
  assert.equal(cmdChild('"C:\\Program Files\\x.exe" --v'), 'cmd /d /s /c ""C:\\Program Files\\x.exe" --v"');
  assert.throws(() => cmdChild('echo "odd'), /Unbalanced quotes/);
  assert.throws(() => cmdChild('a\r\nb'), /line break/);
  // On Windows, type the real line into a real cmd.exe (reading its input like a prompt) and parse what it prints.
  // Its prompt is set to a bare line break: in a terminal, the typed line and its Enter come before the output.
  if (process.platform === 'win32') {
    const cases = [['rem nothing', true, ''], ['echo (balanced)', true, '(balanced)'], ['echo a)', true, 'a)'], ['echo "a & b" & echo c', true, '"a & b" \nc'],
      ['if exist C:\\Windows (echo yes) else (echo no)', true, 'yes'], ['for %i in (1 2) do @echo item %i', true, 'item 1\nitem 2'], ['exit /b 3', false, '']];
    for (const [cmd, ok, output] of cases) {
      const res = spawnSync('cmd.exe', ['/d', '/q', '/k', 'prompt $_'], { input: `${remoteLine(cmd, 'win32', 'feed01')}\r\nexit\r\n`, encoding: 'utf8', timeout: 60_000 });
      assert.deepEqual(parseCapture(res.stdout, 'feed01'), { done: true, ok, output }, cmd);
    }
  }
});

test('run: options before the command, the command verbatim after', async () => {
  const { parseRunArgs } = await import('../src/commands/remote.js');
  const p = (line) => parseRunArgs(line.split(' '));
  assert.deepEqual(p('msi -- git log --oneline -3'), { target: 'msi', all: false, cwd: undefined, timeoutSeconds: 600, command: 'git log --oneline -3' });
  assert.deepEqual(p('msi git log --oneline'), { target: 'msi', all: false, cwd: undefined, timeoutSeconds: 600, command: 'git log --oneline' }, 'without --');
  assert.deepEqual(p('wsl --cwd myapp --timeout 2m npm test'), { target: 'wsl', all: false, cwd: 'myapp', timeoutSeconds: 120, command: 'npm test' });
  assert.deepEqual(p('--all echo hi'), { target: undefined, all: true, cwd: undefined, timeoutSeconds: 600, command: 'echo hi' }, '--all: the first word is the command');
  assert.equal(p('--all --cwd=x -- dir').cwd, 'x');
  assert.equal(parseRunArgs(['msi', '--', 'dir & ver']).command, 'dir & ver', 'one quoted argument stays as it is');
  assert.throws(() => p('msi'), /Usage: claude-wingman run/);
  assert.throws(() => p('msi --all -- dir'), /Usage/);
  assert.throws(() => p('msi git log -- file'), /Put the command after --/);
  assert.throws(() => p('msi --timeout soon -- dir'), /Invalid duration/);
});

test('status: version and service warnings', async () => {
  const { compareVersions, renderStatus, statusNotes } = await import('../src/commands/agents.js');
  const { VERSION } = await import('../src/util.js');
  assert.equal(compareVersions('2.4.1', '2.10.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0-beta.1'), 1, 'a release is newer than its pre-release');
  assert.equal(compareVersions('3.0.0', '3.0.0'), 0);
  const peer = (machine, version) => ({ machine, reachable: true, version, agents: [], commands: [] });
  const notes = statusNotes([{ ...peer('mac', VERSION), thisMachine: true }, peer('old', '0.0.1'), peer('new', '999.0.0'), peer('same', VERSION), peer('unknown', null)],
    { autostart: false, awake: false });
  assert.equal(notes.length, 4);
  assert.match(notes[0], /^old runs claude-wingman 0\.0\.1 \(last seen\), this machine .*claude-wingman update old$/);
  assert.match(notes[1], /^new runs a newer claude-wingman \(999\.0\.0\)/);
  assert.match(notes[2], /doesn't start automatically/);
  assert.match(notes[3], /may go to sleep/);
  assert.deepEqual(statusNotes([peer('same', VERSION)], { autostart: true, awake: null }), [], 'keep-awake not available (null) is not a warning');
  const text = renderStatus([{ ...peer('msi', '1.2.3'), os: 'win32', host: '100.64.0.2' }], { notes: ['check this'] }).join('\n');
  assert.match(text, /^msi  Windows · 100\.64\.0\.2 · v1\.2\.3  nothing running$/m);
  assert.match(text, /check this$/m);
});

test('serveOnce serves one download at an unguessable URL; fetchBundle only trusts Tailscale addresses', async () => {
  const { fetchBundle, serveOnce } = await import('../src/share.js');
  const http = await import('node:http');
  const get = (url) => new Promise((resolve, reject) => http.get(url, (res) => {
    let body = '';
    res.on('data', (c) => (body += c)).on('end', () => resolve({ status: res.statusCode, body }));
  }).on('error', reject));
  await serveOnce('127.0.0.1', 'credentials.json', Buffer.from('{"x":1}'), async (url) => {
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/credentials\.json$/);
    assert.equal((await get(url.replace(/\/[0-9a-f]{32}\//, '/' + '0'.repeat(32) + '/'))).status, 404, 'wrong token');
    assert.deepEqual(await get(url), { status: 200, body: '{"x":1}' });
    assert.equal((await get(url)).status, 404, 'second download refused');
  });
  await assert.rejects(fetchBundle('http://192.168.1.5:80/x'), /Tailscale/);
  await assert.rejects(fetchBundle('file:///etc/passwd'), /Tailscale/);
});

test('clientEnv drops all inherited PASEO_* context', async () => {
  const { clientEnv } = await import('../src/paseo.js');
  const saved = { ...process.env };
  Object.assign(process.env, { PASEO_HOME: '/h', PASEO_WORKSPACE_ID: 'wks_1', PASEO_TERMINAL_ID: 't', PASEO_PASSWORD: 'old' });
  try {
    const env = clientEnv({ host: '100.64.0.1:6767', password: 'pw' });
    assert.deepEqual(Object.keys(env).filter((k) => k.startsWith('PASEO_')).sort(), ['PASEO_HOST', 'PASEO_PASSWORD']);
    assert.equal(env.PASEO_PASSWORD, 'pw');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  }
});
````
<!-- END FILE -->

<!-- BEGIN FILE: test/system.test.js -->
**`test/system.test.js`**

````js
// Tests that touch the filesystem or OS tools (skills, Paseo config, plists, Keychain).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import bcrypt from 'bcryptjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cp-test-'));
const realHome = process.env.HOME;

test('skill: frontmatter is valid and description is a safe YAML string', async () => {
  const { renderSkill } = await import('../src/skill.js');
  for (const peer of [
    { os: 'win32', machine: 'msi', reposRoot: 'C:\\Users\\d\\src', home: 'C:\\Users\\d' },
    { os: 'darwin', machine: 'my-macbook-air', reposRoot: '/Users/d/ws', home: '/Users/d' },
    { os: 'linux', machine: 'build-box', reposRoot: '/home/d/src', home: '/home/d' },
  ]) {
    const md = renderSkill('peerx', peer);
    const fm = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(md);
    assert.ok(fm, 'frontmatter present');
    assert.equal(fm[1], 'peerx');
    const desc = fm[2];
    assert.ok(desc.startsWith('"') && desc.endsWith('"'), 'description is double-quoted');
    assert.doesNotMatch(desc.slice(1, -1), /(?<!\\)"/, 'no unescaped double quote inside the description');
    assert.match(md, /claude-wingman dispatch peerx --repo <repo> --branch <branch>/);
    assert.match(md, peer.os === 'win32' ? /UAC/ : /sudo/);
    assert.match(md, { win32: /on Windows/, darwin: /on macOS/, linux: /on Linux/ }[peer.os]);
  }
});

test('skill: replaces links and its own skills, refuses foreign ones, removes only its own', async () => {
  // os.homedir() reads HOME on macOS but USERPROFILE on Windows; isolate both so real skills are never touched.
  const realProfile = process.env.USERPROFILE;
  process.env.HOME = tmp();
  process.env.USERPROFILE = process.env.HOME;
  assert.equal(os.homedir(), process.env.HOME, 'home directory is isolated');
  try {
    const { installSkill, removeSkill, renderSkill, skillsDir } = await import('../src/skill.js');
    const content = renderSkill('msi', { os: 'win32', machine: 'msi', reposRoot: 'C:\\s', home: 'C:\\' });
    fs.mkdirSync(skillsDir(), { recursive: true });

    // A linked skill directory: the link goes, the target survives.
    const target = path.join(process.env.HOME, 'repo-skill');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'SKILL.md'), 'old');
    // A junction on Windows (directory symlinks there need admin rights).
    fs.symlinkSync(target, path.join(skillsDir(), 'msi'), process.platform === 'win32' ? 'junction' : 'dir');
    installSkill('msi', content);
    assert.ok(!fs.lstatSync(path.join(skillsDir(), 'msi')).isSymbolicLink());
    assert.equal(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), 'old');

    // A skill it wrote earlier is rewritten.
    installSkill('mac', 'stale <!-- generated by claude-wingman; recreate with: claude-wingman skill -->');
    installSkill('mac', content);
    assert.equal(fs.readFileSync(path.join(skillsDir(), 'mac', 'SKILL.md'), 'utf8'), content);
    assert.match(fs.readFileSync(path.join(skillsDir(), 'mac', 'SKILL.md'), 'utf8'), /generated by claude-wingman/);

    // Someone else's skill is left alone, and pairing can detect that before changing anything.
    const { assertSkillInstallable } = await import('../src/skill.js');
    fs.mkdirSync(path.join(skillsDir(), 'work'));
    fs.writeFileSync(path.join(skillsDir(), 'work', 'SKILL.md'), 'my own skill');
    assert.throws(() => assertSkillInstallable('work'), /different skill/);
    assert.doesNotThrow(() => assertSkillInstallable('brand-new'));
    assert.throws(() => installSkill('work', content), /different skill/);
    assert.equal(removeSkill('work'), false);
    assert.ok(fs.existsSync(path.join(skillsDir(), 'work', 'SKILL.md')));
    assert.equal(removeSkill('msi'), true);
    assert.ok(!fs.existsSync(path.join(skillsDir(), 'msi')));
  } finally {
    process.env.HOME = realHome;
    if (realProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = realProfile;
  }
});

test('configureDaemon: sets listen, relay off, bcrypt password; idempotent; keeps other keys; backs up', async () => {
  process.env.PASEO_HOME = tmp();
  try {
    const { configureDaemon, passwordMatchesDaemon, readDaemonConfig } = await import('../src/paseo.js');
    const file = path.join(process.env.PASEO_HOME, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, daemon: { listen: '127.0.0.1:6767', cors: { allowedOrigins: ['x'] }, relay: { enabled: true } }, app: { a: 1 } }));
    assert.equal(configureDaemon({ listen: '100.64.0.2:6767', password: 'Secret123' }), true);
    const cfg = readDaemonConfig();
    assert.equal(cfg.daemon.listen, '100.64.0.2:6767');
    assert.equal(cfg.daemon.relay.enabled, false);
    assert.deepEqual(cfg.daemon.cors, { allowedOrigins: ['x'] });
    assert.deepEqual(cfg.app, { a: 1 });
    assert.ok(bcrypt.compareSync('Secret123', cfg.daemon.auth.password));
    assert.ok(passwordMatchesDaemon('Secret123'));
    assert.ok(!passwordMatchesDaemon('wrong'));
    assert.equal(configureDaemon({ listen: '100.64.0.2:6767', password: 'Secret123' }), false, 'no change on re-run');
    assert.equal(fs.readdirSync(process.env.PASEO_HOME).filter((f) => f.includes('.bak-')).length, 1);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    delete process.env.PASEO_HOME;
  }
});

test('launchd plist is well-formed and escapes values', { skip: process.platform !== 'darwin' }, async () => {
  const { launchAgentPlist } = await import('../src/service.js');
  const xml = launchAgentPlist({ label: 'dev.test', program: ['/bin/echo', 'a & <b>'], env: { PATH: '/usr/bin' }, logFile: '/tmp/x.log' });
  const file = path.join(tmp(), 'x.plist');
  fs.writeFileSync(file, xml);
  const lint = spawnSync('/usr/bin/plutil', ['-lint', file], { encoding: 'utf8' });
  assert.equal(lint.status, 0, lint.stdout + lint.stderr);
  const json = JSON.parse(spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }).stdout);
  assert.deepEqual(json.ProgramArguments, ['/bin/echo', 'a & <b>']);
  assert.equal(json.KeepAlive, true);
});

test('secrets: Keychain / DPAPI / private file set/get/overwrite/delete', { skip: !['darwin', 'win32', 'linux'].includes(process.platform) }, async () => {
  const { deleteSecret, getSecret, setSecret } = await import('../src/secrets.js');
  process.env.CLAUDE_WINGMAN_HOME = tmp(); // DPAPI files live here; the Keychain ignores it
  const key = `test-${process.pid}`;
  try {
    assert.equal(getSecret(key), null);
    setSecret(key, 'First123');
    assert.equal(getSecret(key), 'First123');
    setSecret(key, 'Second456');
    assert.equal(getSecret(key), 'Second456');
    assert.throws(() => setSecret(key, 'bad value with spaces'), /unsupported characters/);
    if (process.platform === 'linux') {
      const dir = path.join(process.env.CLAUDE_WINGMAN_HOME, 'secrets');
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700, 'secrets folder is private');
      for (const f of fs.readdirSync(dir)) assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600, `${f} is private`);
    }
  } finally {
    deleteSecret(key);
  }
  assert.equal(getSecret(key), null);
  delete process.env.CLAUDE_WINGMAN_HOME;
});
````
<!-- END FILE -->

<!-- BEGIN FILE: test/docs.test.js -->
**`test/docs.test.js`**

````js
// SETUP.md must embed every source file, byte for byte, so it stays a self-contained runbook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, embeddedFiles } from '../tools/build-setup-doc.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function listFiles(dir) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(path.join(dir, e.name)) : [path.join(dir, e.name).split(path.sep).join('/')]);
}

test('SETUP.md is up to date with the code', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'SETUP.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(build(doc), doc, 'run: npm run docs');
});

test('SETUP.md embeds every source file', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'SETUP.md'), 'utf8');
  const embedded = new Set(embeddedFiles(doc));
  const expected = [
    'README.md', 'package.json', '.gitignore', '.gitattributes',
    ...['bin', 'src', 'test', 'tools', 'e2e'].flatMap(listFiles),
  ];
  const missing = expected.filter((f) => !embedded.has(f));
  assert.deepEqual(missing, [], `add markers to SETUP.md for: ${missing.join(', ')}`);
});
````
<!-- END FILE -->

<!-- BEGIN FILE: e2e/remote.e2e.js -->
**`e2e/remote.e2e.js`**

````js
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
````
<!-- END FILE -->

<!-- BEGIN FILE: tools/check-release.js -->
**`tools/check-release.js`**

````js
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
````
<!-- END FILE -->

<!-- BEGIN FILE: tools/build-setup-doc.js -->
**`tools/build-setup-doc.js`**

````js
// Embed the repo's files verbatim into SETUP.md between file markers, so the runbook is self-contained.
//   node tools/build-setup-doc.js           rewrite SETUP.md
//   node tools/build-setup-doc.js --check   exit 1 if SETUP.md is out of date
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC = path.join(ROOT, 'SETUP.md');
// Built from pieces so this file, which is itself embedded in SETUP.md, never contains a literal marker.
const OPEN = '<!-- ' + 'BEGIN FILE: ';
const CLOSE = '<!-- ' + 'END FILE -->';
const BLOCK = new RegExp(`(${OPEN}(\\S+) -->\\n)[\\s\\S]*?(${CLOSE})`, 'g');
const LANG = { '.js': 'js', '.json': 'json', '.md': 'markdown' };

function fenced(rel) {
  let text = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  if (!text.endsWith('\n')) text += '\n';
  // Four backticks, so files containing ``` fences (README) stay intact.
  return `**\`${rel}\`**\n\n\`\`\`\`${LANG[path.extname(rel)] ?? ''}\n${text}\`\`\`\`\n`;
}

export const build = (doc) => doc.replace(BLOCK, (_, open, rel, close) => open + fenced(rel) + close);
export const embeddedFiles = (doc) => [...doc.matchAll(BLOCK)].map((m) => m[2]);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const current = fs.readFileSync(DOC, 'utf8');
  const updated = build(current);
  if (process.argv.includes('--check')) {
    if (updated !== current) {
      console.error('SETUP.md is out of date; run: node tools/build-setup-doc.js');
      process.exit(1);
    }
    console.log('SETUP.md is up to date');
  } else {
    fs.writeFileSync(DOC, updated);
    console.log(`embedded ${embeddedFiles(updated).length} files into SETUP.md`);
  }
}
````
<!-- END FILE -->
