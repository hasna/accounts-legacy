# @hasna/accounts

> Manage and switch between multiple **Claude Code** (and other AI coding tool)
> profiles/accounts on one machine — isolated config dirs, IDE-friendly apply mode,
> and one-command switching.

`accounts` is a local-first CLI. Each **profile** is an isolated config directory.
Switch **in the terminal** with `CLAUDE_CONFIG_DIR`, or **in Cursor / VS Code** with
`accounts apply` (syncs auth to live `~/.claude` paths).

- **Isolated profiles** — separate config dirs (skills, settings, sessions). Nothing leaks.
- **Apply mode** — sync OAuth / credentials to live paths for IDEs (Claude-only today).
- **Remembers the email** — auto-detected from `.claude.json` when possible.
- **Multi-tool** — Claude Code built-in; Codex + custom tools via `accounts tools add`.
- **Local-first** — registry at `~/.hasna/accounts/`. No network, no telemetry.

## Install

```bash
bun install -g @hasna/accounts
accounts --help
```

Requires Node ≥ 18 (or Bun ≥ 1.0).

## Quick start (two Claude subscriptions)

```bash
# 1. Import your current install (optional)
accounts import main --dir ~/.claude

# 2. Create profiles
accounts add work --email work@company.com
accounts add personal --email me@gmail.com

# 3. Log in once per profile (isolated dir)
accounts login work        # run /login inside Claude, then /exit
accounts detect work
accounts login personal
accounts detect personal

# 4. Switch
accounts apply work        # Cursor / VS Code — live ~/.claude auth
accounts apply personal

# Or terminal-only (parallel sessions OK):
accounts launch work
eval "$(accounts env personal)"   # other terminal
```

Do **not** run `accounts apply` until after `accounts login` and `accounts detect` — apply
refuses profiles without an auth snapshot so live OAuth is not wiped.

## Three pointers (active, applied, isolated)

| Pointer / mode | Set by | Meaning |
|----------------|--------|---------|
| **Active** | `accounts use`, `launch`, `pick` | Registry `current` — which profile you intend (terminal + hook) |
| **Applied** | `accounts apply`, `pick` (default) | Registry `applied` — auth on live `~/.claude` (what Cursor sees) |
| **Isolated** | `env`, `launch`, `shell` | Per-process `CLAUDE_CONFIG_DIR`; does not change live disk |

| Mode | Command | Best for |
|------|---------|----------|
| **Isolated** | `accounts launch`, `accounts env`, `accounts shell` | Terminal, two accounts at once |
| **Apply** | `accounts apply <name>` | Cursor, VS Code, single global auth |
| **Picker** | `accounts pick` | Interactive choose; default applies to live paths |

`accounts use` alone does **not** change Cursor — run `accounts apply` for IDE auth.

A child process cannot change your parent shell — use `eval "$(accounts env …)"` or the
[shell hook](docs/hook.md) (terminal `claude` only, not IDE extensions).

Implementation details: [docs/IMPLEMENT.md](docs/IMPLEMENT.md).

## Switching modes (summary)

- **`accounts active`** — prints active profile (`store.current`); scripting.
- **`accounts applied`** — prints applied profile (`store.applied`); scripting.
- **`accounts current`** — human-readable active (+ applied hint) per tool.
- **`accounts list`** — `●` active, `◉` applied, `●◉` when both are the same profile.

## Commands

| Command | Description |
|---------|-------------|
| `accounts add <name>` | Create a profile. `--tool`, `--email`, `--dir`, `--description`. |
| `accounts import [name]` | Import existing config dir (default `~/.claude`). `--copy` for managed copy. |
| `accounts login <name>` | Launch Claude in profile dir for `/login` (creates profile via import if missing). |
| `accounts apply <name>` | Apply profile auth to live Claude paths (requires snapshot; Claude-only). |
| `accounts pick` | Interactive picker; default applies. `--env`, `--no-act`. |
| `accounts use <name>` | Mark profile active; prints apply/env hints. |
| `accounts list` (`ls`) | List profiles (`●` active, `◉` applied, `●◉` both). |
| `accounts show <name>` | Profile details including active/applied flags. |
| `accounts current` | Active profile per tool (with applied hint). |
| `accounts active [tool]` | Print active profile name (scripting). |
| `accounts applied [tool]` | Print applied profile name (scripting). |
| `accounts env [name]` | Print `export CLAUDE_CONFIG_DIR=…` |
| `accounts launch\|run <name>` | Launch tool with profile env. |
| `accounts shell <name>` | Subshell with profile env. |
| `accounts hook install` | Install `claude()` wrapper — see [docs/hook.md](docs/hook.md). |
| `accounts hook uninstall` | Remove hook script. |
| `accounts hook path` | Print hook script path. |
| `accounts detect <name>` | Re-detect email from config dir. |
| `accounts doctor` | Check registry and dirs (exits 1 on errors). |

See `accounts --help` for `set`, `rename`, `remove`, `tools`, etc.

## Shell hook (optional)

```bash
accounts hook install
# Add to ~/.zshrc or ~/.bashrc:
source "$(accounts hook path)"
```

The wrapper runs `accounts apply` when the **active** profile differs from **applied**,
then invokes the real `claude` binary. Full behavior and footguns: [docs/hook.md](docs/hook.md).

## Storage layout

```
~/.hasna/accounts/
  accounts.json              # registry: profiles, current, applied (mode 600)
  claude-hook.sh             # optional shell wrapper
  profiles/
    claude/<name>/           # managed config dir
    claude/<name>/.accounts-auth/   # auth snapshots for apply mode
      oauth-account.json
      credentials.json       # Linux / file-based auth
      keychain.json          # macOS keychain payload
```

Overrides: `ACCOUNTS_HOME`, `ACCOUNTS_STORE_PATH`.

## Supported tools

| Tool | id | Env var | Default dir |
|------|----|---------|-------------|
| Claude Code | `claude` | `CLAUDE_CONFIG_DIR` | `~/.claude` |
| Codex CLI | `codex` | `CODEX_HOME` | `~/.codex` |

`apply` is **Claude-only** today. Use `launch` / `env` for other tools.

## Library

```ts
import { addProfile, applyProfile, importProfile } from "@hasna/accounts";
```

## License

Apache-2.0 © Andrei Hasna
