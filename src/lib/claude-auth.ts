import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ToolDef } from "../types.js";
import { AccountsError } from "../types.js";
import {
  CLAUDE_KEYCHAIN_SERVICE,
  liveClaudeBase,
  liveClaudePaths,
  profileAccountJsonPaths,
  profileAuthDir,
  profileCredentialsSnapshot,
  profileKeychainSnapshot,
  profileOAuthSnapshot,
  OAUTH_SNAPSHOT,
} from "./claude-layout.js";
import {
  assertAllowedKeychainCredential,
  keychainSupported,
  readClaudeKeychain,
  writeClaudeKeychain,
} from "./keychain.js";
import { assertSafeWritePath } from "./safe-path.js";

type JsonRecord = Record<string, unknown>;

function readJsonFile(path: string): JsonRecord | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as JsonRecord;
  } catch {
    return undefined;
  }
}

function writeJsonFile(path: string, data: JsonRecord, stayUnder?: string): void {
  assertSafeWritePath(path, stayUnder ? { mustStayUnder: stayUnder } : undefined);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
}

function readOAuthFromPaths(paths: string[]): JsonRecord | undefined {
  for (const p of paths) {
    const data = readJsonFile(p);
    const oauth = data?.oauthAccount;
    if (oauth && typeof oauth === "object") return oauth as JsonRecord;
  }
  return undefined;
}

function mergeOAuthInto(
  paths: string[],
  oauth: JsonRecord | undefined,
  allowDelete: boolean,
  stayUnder?: string,
): void {
  const primary = paths[0];
  if (!primary) return;
  const data = readJsonFile(primary) ?? {};
  if (oauth) {
    data.oauthAccount = oauth;
    writeJsonFile(primary, data, stayUnder);
  } else if (allowDelete) {
    delete data.oauthAccount;
    writeJsonFile(primary, data, stayUnder);
  }
  if (paths[1] && paths[1] !== primary) {
    const parent = readJsonFile(paths[1]) ?? {};
    if (oauth) {
      parent.oauthAccount = oauth;
      writeJsonFile(paths[1], parent, stayUnder);
    } else if (allowDelete) {
      delete parent.oauthAccount;
      writeJsonFile(paths[1], parent, stayUnder);
    }
  }
}

/** Snapshot live Claude auth into a profile directory (used when switching away on apply). */
export function snapshotLiveAuthToProfile(profileDir: string, _tool: ToolDef): void {
  const authDir = profileAuthDir(profileDir);
  assertSafeWritePath(join(authDir, OAUTH_SNAPSHOT), { mustStayUnder: profileDir });
  mkdirSync(authDir, { recursive: true });

  const live = liveClaudePaths();
  const oauth = readOAuthFromPaths([live.homeJson]);
  if (oauth) writeJsonFile(profileOAuthSnapshot(profileDir), { oauthAccount: oauth }, profileDir);

  if (existsSync(live.credentialsFile)) {
    const dest = profileCredentialsSnapshot(profileDir);
    assertSafeWritePath(dest, { mustStayUnder: profileDir });
    copyFileSync(live.credentialsFile, dest);
  }

  if (keychainSupported()) {
    const kc = readClaudeKeychain();
    if (kc) writeJsonFile(profileKeychainSnapshot(profileDir), kc as unknown as JsonRecord, profileDir);
  }
}

/** @deprecated Use snapshotLiveAuthToProfile */
export function snapshotClaudeAuthToProfile(profileDir: string, tool: ToolDef): void {
  snapshotLiveAuthToProfile(profileDir, tool);
}

/** Build auth snapshots from files already present in the profile config dir. */
export function ensureProfileAuthSnapshot(profileDir: string, tool: ToolDef): void {
  if (hasAuthSnapshot(profileDir)) return;
  const authDir = profileAuthDir(profileDir);
  assertSafeWritePath(join(authDir, OAUTH_SNAPSHOT), { mustStayUnder: profileDir });
  mkdirSync(authDir, { recursive: true });

  const oauth = readOAuthFromPaths(profileAccountJsonPaths(profileDir, tool));
  if (oauth) writeJsonFile(profileOAuthSnapshot(profileDir), { oauthAccount: oauth }, profileDir);

  const credFile = join(profileDir, ".credentials.json");
  if (existsSync(credFile)) {
    const dest = profileCredentialsSnapshot(profileDir);
    assertSafeWritePath(dest, { mustStayUnder: profileDir });
    copyFileSync(credFile, dest);
  }
}

export function profileHasAuth(profileDir: string, tool: ToolDef): boolean {
  return hasAuthSnapshot(profileDir) || !!readOAuthFromPaths(profileAccountJsonPaths(profileDir, tool));
}

/** Restore profile auth snapshots onto live Claude paths. */
export function restoreClaudeAuthFromProfile(
  profileDir: string,
  tool: ToolDef,
  profileName?: string,
): void {
  if (!profileHasAuth(profileDir, tool)) {
    const label = profileName ?? "NAME";
    throw new AccountsError(
      `profile has no auth to apply — run \`accounts login ${label}\` then \`accounts detect ${label}\` first`,
    );
  }

  ensureProfileAuthSnapshot(profileDir, tool);

  const live = liveClaudePaths();
  const liveRoot = liveClaudeBase();
  mkdirSync(live.configDir, { recursive: true });

  const oauthSnap = readJsonFile(profileOAuthSnapshot(profileDir));
  const oauth =
    oauthSnap?.oauthAccount && typeof oauthSnap.oauthAccount === "object"
      ? (oauthSnap.oauthAccount as JsonRecord)
      : readOAuthFromPaths(profileAccountJsonPaths(profileDir, tool));

  if (!oauth) {
    throw new AccountsError("profile has no OAuth account data to apply");
  }

  assertSafeWritePath(live.homeJson, { mustStayUnder: liveRoot });
  mergeOAuthInto([live.homeJson], oauth, false, liveRoot);

  const credSnap = profileCredentialsSnapshot(profileDir);
  if (existsSync(credSnap)) {
    assertSafeWritePath(live.credentialsFile, { mustStayUnder: liveRoot });
    assertSafeWritePath(credSnap, { mustStayUnder: profileDir });
    copyFileSync(credSnap, live.credentialsFile);
    writeFileSync(live.credentialsFile, readFileSync(live.credentialsFile), { mode: 0o600 });
  } else if (existsSync(live.credentialsFile)) {
    if (!lstatSync(live.credentialsFile).isSymbolicLink()) unlinkSync(live.credentialsFile);
  }

  if (keychainSupported()) {
    const kcRaw = readJsonFile(profileKeychainSnapshot(profileDir));
    if (kcRaw && typeof kcRaw.secret === "string" && typeof kcRaw.account === "string") {
      const cred = {
        service: typeof kcRaw.service === "string" ? kcRaw.service : CLAUDE_KEYCHAIN_SERVICE,
        account: kcRaw.account,
        secret: kcRaw.secret,
      };
      assertAllowedKeychainCredential(cred);
      writeClaudeKeychain({
        service: CLAUDE_KEYCHAIN_SERVICE,
        account: cred.account,
        secret: cred.secret,
      });
    }
  }
}

export function hasAuthSnapshot(profileDir: string): boolean {
  return (
    existsSync(profileOAuthSnapshot(profileDir)) ||
    existsSync(profileCredentialsSnapshot(profileDir)) ||
    existsSync(profileKeychainSnapshot(profileDir))
  );
}
