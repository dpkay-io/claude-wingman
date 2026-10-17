# Security Policy

## Reporting a vulnerability

Please report vulnerabilities through [GitHub Security Advisories](https://github.com/dpkay-io/claude-wingman/security/advisories/new), or by e-mail to hello@dpkay.com, rather than in a public issue. Include what you found, how to reproduce it, and what an attacker could do with it. You can expect an acknowledgement within 72 hours, and a fix timeline within 14 days for confirmed issues.

## Threat model

claude-wingman connects **your own** computers so that Claude Code on one can run agents and commands on the others. It is built on [Paseo](https://github.com/getpaseo/paseo) (a daemon that runs coding agents) and [Tailscale](https://tailscale.com) (a private WireGuard network).

### What pairing grants

**Pairing two machines gives each one shell access to the other, like an SSH key.** A paired machine can:

- start Claude Code agents there (`dispatch`), which run in Claude Code's *auto* permission mode, with its safety checks on;
- open a terminal there and run any command as your user (`run`, `remote`, `update`). These **don't** go through Claude's safety checks. The generated skills tell Claude to use `dispatch` instead of `run`, but that is guidance to the model, not a security boundary.

So pair only machines you own and control. If one paired machine is compromised, treat every machine it's paired with as exposed: it holds their daemon passwords.

### How the daemons are protected

- **Reachable only over Tailscale.** Each daemon binds to its machine's Tailscale address (`100.x.y.z:6767`); localhost and LAN addresses are refused, and Paseo's relay is turned off. `claude-wingman verify` checks all of this.
- **A password on every connection.** Each daemon has a random 24-character password. The daemon keeps only a bcrypt hash (file mode 600). The plaintext, needed by the machines that connect to it, is stored in the macOS Keychain, in DPAPI-encrypted files on Windows (readable only by your Windows user), or in files readable only by you on Linux (`~/.claude-wingman/secrets`, mode 600, like SSH keys).
- **Pairing exchanges credentials only with your own devices:** machines signed in to Tailscale as the same user, never shared-in or tagged devices. The first exchange uses Taildrop (end-to-end encrypted). Later ones (password changes, introducing a new machine) use a single-use, unguessable URL on the sender's Tailscale address, which stops working after one download. Every received credential is validated field by field before it's used, and files are deleted once imported.
- **A record on each machine.** Every machine appends the remote commands it receives to `~/.claude-wingman/remote-commands.log` (time, sending machine, command).

### Recommendations

- Keep your tailnet to devices you trust. If others share it, use Tailscale's access controls so that only your own devices can reach TCP port 6767 (see Tailscale's documentation on [ACLs](https://tailscale.com/kb/1018/acls) and `autogroup:self`).
- Rotate a machine's password after removing a paired machine: `claude-wingman setup --rotate-password` (the remaining machines get the new one automatically).
- Native Windows has no sandbox for agents. Anything needing administrator rights (UAC) or `sudo` can't be approved remotely, by design.

### What claude-wingman trusts

- **Paseo**, installed from npm at a pinned, tested version (`@getpaseo/cli@0.11.4`), runs as your user and executes the agents.
- **Tailscale** for transport encryption and device identity.
- **Claude Code** on each machine, signed in with your own account. claude-wingman never handles your Claude credentials.

claude-wingman sends no telemetry. Its only network traffic is between your own machines over Tailscale (and npm, when installing or updating).
