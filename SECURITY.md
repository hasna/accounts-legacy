# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |
| 0.0.x   | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do NOT** open a public GitHub issue.
2. Email **hasna@hasna.com** with details.
3. Include steps to reproduce if possible.
4. Allow reasonable time for a fix before public disclosure.

## Security Model

### Local-first

`@hasna/accounts` stores everything locally in a single JSON registry under
`~/.hasna/accounts/` (created with mode `600`). It makes no network calls, sends no
telemetry, and has no server component.

### What it stores

- Profile names, the tool each targets, an optional account **email**, the config-dir
  path, and timestamps.
- **Apply mode** may store auth **snapshots** under `<profile-dir>/.accounts-auth/`
  (OAuth account JSON, file credentials, and on macOS a copy of the Keychain payload).
  Treat profile directories and `~/.hasna/accounts/accounts.json` as sensitive — same
  trust level as `~/.claude` or SSH keys.

### Email detection and apply mode

Email auto-detection **reads** a tool's account file. **`accounts apply`** **writes**
to live `~/.claude` paths and may update the macOS Keychain entry
`Claude Code-credentials`. Only run apply on profile dirs you trust.

### Launching tools

`accounts launch` / `accounts shell` set the tool's config-dir environment variable and
spawn the configured binary with your existing environment. Only register custom tools
(`accounts tools add`) whose `--bin` you trust.

## Best Practices

- Keep `~/.hasna/accounts/` on a filesystem with restricted permissions.
- Use `--purge` deliberately; it only deletes managed profile dirs, never imported ones.
