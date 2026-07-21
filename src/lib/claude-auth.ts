import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { ToolDef } from "../types.js";
import { AccountsError } from "../types.js";
import { accountsHome } from "../storage.js";
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
  type KeychainCredential,
  writeClaudeKeychain,
} from "./keychain.js";
import { assertSafeWritePath } from "./safe-path.js";

type JsonRecord = Record<string, unknown>;

interface ClaudeLiveAuthFileSnapshot {
  path: string;
  contents?: Buffer;
  mode?: number;
  merge?: "claude-home" | "claude-credentials" | "claude-settings" | "claude-keychain";
}

export interface ClaudeLiveAuthSnapshot {
  base: string;
  files: ClaudeLiveAuthFileSnapshot[];
}

export interface ClaudeProfileAuthSnapshot {
  base: string;
  files: ClaudeLiveAuthFileSnapshot[];
}

interface ClaudeProfileAuthPath {
  id: "home" | "credentials" | "settings" | "oauth-snapshot" | "credentials-snapshot" | "keychain-snapshot";
  path: string;
  merge: NonNullable<ClaudeLiveAuthFileSnapshot["merge"]>;
}

interface CommittedProfileAuthFile {
  id: ClaudeProfileAuthPath["id"];
  contents?: string;
  mode?: number;
}

interface CommittedProfileAuthSnapshot {
  version: 1;
  identity: string;
  revision: string;
  files: CommittedProfileAuthFile[];
}

export const CLAUDE_API_AUTH_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_API_KEY_HELPER",
  "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
] as const;

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

function writeJsonFileAtomic(path: string, data: JsonRecord, stayUnder: string): void {
  assertSafeWritePath(path, { mustStayUnder: stayUnder });
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  assertSafeWritePath(temp, { mustStayUnder: stayUnder });
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8" });
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // Hard-link publication is create-if-absent: unlike rename, it cannot
    // replace a destination created between preflight and publication.
    linkSync(temp, path);
    unlinkSync(temp);
    chmodSync(path, 0o600);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
  }
}

function readOAuthFromPaths(paths: string[]): JsonRecord | undefined {
  return findOAuthSource(paths)?.oauth;
}

function readOAuthSnapshot(profileDir: string): JsonRecord | undefined {
  const snap = readJsonFile(profileOAuthSnapshot(profileDir));
  const oauth = snap?.oauthAccount;
  return oauth && typeof oauth === "object" ? (oauth as JsonRecord) : undefined;
}

function profileCredentialFile(profileDir: string): string {
  return join(profileDir, ".credentials.json");
}

function profileHasOAuthAccount(profileDir: string, tool: ToolDef): boolean {
  return !!readOAuthSnapshot(profileDir) || !!readOAuthFromPaths(profileAccountJsonPaths(profileDir, tool));
}

function profileHasCredentialPayload(profileDir: string): boolean {
  return existsSync(profileCredentialFile(profileDir)) || existsSync(profileCredentialsSnapshot(profileDir));
}

export function assertRestorableProfileAuth(profileDir: string, tool: ToolDef, profileName?: string): void {
  const label = profileName ?? "NAME";
  if (!profileHasOAuthAccount(profileDir, tool)) {
    throw new AccountsError(
      `profile "${label}" has no auth to apply — run \`accounts login ${label}\` then \`accounts detect ${label}\` first`,
    );
  }
  if (!profileHasCredentialPayload(profileDir)) {
    throw new AccountsError(
      `profile "${label}" has no Claude credentials to apply — run \`accounts login ${label}\` and complete /login first`,
    );
  }
}

function findOAuthSource(paths: string[]): { path: string; oauth: JsonRecord } | undefined {
  for (const p of paths) {
    const data = readJsonFile(p);
    const oauth = data?.oauthAccount;
    if (oauth && typeof oauth === "object") return { path: p, oauth: oauth as JsonRecord };
  }
  return undefined;
}

/** True when the snapshot is missing or strictly older than its source file. */
function snapshotIsStale(sourcePath: string, snapshotPath: string): boolean {
  if (!existsSync(snapshotPath)) return true;
  try {
    return statSync(sourcePath).mtimeMs > statSync(snapshotPath).mtimeMs;
  } catch {
    return false;
  }
}

function credentialHealth(path: string):
  | { exists: false }
  | { exists: true; expiresAt: number; refreshTokenLength: number; mtimeMs: number } {
  if (!existsSync(path)) return { exists: false };
  const mtimeMs = statSync(path).mtimeMs;
  const raw = readJsonFile(path);
  const oauth = raw?.claudeAiOauth;
  if (!oauth || typeof oauth !== "object") {
    return { exists: true, expiresAt: 0, refreshTokenLength: 0, mtimeMs };
  }

  const record = oauth as JsonRecord;
  const expiresAtRaw = record.expiresAt;
  const expiresAt =
    typeof expiresAtRaw === "number"
      ? expiresAtRaw
      : typeof expiresAtRaw === "string"
        ? Date.parse(expiresAtRaw)
        : 0;
  const refreshTokenLength = typeof record.refreshToken === "string" ? record.refreshToken.length : 0;
  return {
    exists: true,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
    refreshTokenLength,
    mtimeMs,
  };
}

function betterCredential(
  a: { exists: true; expiresAt: number; refreshTokenLength: number; mtimeMs: number },
  b: { exists: true; expiresAt: number; refreshTokenLength: number; mtimeMs: number },
): typeof a {
  const now = Date.now();
  const aHasRefresh = a.refreshTokenLength > 0;
  const bHasRefresh = b.refreshTokenLength > 0;
  if (aHasRefresh !== bHasRefresh) return aHasRefresh ? a : b;

  const aUsable = aHasRefresh && a.expiresAt > now;
  const bUsable = bHasRefresh && b.expiresAt > now;
  if (aUsable !== bUsable) return aUsable ? a : b;
  if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs > b.mtimeMs ? a : b;
  if (a.expiresAt !== b.expiresAt) return a.expiresAt > b.expiresAt ? a : b;
  return a.mtimeMs > b.mtimeMs ? a : b;
}

export function liveCredentialShouldUpdateProfile(profileDir: string): boolean {
  const live = credentialHealth(liveClaudePaths().credentialsFile);
  if (!live.exists) return false;

  const profileRoot = credentialHealth(profileCredentialFile(profileDir));
  const profileSnapshot = credentialHealth(profileCredentialsSnapshot(profileDir));
  const profileCreds = [profileRoot, profileSnapshot].filter((c): c is Exclude<typeof c, { exists: false }> => c.exists);
  if (profileCreds.length === 0) return true;

  const bestProfileCred = profileCreds.reduce((best, candidate) => betterCredential(best, candidate));
  return betterCredential(live, bestProfileCred) === live;
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

function sanitizeSettingsFile(configDir: string, stayUnder: string): boolean {
  const settingsPath = join(configDir, "settings.json");
  const settings = readJsonFile(settingsPath);
  if (!settings) return false;

  let changed = false;
  if ("apiKeyHelper" in settings) {
    delete settings.apiKeyHelper;
    changed = true;
  }

  const env = settings.env;
  if (env && typeof env === "object" && !Array.isArray(env)) {
    const envRecord = env as JsonRecord;
    for (const key of CLAUDE_API_AUTH_ENV_KEYS) {
      if (key in envRecord) {
        delete envRecord[key];
        changed = true;
      }
    }
  }

  if (changed) writeJsonFile(settingsPath, settings, stayUnder);
  return changed;
}

export function sanitizeClaudeProfileApiSettings(profileDir: string, tool: ToolDef): boolean {
  if (tool.id !== "claude") return false;
  return sanitizeSettingsFile(profileDir, profileDir);
}

export function sanitizeClaudeOAuthProfileSettings(profileDir: string, tool: ToolDef): boolean {
  if (tool.id !== "claude") return false;
  if (!readOAuthSnapshot(profileDir) && !readOAuthFromPaths(profileAccountJsonPaths(profileDir, tool))) {
    return false;
  }
  return sanitizeClaudeProfileApiSettings(profileDir, tool);
}

export function sanitizeLiveClaudeOAuthSettings(): boolean {
  return sanitizeSettingsFile(liveClaudePaths().configDir, liveClaudeBase());
}

/** Capture every live Claude file that apply may replace or sanitize. */
export function captureClaudeLiveAuthSnapshot(): ClaudeLiveAuthSnapshot {
  const base = liveClaudeBase();
  const live = liveClaudePaths();
  const paths = [live.homeJson, live.credentialsFile, join(live.configDir, "settings.json")];
  return {
    base,
    files: paths.map((path) => {
      if (!existsSync(path)) return { path };
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new AccountsError(`refusing to snapshot unsafe live Claude auth path ${path}`);
      }
      return { path, contents: readFileSync(path), mode: stat.mode & 0o777 };
    }),
  };
}

function profileAuthPaths(profileDir: string): ClaudeProfileAuthPath[] {
  return [
    { id: "home", path: join(profileDir, ".claude.json"), merge: "claude-home" },
    { id: "credentials", path: join(profileDir, ".credentials.json"), merge: "claude-credentials" },
    { id: "settings", path: join(profileDir, "settings.json"), merge: "claude-settings" },
    { id: "oauth-snapshot", path: profileOAuthSnapshot(profileDir), merge: "claude-home" },
    { id: "credentials-snapshot", path: profileCredentialsSnapshot(profileDir), merge: "claude-credentials" },
    { id: "keychain-snapshot", path: profileKeychainSnapshot(profileDir), merge: "claude-keychain" },
  ];
}

function captureProfileAuthFiles(profileDir: string): ClaudeLiveAuthFileSnapshot[] {
  return profileAuthPaths(profileDir).map(({ path, merge }) => {
    if (!existsSync(path)) return { path, merge };
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new AccountsError(`refusing to snapshot unsafe Claude profile auth path ${path}`);
    }
    return { path, contents: readFileSync(path), mode: stat.mode & 0o777, merge };
  });
}

/** Capture profile-owned auth snapshots that finalization may refresh. */
export function captureClaudeProfileAuthSnapshot(profileDir: string): ClaudeProfileAuthSnapshot {
  return {
    base: profileDir,
    files: captureProfileAuthFiles(profileDir),
  };
}

function assertAuthGenerationId(value: string, label: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new AccountsError(`invalid Claude profile auth ${label}`);
  }
}

export function claudeProfileCommittedAuthPath(identity: string, revision: string): string {
  assertAuthGenerationId(identity, "identity");
  assertAuthGenerationId(revision, "revision");
  return join(accountsHome(), ".auth-commits", identity, `${revision}.json`);
}

/** Persist the exact auth state owned by a successful apply generation. */
export function writeClaudeProfileCommittedAuthSnapshot(
  profileDir: string,
  identity: string,
  revision: string,
): void {
  const files = captureProfileAuthFiles(profileDir);
  const paths = profileAuthPaths(profileDir);
  const committed: CommittedProfileAuthSnapshot = {
    version: 1,
    identity,
    revision,
    files: files.map((file, index) => ({
      id: paths[index]!.id,
      ...(file.contents ? { contents: file.contents.toString("base64") } : {}),
      ...(file.mode !== undefined ? { mode: file.mode } : {}),
    })),
  };
  const committedPath = claudeProfileCommittedAuthPath(identity, revision);
  if (existsSync(committedPath)) {
    throw new AccountsError(`refusing to overwrite committed Claude profile auth at ${committedPath}`);
  }
  writeJsonFileAtomic(committedPath, committed as unknown as JsonRecord, accountsHome());
}

interface ClaudeProfileAuthPrunePlan {
  identityDir: string;
  stale: Array<{ path: string; entry: string }>;
  priorTombstones: string[];
}

function planClaudeProfileCommittedAuthPrune(
  identity: string,
  keepRevision: string,
): ClaudeProfileAuthPrunePlan | undefined {
  assertAuthGenerationId(identity, "identity");
  assertAuthGenerationId(keepRevision, "revision");
  const identityDir = join(accountsHome(), ".auth-commits", identity);
  assertSafeWritePath(identityDir, { mustStayUnder: accountsHome() });
  if (!existsSync(identityDir)) return undefined;
  const stat = lstatSync(identityDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new AccountsError(`refusing unsafe committed Claude profile auth directory ${identityDir}`);
  }
  const keepEntry = `${keepRevision}.json`;
  const stale: Array<{ path: string; entry: string }> = [];
  const priorTombstones: string[] = [];
  let keepFound = false;
  for (const entry of readdirSync(identityDir)) {
    const path = join(identityDir, entry);
    assertSafeWritePath(path, { mustStayUnder: identityDir });
    const entryStat = lstatSync(path);
    if (!entryStat.isFile() || entryStat.isSymbolicLink()) {
      throw new AccountsError(`refusing unsafe committed Claude profile auth entry ${path}`);
    }
    if (entry === keepEntry) {
      keepFound = true;
      continue;
    }
    if (/^\.prune-[0-9a-f-]{36}-[0-9a-f-]{36}\.json$/i.test(entry)) {
      priorTombstones.push(path);
      continue;
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i.test(entry)) {
      throw new AccountsError(`refusing unexpected committed Claude profile auth entry ${entry}`);
    }
    stale.push({ path, entry });
  }
  if (!keepFound) {
    throw new AccountsError(`missing committed Claude profile auth for generation ${keepRevision}`);
  }
  return { identityDir, stale, priorTombstones };
}

/** Atomically publish retention across every auth identity touched by one apply. */
export function pruneClaudeProfileCommittedAuthSnapshotSets(
  sets: Array<{ identity: string; keepRevision: string }>,
): void {
  const unique = new Map<string, string>();
  for (const set of sets) {
    const existing = unique.get(set.identity);
    if (existing && existing !== set.keepRevision) {
      throw new AccountsError("conflicting committed Claude profile auth revisions for one identity");
    }
    unique.set(set.identity, set.keepRevision);
  }
  // Plan every identity before moving the first revision. This makes unsafe or
  // malformed state in a later identity a zero-mutation failure.
  const plans = [...unique].map(([identity, keepRevision]) =>
    planClaudeProfileCommittedAuthPrune(identity, keepRevision)
  ).filter((plan): plan is ClaudeProfileAuthPrunePlan => Boolean(plan));

  // Rename every stale revision across every identity before unlinking any of
  // them. A rename failure restores all earlier identities as one transaction.
  const transaction = randomUUID();
  const moved: Array<{ path: string; tombstone: string }> = [];
  try {
    for (const plan of plans) {
      for (const entry of plan.stale) {
        const revision = entry.entry.slice(0, -".json".length);
        const tombstone = join(plan.identityDir, `.prune-${transaction}-${revision}.json`);
        assertSafeWritePath(tombstone, { mustStayUnder: plan.identityDir });
        renameSync(entry.path, tombstone);
        moved.push({ path: entry.path, tombstone });
      }
    }
  } catch (error) {
    let restoreError: unknown;
    for (const entry of moved.reverse()) {
      try {
        renameSync(entry.tombstone, entry.path);
      } catch (candidate) {
        restoreError ??= candidate;
      }
    }
    if (restoreError) {
      throw new AccountsError("failed to restore immutable Claude auth revisions after prune failure");
    }
    throw error;
  }
  const priorTombstones = plans.flatMap((plan) => plan.priorTombstones);
  for (const path of [...priorTombstones, ...moved.map((entry) => entry.tombstone)]) {
    try {
      unlinkSync(path);
    } catch {
      // The published generation is already consistent. Retain a safe hidden
      // tombstone for a later prune instead of turning cleanup into rollback.
    }
  }
}

/** Retain only the currently published immutable commit for one auth identity. */
export function pruneClaudeProfileCommittedAuthSnapshots(identity: string, keepRevision: string): void {
  pruneClaudeProfileCommittedAuthSnapshotSets([{ identity, keepRevision }]);
}

/** Remove all immutable commits after their profile identity is unregistered. */
export function removeClaudeProfileCommittedAuthSnapshots(identity: string): void {
  assertAuthGenerationId(identity, "identity");
  const identityDir = join(accountsHome(), ".auth-commits", identity);
  assertSafeWritePath(identityDir, { mustStayUnder: accountsHome() });
  if (!existsSync(identityDir)) return;
  const stat = lstatSync(identityDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new AccountsError(`refusing unsafe committed Claude profile auth directory ${identityDir}`);
  }
  rmSync(identityDir, { recursive: true, force: true });
}

function decodeCommittedContents(value: unknown, path: string): Buffer | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new AccountsError(`invalid committed Claude profile auth contents at ${path}`);
  }
  return Buffer.from(value, "base64");
}

function readCommittedProfileAuthSnapshot(identity: string, revision: string): CommittedProfileAuthSnapshot {
  const committedPath = claudeProfileCommittedAuthPath(identity, revision);
  assertSafeWritePath(committedPath, { mustStayUnder: accountsHome() });
  if (!existsSync(committedPath)) {
    throw new AccountsError(`missing committed Claude profile auth for generation ${revision}`);
  }
  const stat = lstatSync(committedPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new AccountsError(`refusing unsafe committed Claude profile auth path ${committedPath}`);
  }
  const raw = readJsonFile(committedPath);
  if (
    raw?.version !== 1 ||
    raw.identity !== identity ||
    raw.revision !== revision ||
    !Array.isArray(raw.files)
  ) {
    throw new AccountsError(`invalid committed Claude profile auth at ${committedPath}`);
  }
  return raw as unknown as CommittedProfileAuthSnapshot;
}

export function assertClaudeProfileCommittedAuthSnapshot(identity: string, revision: string): void {
  validateCommittedProfileAuthFiles(readCommittedProfileAuthSnapshot(identity, revision), identity, revision);
}

function validateCommittedProfileAuthFiles(
  raw: CommittedProfileAuthSnapshot,
  identity: string,
  revision: string,
): ClaudeLiveAuthFileSnapshot[] {
  const committedPath = claudeProfileCommittedAuthPath(identity, revision);
  const entries = new Map<string, JsonRecord>();
  for (const value of raw.files) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new AccountsError(`invalid committed Claude profile auth entry at ${committedPath}`);
    }
    const entry = value as unknown as JsonRecord;
    if (typeof entry.id !== "string" || entries.has(entry.id)) {
      throw new AccountsError(`invalid committed Claude profile auth id at ${committedPath}`);
    }
    entries.set(entry.id, entry);
  }
  return profileAuthPaths("").map(({ id, merge }) => {
    const entry = entries.get(id);
    if (!entry) throw new AccountsError(`missing committed Claude profile auth entry ${id}`);
    const mode = entry.mode;
    if (mode !== undefined && (!Number.isInteger(mode) || Number(mode) < 0 || Number(mode) > 0o777)) {
      throw new AccountsError(`invalid committed Claude profile auth mode at ${committedPath}`);
    }
    return {
      path: id,
      contents: decodeCommittedContents(entry.contents, committedPath),
      ...(mode !== undefined ? { mode: Number(mode) } : {}),
      merge,
    };
  });
}

/** Restore the auth fields owned by the current published apply generation. */
export function restoreClaudeProfileCommittedAuthSnapshot(
  profileDir: string,
  identity: string,
  revision: string,
): void {
  const raw = readCommittedProfileAuthSnapshot(identity, revision);
  const committedFiles = validateCommittedProfileAuthFiles(raw, identity, revision);
  const paths = profileAuthPaths(profileDir);
  const files = committedFiles.map((file, index) => ({ ...file, path: paths[index]!.path }));
  restoreClaudeProfileAuthSnapshot({ base: profileDir, files });
}

function parseSnapshotJson(contents: Buffer | undefined, path: string): JsonRecord {
  if (contents === undefined) return {};
  try {
    const parsed = JSON.parse(contents.toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as JsonRecord;
  } catch {
    // Fall through to the fail-closed error below.
  }
  throw new AccountsError(`refusing to merge invalid Claude profile auth JSON at ${path}`);
}

interface PreparedMergedProfileRestore {
  file: ClaudeLiveAuthFileSnapshot;
  restored: JsonRecord;
  remove: boolean;
}

function prepareMergedProfileJson(
  snapshot: ClaudeProfileAuthSnapshot,
  file: ClaudeLiveAuthFileSnapshot,
): PreparedMergedProfileRestore {
  assertSafeWritePath(file.path, { mustStayUnder: snapshot.base });
  let current: JsonRecord = {};
  if (existsSync(file.path)) {
    const stat = lstatSync(file.path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new AccountsError(`refusing to restore unsafe Claude profile auth path ${file.path}`);
    }
    current = parseSnapshotJson(readFileSync(file.path), file.path);
  }
  const before = parseSnapshotJson(file.contents, file.path);
  const restored: JsonRecord = { ...before, ...current };

  if (file.merge === "claude-home") {
    if (Object.hasOwn(before, "oauthAccount")) restored.oauthAccount = before.oauthAccount;
    else delete restored.oauthAccount;
  } else if (file.merge === "claude-credentials") {
    if (Object.hasOwn(before, "claudeAiOauth")) restored.claudeAiOauth = before.claudeAiOauth;
    else delete restored.claudeAiOauth;
  } else if (file.merge === "claude-keychain") {
    for (const key of ["service", "account", "secret"]) {
      if (Object.hasOwn(before, key)) restored[key] = before[key];
      else delete restored[key];
    }
  } else {
    if (Object.hasOwn(before, "apiKeyHelper")) restored.apiKeyHelper = before.apiKeyHelper;
    else delete restored.apiKeyHelper;
    const beforeEnv = before.env && typeof before.env === "object" && !Array.isArray(before.env)
      ? before.env as JsonRecord
      : {};
    const currentEnv = current.env && typeof current.env === "object" && !Array.isArray(current.env)
      ? current.env as JsonRecord
      : {};
    const restoredEnv: JsonRecord = { ...beforeEnv, ...currentEnv };
    for (const key of CLAUDE_API_AUTH_ENV_KEYS) {
      if (Object.hasOwn(beforeEnv, key)) restoredEnv[key] = beforeEnv[key];
      else delete restoredEnv[key];
    }
    if (Object.keys(restoredEnv).length > 0 || Object.hasOwn(before, "env") || Object.hasOwn(current, "env")) {
      restored.env = restoredEnv;
    } else {
      delete restored.env;
    }
  }

  if (file.contents === undefined && Object.keys(restored).length === 0) {
    return { file, restored, remove: true };
  }
  return { file, restored, remove: false };
}

function applyMergedProfileJson(
  snapshot: ClaudeProfileAuthSnapshot,
  prepared: PreparedMergedProfileRestore,
): void {
  const { file, restored, remove } = prepared;
  assertSafeWritePath(file.path, { mustStayUnder: snapshot.base });
  if (remove) {
    if (!existsSync(file.path)) return;
    const stat = lstatSync(file.path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new AccountsError(`refusing to remove unsafe Claude profile auth path ${file.path}`);
    }
    unlinkSync(file.path);
    return;
  }
  writeJsonFile(file.path, restored, snapshot.base);
  chmodSync(file.path, file.mode ?? 0o600);
}

function restoreClaudeAuthSnapshot(
  snapshot: ClaudeLiveAuthSnapshot | ClaudeProfileAuthSnapshot,
  label: string,
): void {
  for (const file of snapshot.files) {
    assertSafeWritePath(file.path, { mustStayUnder: snapshot.base });
    if (file.contents === undefined) {
      if (!existsSync(file.path)) continue;
      const stat = lstatSync(file.path);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new AccountsError(`refusing to remove unsafe ${label} path ${file.path}`);
      }
      unlinkSync(file.path);
      continue;
    }
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.contents, { mode: file.mode ?? 0o600 });
    chmodSync(file.path, file.mode ?? 0o600);
  }
}

/** Restore an exact live Claude auth snapshot after failed finalization. */
export function restoreClaudeLiveAuthSnapshot(snapshot: ClaudeLiveAuthSnapshot): void {
  restoreClaudeAuthSnapshot(snapshot, "live Claude auth");
}

/** Restore exact profile-owned auth snapshots after failed finalization. */
export function restoreClaudeProfileAuthSnapshot(snapshot: ClaudeProfileAuthSnapshot): void {
  const merged = snapshot.files.filter((file) => file.merge);
  const exact = snapshot.files.filter((file) => !file.merge);
  // Preflight every destination and JSON document before the first mutation,
  // so one malformed or unsafe later file cannot leave a partial auth restore.
  const prepared = merged.map((file) => prepareMergedProfileJson(snapshot, file));
  for (const file of exact) {
    assertSafeWritePath(file.path, { mustStayUnder: snapshot.base });
    if (existsSync(file.path)) {
      const stat = lstatSync(file.path);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new AccountsError(`refusing unsafe Claude profile auth path ${file.path}`);
      }
    }
  }
  for (const item of prepared) applyMergedProfileJson(snapshot, item);
  if (exact.length > 0) restoreClaudeAuthSnapshot({ base: snapshot.base, files: exact }, "Claude profile auth");
}

/** Email address of the account currently authenticated on the live Claude paths. */
export function liveOAuthEmail(): string | undefined {
  const live = liveClaudePaths();
  const oauth = readOAuthFromPaths([live.homeJson]);
  const email = oauth?.emailAddress;
  return typeof email === "string" && email ? email : undefined;
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

    if (keychainSupported()) {
      const kc = readClaudeKeychain();
      if (kc) writeJsonFile(profileKeychainSnapshot(profileDir), kc as unknown as JsonRecord, profileDir);
    }
  }
}

/** @deprecated Use snapshotLiveAuthToProfile */
export function snapshotClaudeAuthToProfile(profileDir: string, tool: ToolDef): void {
  snapshotLiveAuthToProfile(profileDir, tool);
}

/**
 * Build auth snapshots from files already present in the profile config dir.
 * Snapshots are refreshed per-file whenever the source in the profile dir is
 * newer than the existing snapshot — a running tool rotates its OAuth tokens
 * in place, and restoring a login-time snapshot over rotated tokens logs the
 * account out (rotated-out refresh tokens are revoked server-side).
 */
export function ensureProfileAuthSnapshot(
  profileDir: string,
  tool: ToolDef,
  opts: { overwrite?: boolean } = {},
): void {
  const authDir = profileAuthDir(profileDir);
  assertSafeWritePath(join(authDir, OAUTH_SNAPSHOT), { mustStayUnder: profileDir });
  mkdirSync(authDir, { recursive: true });

  const oauthSource = findOAuthSource(profileAccountJsonPaths(profileDir, tool));
  const oauthSnap = profileOAuthSnapshot(profileDir);
  if (oauthSource && (opts.overwrite || snapshotIsStale(oauthSource.path, oauthSnap))) {
    writeJsonFile(oauthSnap, { oauthAccount: oauthSource.oauth }, profileDir);
  }

  const credFile = profileCredentialFile(profileDir);
  const credSnap = profileCredentialsSnapshot(profileDir);
  if (existsSync(credFile) && (opts.overwrite || snapshotIsStale(credFile, credSnap))) {
    assertSafeWritePath(credSnap, { mustStayUnder: profileDir });
    copyFileSync(credFile, credSnap);
  }

  sanitizeClaudeOAuthProfileSettings(profileDir, tool);
}

export function profileHasAuth(profileDir: string, tool: ToolDef): boolean {
  return profileHasOAuthAccount(profileDir, tool) && profileHasCredentialPayload(profileDir);
}

export type ClaudeProfileAuthStatus = "ok" | "missing" | "expired" | "invalid" | "unknown";

export interface ClaudeProfileAuthHealth {
  status: ClaudeProfileAuthStatus;
  valid: boolean;
  oauthAccountPresent: boolean;
  credentialPayloadPresent: boolean;
  credentialPayloadValid: boolean;
  credentialPayloadExpired: boolean;
  credentialExpiresAt?: string;
  keychainSnapshotPresent: boolean;
  snapshotPresent: boolean;
  reasons: string[];
}

interface CredentialPayloadReadiness {
  exists: boolean;
  parseableOauth: boolean;
  refreshTokenPresent: boolean;
  expired: boolean;
  expiresAt?: string;
  valid: boolean;
}

function credentialPayloadReadiness(path: string): CredentialPayloadReadiness {
  if (!existsSync(path)) {
    return {
      exists: false,
      parseableOauth: false,
      refreshTokenPresent: false,
      expired: false,
      valid: false,
    };
  }

  const health = credentialHealth(path);
  const raw = readJsonFile(path);
  const oauth = raw?.claudeAiOauth;
  if (!oauth || typeof oauth !== "object") {
    return {
      exists: true,
      parseableOauth: false,
      refreshTokenPresent: false,
      expired: false,
      valid: false,
    };
  }

  const expiresAtMs = health.exists ? health.expiresAt : 0;
  const expired = expiresAtMs > 0 && expiresAtMs <= Date.now();
  const refreshTokenPresent = health.exists && health.refreshTokenLength > 0;
  const valid = refreshTokenPresent && expiresAtMs > Date.now();
  return {
    exists: true,
    parseableOauth: true,
    refreshTokenPresent,
    expired,
    ...(expiresAtMs > 0 ? { expiresAt: new Date(expiresAtMs).toISOString() } : {}),
    valid,
  };
}

export function claudeProfileAuthHealth(profileDir: string, tool: ToolDef): ClaudeProfileAuthHealth {
  if (tool.id !== "claude") {
    return {
      status: "unknown",
      valid: false,
      oauthAccountPresent: false,
      credentialPayloadPresent: false,
      credentialPayloadValid: false,
      credentialPayloadExpired: false,
      keychainSnapshotPresent: false,
      snapshotPresent: false,
      reasons: [`auth validation is only available for Claude profiles, not ${tool.id}`],
    };
  }

  const oauthAccountPresent = profileHasOAuthAccount(profileDir, tool);
  const credentialPaths = [profileCredentialFile(profileDir), profileCredentialsSnapshot(profileDir)];
  const credentials = credentialPaths.map((path) => credentialPayloadReadiness(path));
  const existingCredentials = credentials.filter((credential) => credential.exists);
  const credentialPayloadPresent = existingCredentials.length > 0;
  const validCredential = existingCredentials.find((credential) => credential.valid);
  const expiredCredential = existingCredentials.find((credential) => credential.expired);
  const parseableInvalidCredential = existingCredentials.find(
    (credential) => credential.parseableOauth && !credential.refreshTokenPresent,
  );
  const keychainSnapshotPresent = existsSync(profileKeychainSnapshot(profileDir));
  const snapshotPresent = hasAuthSnapshot(profileDir);

  const reasons: string[] = [];
  if (!oauthAccountPresent) reasons.push("OAuth account snapshot is missing");
  if (!credentialPayloadPresent) reasons.push("credential payload is missing");
  if (!validCredential && expiredCredential) reasons.push("credential payload is expired");
  if (!validCredential && parseableInvalidCredential) reasons.push("credential payload has no refresh token");
  if (credentialPayloadPresent && !validCredential && !expiredCredential && !parseableInvalidCredential) {
    reasons.push("credential payload expiry is unknown");
  }

  let status: ClaudeProfileAuthStatus = "ok";
  if (!oauthAccountPresent || !credentialPayloadPresent) status = "missing";
  else if (!validCredential && expiredCredential) status = "expired";
  else if (!validCredential && parseableInvalidCredential) status = "invalid";
  else if (!validCredential) status = "unknown";

  return {
    status,
    valid: status === "ok",
    oauthAccountPresent,
    credentialPayloadPresent,
    credentialPayloadValid: Boolean(validCredential),
    credentialPayloadExpired: !validCredential && Boolean(expiredCredential),
    ...(validCredential?.expiresAt ?? expiredCredential?.expiresAt
      ? { credentialExpiresAt: validCredential?.expiresAt ?? expiredCredential?.expiresAt }
      : {}),
    keychainSnapshotPresent,
    snapshotPresent,
    reasons,
  };
}

function profileCredentialSource(path: string):
  | { secret: string; health: { exists: true; expiresAt: number; refreshTokenLength: number; mtimeMs: number } }
  | undefined {
  if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return undefined;
  const secret = readFileSync(path, "utf8").trim();
  if (!secret) return undefined;
  const health = credentialHealth(path);
  return health.exists ? { secret, health } : undefined;
}

function profileFileCredentialSecret(profileDir: string): string | undefined {
  const sources = [profileCredentialsSnapshot(profileDir), profileCredentialFile(profileDir)]
    .map((path) => profileCredentialSource(path))
    .filter((source): source is NonNullable<typeof source> => !!source);
  if (sources.length === 0) return undefined;
  return sources.reduce((best, candidate) =>
    betterCredential(candidate.health, best.health) === candidate.health ? candidate : best,
  ).secret;
}

function profileKeychainSnapshotAccount(profileDir: string): string | undefined {
  const kcRaw = readJsonFile(profileKeychainSnapshot(profileDir));
  if (!kcRaw || typeof kcRaw.account !== "string") return undefined;
  try {
    assertAllowedKeychainCredential({
      service: CLAUDE_KEYCHAIN_SERVICE,
      account: kcRaw.account,
      secret: "metadata-only",
    });
    return kcRaw.account;
  } catch {
    return undefined;
  }
}

function assertKeychainSnapshotAllowed(profileDir: string): KeychainCredential | undefined {
  const kcRaw = readJsonFile(profileKeychainSnapshot(profileDir));
  if (!kcRaw || typeof kcRaw.secret !== "string" || typeof kcRaw.account !== "string") return undefined;
  const cred = {
    service: typeof kcRaw.service === "string" ? kcRaw.service : CLAUDE_KEYCHAIN_SERVICE,
    account: kcRaw.account,
    secret: kcRaw.secret,
  };
  assertAllowedKeychainCredential(cred);
  return {
    service: CLAUDE_KEYCHAIN_SERVICE,
    account: cred.account,
    secret: cred.secret,
  };
}

export function claudeKeychainCredentialFromProfile(
  profileDir: string,
  profileName?: string,
): KeychainCredential | undefined {
  const fileSecret = profileFileCredentialSecret(profileDir);
  if (!fileSecret) return assertKeychainSnapshotAllowed(profileDir);
  const cred = {
    service: CLAUDE_KEYCHAIN_SERVICE,
    account: profileKeychainSnapshotAccount(profileDir) ?? profileName ?? "claude",
    secret: fileSecret,
  };
  assertAllowedKeychainCredential(cred);
  return cred;
}

export function prepareClaudeProfileKeychain(profileDir: string, tool: ToolDef, profileName?: string): boolean {
  if (tool.id !== "claude" || !keychainSupported()) return false;
  ensureProfileAuthSnapshot(profileDir, tool);
  const cred = claudeKeychainCredentialFromProfile(profileDir, profileName);
  if (!cred) return false;
  writeClaudeKeychain(cred);
  return true;
}

/** Restore profile auth snapshots onto live Claude paths. */
export function restoreClaudeAuthFromProfile(
  profileDir: string,
  tool: ToolDef,
  profileName?: string,
): void {
  ensureProfileAuthSnapshot(profileDir, tool);
  assertRestorableProfileAuth(profileDir, tool, profileName);

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

  sanitizeClaudeOAuthProfileSettings(profileDir, tool);
  sanitizeLiveClaudeOAuthSettings();

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

  prepareClaudeProfileKeychain(profileDir, tool, profileName);
}

export function hasAuthSnapshot(profileDir: string): boolean {
  return (
    existsSync(profileOAuthSnapshot(profileDir)) ||
    existsSync(profileCredentialsSnapshot(profileDir)) ||
    existsSync(profileKeychainSnapshot(profileDir))
  );
}
