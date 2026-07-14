# Accounts Storage Stabilization

This change consolidates registry access behind `AccountsStore`:

- `LocalStore` owns the local `accounts.json` registry.
- `ApiStore` owns self-hosted/cloud registry access through `/v1`.
- Machine-local profile directories, applied pointers, and launch processes stay local.
- Cloud custom tool definitions hydrate a process-only cache. Readiness, health,
  list, and lookup operations do not create or rewrite `accounts.json`.

## Scope And Blast Radius

The source change covers four related surfaces:

1. AccountsStore routing for CLI, MCP, login, launch, supervisor, readiness, and
   profile registry operations.
2. Retirement of the legacy provider-backed remote/hybrid subsystem, with
   source-compatible shims but no provider runtime.
3. PostgreSQL migration `0003_custom_tools.sql` plus additive custom-tool and
   rename endpoints.
4. Readiness and server compatibility, including additive Tool responses and
   transactional account/current-selection updates.

Local-only mode remains supported. No publish or deployment is part of this
source change.

## Compatibility Shims

No breaking removal is approved for this restack. The
`@hasna/accounts/storage` entry point retains its prior constants, types,
status/config functions, local snapshot functions, and sync function
signatures. The implementation has no provider runtime: `storagePush`,
`storagePull`, and `storageSync` reject with migration guidance.

The root `ensureProfileForLogin` export remains as a deprecated, synchronous,
local-only shim. New callers use async `prepareLogin` so custom tools can be
hydrated from the active Store.

The `accounts storage status|push|pull|sync` command group remains
discoverable. Status reports local/API compatibility state; provider-backed
mutations fail explicitly. The three retired mutations continue to accept
`--json` and the source functions retain their optional environment argument,
so legacy parsers and TypeScript call sites receive a retirement diagnostic
instead of a parse or compile failure. The retired `remote`, `hybrid`, and
`s3` mode words are ignored. Other unknown modes fail validation.

## Deployment Order

1. Take and verify a restorable Accounts database backup. This is mandatory:
   migration `0004` changes live selection rows.
2. Run `accounts-migrate` with the new source against PostgreSQL. Migration
   `0003` is additive and creates `custom_tools`. Migration `0004` copies
   orphan current selections to `current_selection_orphan_archive`, removes
   those orphans from the live table, preserves valid selections, then adds a
   cascading account foreign key. Inspect and retain the archive for
   reconciliation; do not treat it as disposable migration scratch state.
3. Deploy `accounts-serve` and verify `/health`, `/ready`, `/version`,
   `GET /v1/tools`, and the OpenAPI document.
4. Roll out new clients only after the server is ready.

Server-before-client is required for `accounts rename`, `accounts tools add`,
and `accounts tools remove`. A new client connected to an older server returns
an actionable redeploy error for those route-missing mutations. Existing
account reads and writes continue to use their original endpoints.

## Compatibility Matrix

| Client | Server | Result |
| --- | --- | --- |
| Old | Old | Existing account and selection operations are unchanged. |
| Old | New | Compatible. Routes are additive and Tool only requires `id` and `label`; enriched fields are optional. |
| New | Old | Existing operations work. Minimal legacy built-in Tool responses are accepted. Rename and custom-tool mutations require a server upgrade and fail with an actionable error. |
| New | New before migrations 0003/0004 | `/ready` is unavailable with a pending-migration reason. Do not send traffic. |
| New | New after migrations 0003/0004 | Full AccountsStore routing, custom tools, row/advisory-locked account/tool mutations, rename/remove/current updates, and pointer reconciliation are available. |

## Rollback And Forward Fix

- Before client rollout, the application server image may be rolled back.
  Leave migrations `0003` and `0004` in place; older servers ignore
  `custom_tools`, and the foreign key preserves existing account/current
  semantics.
- Never run a pre-`0003` `accounts-migrate` binary after `0003` or `0004`
  is recorded. The checksum ledger rejects migrations unknown to the supplied
  manifest as a deterministic downgrade guard. An application rollback must
  retain the new migrator binary/job; otherwise forward-fix the new image.
- If migration `0004` requires data recovery, stop writes and restore the
  mandatory pre-migration backup. The orphan archive is evidence for
  reconciliation, not a substitute for the backup.
- After new clients use rename or custom-tool endpoints, prefer a server
  forward-fix. Rolling the server below those endpoints makes the new mutations
  unavailable until it is restored.
- A client rollback does not remove cloud custom tools. Older clients may not
  resolve those tools for launch, but account and tool records remain intact.
- Do not drop `custom_tools` as an application rollback. Restore service with a
  corrected server build, then reconcile data through supported endpoints.

## Verification

- `bun test` covers local/no-cloud behavior, process-only hydration,
  cold custom-tool lookup/launch, endpoint compatibility, and transaction use.
- `bun run test:postgres` requires
  `HASNA_ACCOUNTS_TEST_DATABASE_URL`. It uses an isolated schema to verify the
  `0003` upgrade, `0004` orphan archival and valid-row preservation, restart
  idempotency, old-migrator downgrade rejection, rollback/forward-fix behavior,
  transaction rollback, and concurrent row/advisory locking.
- Contract, no-cloud, generated SDK, and vendored storage-kit checks remain
  required before release.
