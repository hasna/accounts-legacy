# Contributing to @hasna/accounts

Thanks for your interest in contributing!

## Development Setup

```bash
git clone https://github.com/hasna/accounts.git
cd accounts
bun install

bun test            # run tests
bun run typecheck   # type check
bun run build       # build to dist/
bun run dev -- --help   # run the CLI from source
```

## Project Structure

```
src/
  types.ts              - types, zod schemas, error class
  storage.ts            - JSON registry under ~/.hasna/accounts/
  lib/
    tools.ts            - built-in + runtime-registered tools
    detect.ts           - email auto-detection
    profiles.ts         - profile CRUD, current pointer
    apply.ts            - apply mode, applied pointer
    apply-lock.ts       - exclusive apply lock
    claude-auth.ts      - auth snapshots + restore
    claude-layout.ts    - live vs profile paths
    import-profile.ts   - import / login
    pick.ts             - interactive picker
    hook.ts             - shell wrapper
    safe-path.ts        - symlink guards on auth writes
    keychain.ts         - macOS keychain (allowlisted service)
  cli.ts                - commander CLI (the `accounts` binary)
  index.ts              - library re-exports
  accounts.test.ts      - core tests
  switcher.test.ts      - apply/import/hook integration tests
docs/
  IMPLEMENT.md          - three-pointer model + module map
  hook.md               - shell hook behavior and footguns
```

## Adding support for a new app

Two ways:

1. **At runtime (no code):** `accounts tools add <id> --label ... --env-var ... --bin ...`.
2. **Built-in:** add an entry to `BUILTIN_TOOLS` in `src/lib/tools.ts`. Include
   `accountFile` + `emailPath` if the app stores the account email in its config dir.

## Making Changes

1. Fork and branch (`git checkout -b feature/my-feature`).
2. Make changes and add tests.
3. `bun test` and `bun run typecheck` must pass.
4. Commit with a clear [Conventional Commit](https://www.conventionalcommits.org/) message.
5. Open a Pull Request.

## Code Style

- TypeScript strict mode with `noUncheckedIndexedAccess`.
- Validate external input with `zod`.
- Keep changes focused; add tests for new behavior.

## Reporting Issues

Use [GitHub Issues](https://github.com/hasna/accounts/issues). Include repro steps,
expected vs actual behavior, the version (`accounts --version`), and your OS.
