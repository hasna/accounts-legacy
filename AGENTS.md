# AGENTS.md — @hasna/accounts

## What this is

Local-first CLI to manage **profiles** for AI coding tools (Claude Code primary).
Each profile = isolated config dir + optional auth snapshots for **apply mode**.

## Three-pointer model

See [docs/IMPLEMENT.md](docs/IMPLEMENT.md). Short version:

| Pointer | Store key | CLI |
|---------|-----------|-----|
| Active | `current[toolId]` | `use`, `active`, `pick` (always sets active) |
| Applied | `applied[toolId]` | `apply`, `applied`, `pick` (default also applies) |
| Isolated | (none) | `env`, `launch`, `shell` — env var only |

- **`use` ≠ IDE auth** — only updates `current`. Cursor reads live `~/.claude` via **applied**.
- **`apply`** — Claude-only; requires auth snapshot; updates `applied` + `current`.
- **Shell hook** — syncs active→applied before terminal `claude`; see [docs/hook.md](docs/hook.md).

## Switching modes

1. **Isolated** — set `CLAUDE_CONFIG_DIR` via `launch` / `env` / `shell`. Parallel terminals OK.
2. **Apply** — `accounts apply <name>` copies auth snapshots to live `~/.claude` + `~/.claude.json`
   (+ macOS Keychain via `security`). For Cursor / VS Code.

Auth snapshots live under `<profile-dir>/.accounts-auth/`.

## Layout

- `src/lib/profiles.ts` — CRUD + `current` / `useProfile`
- `src/lib/apply.ts` — apply + `applied` pointer in store
- `src/lib/claude-auth.ts` — snapshot/restore OAuth, credentials, keychain
- `src/lib/import-profile.ts` — `import` / `login` helpers
- `src/lib/pick.ts` — interactive picker (`apply` | `env` | `none`)
- `src/lib/hook.ts` — shell wrapper install
- `src/cli.ts` — `accounts` binary

## Before you finish

1. `bun run typecheck`
2. `bun test` (uses `ACCOUNTS_HOME` + `ACCOUNTS_TEST_LIVE_DIR` in tests)
3. `bun run build`

Tests must not touch the user's real `~/.claude` — `ACCOUNTS_TEST_LIVE_DIR` redirects live paths.
