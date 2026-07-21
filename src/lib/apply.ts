import type { Profile, ToolDef } from "../types.js";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { AccountsError } from "../types.js";
import {
  loadAppliedMap,
  findProfileAuthRevisionKey,
  loadMachineStore,
  loadStore,
  parkedProfileAuthRevisionKey,
  profileAuthIncarnation,
  profileAuthRevisionKey,
  saveStore,
  withStoreLock,
} from "../storage.js";
import { getTool } from "./tools.js";
import { resolveStore, type AccountsStore } from "./store.js";
import {
  assertRestorableProfileAuth,
  captureClaudeLiveAuthSnapshot,
  captureClaudeProfileAuthSnapshot,
  ensureProfileAuthSnapshot,
  liveCredentialShouldUpdateProfile,
  liveOAuthEmail,
  pruneClaudeProfileCommittedAuthSnapshotSets,
  restoreClaudeAuthFromProfile,
  restoreClaudeLiveAuthSnapshot,
  restoreClaudeProfileAuthSnapshot,
  snapshotLiveAuthToProfile,
  writeClaudeProfileCommittedAuthSnapshot,
  type ClaudeLiveAuthSnapshot,
  type ClaudeProfileAuthSnapshot,
} from "./claude-auth.js";
import { withApplyLockAsync } from "./apply-lock.js";
import { acquireClaudeKeychainLock } from "./claude-launch.js";
import {
  captureClaudeKeychain,
  keychainSupported,
  restoreClaudeKeychain,
  type KeychainCredential,
} from "./keychain.js";

export interface ApplyRollbackState {
  liveClaude: ClaudeLiveAuthSnapshot;
  applied?: { name: string; revision?: string };
  profileAuthSnapshots: ClaudeProfileAuthSnapshot[];
  profileAuthRefs: Array<{
    key: string;
    identity?: string;
    commitRevision?: string;
    incarnation?: string;
  }>;
  profileAuthWrites: Array<{
    key: string;
    identity: string | null;
    commitRevision: string | null;
    incarnation: string | null;
  }>;
}

/** True only while every auth slot written by this apply is still unchanged. */
export function ownsApplyAuthWrites(
  local: ReturnType<typeof loadMachineStore>,
  rollback: ApplyRollbackState,
): boolean {
  return rollback.profileAuthWrites.every((write) =>
    (local.profileAuthRevisions[write.key] ?? null) === write.identity &&
    (local.profileAuthCommitRevisions[write.key] ?? null) === write.commitRevision &&
    (local.profileAuthIncarnations[write.key] ?? null) === write.incarnation
  );
}

export interface ApplyTransactionTracker {
  applyStarted?: boolean;
  appliedRevision?: string;
  currentRevision?: string;
  currentOperationId?: string;
  currentPreviousName?: string;
  currentPreviousProfileLastUsedAt?: string;
  profileAuthSnapshots?: ClaudeProfileAuthSnapshot[];
  applyRollback?: ApplyRollbackState;
  keychainLeaseHeld?: boolean;
}

function singleMatch(profiles: Profile[]): Profile | undefined {
  return profiles.length === 1 ? profiles[0] : undefined;
}

/**
 * The `applied` pointer (which profile's Claude auth is currently restored to
 * the live default paths) is genuinely machine-local: it tracks on-disk auth on
 * THIS machine, so it lives in the local JSON store — never in the shared
 * registry. In api mode the profile record itself lives in the cloud, so this
 * best-effort lookup only resolves a full record when the profile is also known
 * locally; callers that just need the name read `loadStore().applied` directly.
 */
export function appliedProfile(toolId: string): Profile | undefined {
  const store = loadStore();
  const name = store.applied[toolId];
  if (!name) return undefined;
  return store.profiles.find((p) => p.name === name && p.tool === toolId);
}

export function appliedProfileName(toolId: string): string | undefined {
  return loadAppliedMap()[toolId];
}

/**
 * Apply a profile's auth to the tool's live default paths (IDE-friendly).
 * Snapshots the previously applied profile's auth before switching.
 *
 * The profile record and the shared "current" selection are read/written
 * through the Store (cloud in api mode, local JSON otherwise). Only the on-disk
 * Claude auth work and the machine-local `applied` pointer touch local files,
 * guarded by the cross-process apply lock.
 */
export async function applyProfile(
  name: string,
  toolId?: string,
  store: AccountsStore = resolveStore(),
  tracker?: ApplyTransactionTracker,
  expectedProfile?: Profile,
): Promise<{ profile: Profile; previous?: string; appliedRevision: string; currentRevision?: string }> {
  if (!store.useProfileForLogin || !store.restoreCurrentOperation) {
    throw new AccountsError(
      "the configured Accounts store does not support transactional apply activation and rollback; " +
      "upgrade the custom store before running accounts apply",
    );
  }
  const useProfileForLogin = store.useProfileForLogin.bind(store);
  const profile = await store.getProfile(name, toolId);
  if (
    expectedProfile &&
    (profile.tool !== expectedProfile.tool ||
      profile.name !== expectedProfile.name ||
      (expectedProfile.incarnationId
        ? profile.incarnationId !== expectedProfile.incarnationId
        : profileAuthIncarnation(profile) !== profileAuthIncarnation(expectedProfile)))
  ) {
    throw new AccountsError("profile changed while its Claude auth was being applied");
  }
  const tool = getTool(profile.tool);

  if (tool.id !== "claude") {
    throw new AccountsError(
      `apply is only supported for Claude Code today (tool "${tool.id}"). Use \`accounts launch ${name}\` for isolated switching.`,
    );
  }

  // The owner-detection heuristic needs the registry's view of this tool's
  // profiles; fetch it via the Store before taking the (synchronous) lock so no
  // async work happens while the lock file is held.
  const toolProfiles = await store.listProfiles(tool.id);
  let releaseKeychainLease: (() => void) | undefined;
  if (keychainSupported() && !tracker?.keychainLeaseHeld) {
    releaseKeychainLease = await acquireClaudeKeychainLock();
  }
  let keychainBefore: KeychainCredential | undefined;
  try {
    keychainBefore = keychainSupported() ? captureClaudeKeychain() : undefined;
    return await withApplyLockAsync(async () => {
      let result: ReturnType<typeof applyProfileAuth>;
      try {
        if (tracker) tracker.applyStarted = true;
        result = applyProfileAuth(profile, tool, toolProfiles, tracker);
      } catch (error) {
        restoreKeychainAfterFailure(keychainBefore, error);
      }
      if (tracker) tracker.appliedRevision = result.appliedRevision;
      const operationId = randomUUID();
      if (tracker) tracker.currentOperationId = operationId;
      let active;
      try {
        active = await useProfileForLogin(profile.name, tool.id, operationId, expectedProfile ?? profile);
      } catch (error) {
        if (tracker) throw error;
        await rollbackAppliedState(
          result.rollback,
          profile.name,
          result.appliedRevision,
          keychainBefore,
          () => store.restoreCurrentOperation!(tool.id, profile.name, operationId),
          error,
        );
      }
      if (!active) throw new AccountsError("apply activation ended without a committed result");
      if (
        active.profile.createdAt !== profile.createdAt ||
        resolve(active.profile.dir) !== resolve(profile.dir) ||
        (profile.incarnationId && active.profile.incarnationId !== profile.incarnationId)
      ) {
        const error = new AccountsError("profile changed while its Claude auth was being applied; apply rolled back");
        if (tracker) throw error;
        await rollbackAppliedState(
          result.rollback,
          profile.name,
          result.appliedRevision,
          keychainBefore,
          () => store.restoreCurrentOperation!(tool.id, profile.name, operationId),
          error,
        );
      }
      if (tracker) tracker.currentRevision = active.currentRevision;
      if (tracker) tracker.currentPreviousName = active.previousCurrentName;
      if (tracker) tracker.currentPreviousProfileLastUsedAt = active.previousProfileLastUsedAt;
      if (!tracker) {
        pruneClaudeProfileCommittedAuthSnapshotSets(
          result.rollback.profileAuthWrites.flatMap((write) =>
            write.identity && write.commitRevision
              ? [{ identity: write.identity, keepRevision: write.commitRevision }]
              : []
          ),
        );
      }
      return { ...result, profile: active.profile, currentRevision: active.currentRevision };
    });
  } finally {
    releaseKeychainLease?.();
  }
}

function restoreKeychainAfterFailure(previous: KeychainCredential | undefined, original: unknown): never {
  if (!keychainSupported()) throw original;
  try {
    restoreClaudeKeychain(previous);
  } catch {
    const message = original instanceof Error ? original.message : String(original);
    throw new AccountsError(`${message}; failed to restore the prior Claude keychain state`);
  }
  throw original;
}

async function rollbackAppliedState(
  rollback: ApplyRollbackState,
  expectedName: string,
  expectedRevision: string,
  keychainBefore: KeychainCredential | undefined,
  restoreCurrent: () => Promise<boolean>,
  original: unknown,
): Promise<never> {
  let rollbackFailed = false;
  try {
    await restoreCurrent();
  } catch {
    rollbackFailed = true;
  }
  try {
    withStoreLock(() => {
      const local = loadMachineStore();
      if (
        local.applied.claude !== expectedName ||
        local.appliedRevisions.claude !== expectedRevision ||
        !ownsApplyAuthWrites(local, rollback)
      ) return;
      for (const snapshot of [...rollback.profileAuthSnapshots].reverse()) {
        restoreClaudeProfileAuthSnapshot(snapshot);
      }
      restoreClaudeLiveAuthSnapshot(rollback.liveClaude);
      restoreProfileAuthRefs(local, rollback.profileAuthRefs);
      if (rollback.applied) {
        local.applied.claude = rollback.applied.name;
        local.appliedRevisions.claude = randomUUID();
      } else {
        delete local.applied.claude;
        delete local.appliedRevisions.claude;
      }
      saveStore(local);
    });
  } catch {
    rollbackFailed = true;
  }
  try {
    if (keychainSupported()) restoreClaudeKeychain(keychainBefore);
  } catch {
    rollbackFailed = true;
  }
  if (rollbackFailed) {
    const message = original instanceof Error ? original.message : String(original);
    throw new AccountsError(`${message}; failed to roll back the interrupted apply transaction`);
  }
  throw original;
}

function restoreProfileAuthRefs(
  local: ReturnType<typeof loadMachineStore>,
  refs: ApplyRollbackState["profileAuthRefs"],
): void {
  for (const ref of refs) {
    if (ref.identity) local.profileAuthRevisions[ref.key] = ref.identity;
    else delete local.profileAuthRevisions[ref.key];
    if (ref.commitRevision) local.profileAuthCommitRevisions[ref.key] = ref.commitRevision;
    else delete local.profileAuthCommitRevisions[ref.key];
    if (ref.incarnation) local.profileAuthIncarnations[ref.key] = ref.incarnation;
    else delete local.profileAuthIncarnations[ref.key];
  }
}

function captureProfileAuthRef(
  local: ReturnType<typeof loadMachineStore>,
  refs: ApplyRollbackState["profileAuthRefs"],
  key: string,
): void {
  if (refs.some((ref) => ref.key === key)) return;
  const identity = local.profileAuthRevisions[key];
  const commitRevision = local.profileAuthCommitRevisions[key];
  const incarnation = local.profileAuthIncarnations[key];
  refs.push({
    key,
    ...(identity ? { identity } : {}),
    ...(commitRevision ? { commitRevision } : {}),
    ...(incarnation ? { incarnation } : {}),
  });
}

function adoptProfileAuthIncarnation(
  local: ReturnType<typeof loadMachineStore>,
  refs: ApplyRollbackState["profileAuthRefs"],
  profile: Profile,
): string {
  const targetKey = profileAuthRevisionKey(profile.tool, profile.name);
  const sourceKey = findProfileAuthRevisionKey(local, profile);
  captureProfileAuthRef(local, refs, targetKey);
  const incarnation = profileAuthIncarnation(profile);
  const displacedIncarnation = local.profileAuthIncarnations[targetKey];
  if (displacedIncarnation && displacedIncarnation !== incarnation) {
    const parkedKey = parkedProfileAuthRevisionKey(displacedIncarnation);
    captureProfileAuthRef(local, refs, parkedKey);
    if (
      local.profileAuthRevisions[parkedKey] ||
      local.profileAuthCommitRevisions[parkedKey] ||
      local.profileAuthIncarnations[parkedKey]
    ) {
      throw new AccountsError("duplicate parked profile auth ownership");
    }
    const displacedIdentity = local.profileAuthRevisions[targetKey];
    const displacedCommit = local.profileAuthCommitRevisions[targetKey];
    delete local.profileAuthRevisions[targetKey];
    delete local.profileAuthCommitRevisions[targetKey];
    delete local.profileAuthIncarnations[targetKey];
    if (displacedIdentity) local.profileAuthRevisions[parkedKey] = displacedIdentity;
    if (displacedCommit) local.profileAuthCommitRevisions[parkedKey] = displacedCommit;
    local.profileAuthIncarnations[parkedKey] = displacedIncarnation;
  }
  if (sourceKey && sourceKey !== targetKey) {
    captureProfileAuthRef(local, refs, sourceKey);
    const identity = local.profileAuthRevisions[sourceKey];
    const commitRevision = local.profileAuthCommitRevisions[sourceKey];
    delete local.profileAuthRevisions[sourceKey];
    delete local.profileAuthCommitRevisions[sourceKey];
    delete local.profileAuthIncarnations[sourceKey];
    if (identity) local.profileAuthRevisions[targetKey] = identity;
    if (commitRevision) local.profileAuthCommitRevisions[targetKey] = commitRevision;
  }
  local.profileAuthIncarnations[targetKey] = incarnation;
  return targetKey;
}

/** Synchronous, machine-local disk work for apply (runs under the apply lock). */
function applyProfileAuth(
  profile: Profile,
  tool: ToolDef,
  toolProfiles: Profile[],
  tracker?: ApplyTransactionTracker,
): { profile: Profile; previous?: string; appliedRevision: string; rollback: ApplyRollbackState } {
  assertRestorableProfileAuth(profile.dir, tool, profile.name);
  return withStoreLock(() => {
    const local = loadMachineStore();
    const previous = local.applied[tool.id];
    const rollback: ApplyRollbackState = {
      liveClaude: captureClaudeLiveAuthSnapshot(),
      ...(previous
        ? { applied: { name: previous, ...(local.appliedRevisions[tool.id] ? { revision: local.appliedRevisions[tool.id] } : {}) } }
        : {}),
      profileAuthSnapshots: [captureClaudeProfileAuthSnapshot(profile.dir)],
      profileAuthRefs: [],
      profileAuthWrites: [],
    };
    const targetAuthKey = adoptProfileAuthIncarnation(local, rollback.profileAuthRefs, profile);
    const touchedProfiles = new Map<string, Profile>([[targetAuthKey, profile]]);
    if (tracker) tracker.applyRollback = rollback;

    // Preserve whatever auth is currently live by snapshotting it into the
    // profile that actually owns it. The live OAuth email is the source of
    // truth — the applied pointer goes stale when the user logs in directly
    // on the live paths (e.g. `claude /login`), and trusting it would clobber
    // another profile's snapshot with the wrong account's tokens.
    const liveEmail = liveOAuthEmail();
    const owner =
      (liveEmail && singleMatch(toolProfiles.filter((p) => p.email === liveEmail))) ||
      (previous ? toolProfiles.find((p) => p.name === previous) : undefined);
    if (
      owner &&
      (!(owner.name === profile.name && owner.tool === profile.tool) ||
        liveCredentialShouldUpdateProfile(profile.dir))
    ) {
      if (tracker && !tracker.profileAuthSnapshots?.some((snapshot) => snapshot.base === owner.dir)) {
        (tracker.profileAuthSnapshots ??= []).push(captureClaudeProfileAuthSnapshot(owner.dir));
      }
      if (!rollback.profileAuthSnapshots.some((snapshot) => snapshot.base === owner.dir)) {
        rollback.profileAuthSnapshots.push(captureClaudeProfileAuthSnapshot(owner.dir));
      }
      const ownerAuthKey = adoptProfileAuthIncarnation(local, rollback.profileAuthRefs, owner);
      touchedProfiles.set(ownerAuthKey, owner);
      try {
        snapshotLiveAuthToProfile(owner.dir, tool);
      } catch (error) {
        for (const snapshot of [...rollback.profileAuthSnapshots].reverse()) restoreClaudeProfileAuthSnapshot(snapshot);
        restoreClaudeLiveAuthSnapshot(rollback.liveClaude);
        throw error;
      }
    }
    try {
      ensureProfileAuthSnapshot(profile.dir, tool);
      restoreClaudeAuthFromProfile(profile.dir, tool, profile.name);

      local.applied[tool.id] = profile.name;
      const appliedRevision = randomUUID();
      local.appliedRevisions[tool.id] = appliedRevision;
      for (const [authKey, touchedProfile] of touchedProfiles) {
        const authIdentity = local.profileAuthRevisions[authKey] ?? randomUUID();
        const authCommitRevision = randomUUID();
        writeClaudeProfileCommittedAuthSnapshot(
          touchedProfile.dir,
          authIdentity,
          authCommitRevision,
        );
        local.profileAuthRevisions[authKey] = authIdentity;
        local.profileAuthCommitRevisions[authKey] = authCommitRevision;
        local.profileAuthIncarnations[authKey] = profileAuthIncarnation(touchedProfile);
      }
      const writtenAuthKeys = new Set([
        ...rollback.profileAuthRefs.map((ref) => ref.key),
        ...touchedProfiles.keys(),
      ]);
      rollback.profileAuthWrites = [...writtenAuthKeys].map((key) => ({
        key,
        identity: local.profileAuthRevisions[key] ?? null,
        commitRevision: local.profileAuthCommitRevisions[key] ?? null,
        incarnation: local.profileAuthIncarnations[key] ?? null,
      }));
      saveStore(local);

      return { profile, appliedRevision, rollback, ...(previous && previous !== profile.name ? { previous } : {}) };
    } catch (error) {
      for (const snapshot of [...rollback.profileAuthSnapshots].reverse()) restoreClaudeProfileAuthSnapshot(snapshot);
      restoreClaudeLiveAuthSnapshot(rollback.liveClaude);
      restoreProfileAuthRefs(local, rollback.profileAuthRefs);
      throw error;
    }
  });
}
