import type { Profile } from "../types.js";
import { AccountsError } from "../types.js";
import { loadStore, saveStore } from "../storage.js";
import { getTool } from "./tools.js";
import { getProfile, useProfile } from "./profiles.js";
import {
  ensureProfileAuthSnapshot,
  profileHasAuth,
  restoreClaudeAuthFromProfile,
  snapshotLiveAuthToProfile,
} from "./claude-auth.js";
import { withApplyLock } from "./apply-lock.js";

export function appliedProfile(toolId: string): Profile | undefined {
  const store = loadStore();
  const name = store.applied[toolId];
  if (!name) return undefined;
  return store.profiles.find((p) => p.name === name && p.tool === toolId);
}

/**
 * Apply a profile's auth to the tool's live default paths (IDE-friendly).
 * Snapshots the previously applied profile's auth before switching.
 */
export function applyProfile(name: string, toolId?: string): { profile: Profile; previous?: string } {
  return withApplyLock(() => applyProfileUnlocked(name, toolId));
}

function applyProfileUnlocked(name: string, toolId?: string): { profile: Profile; previous?: string } {
  const profile = getProfile(name, toolId);
  const tool = getTool(profile.tool);

  if (tool.id !== "claude") {
    throw new AccountsError(
      `apply is only supported for Claude Code today (tool "${tool.id}"). Use \`accounts launch ${name}\` for isolated switching.`,
    );
  }

  if (!profileHasAuth(profile.dir, tool)) {
    throw new AccountsError(
      `profile "${name}" has no auth to apply — run \`accounts login ${name}\` then \`accounts detect ${name}\` first`,
    );
  }

  const store = loadStore();
  const previous = store.applied[tool.id];

  if (previous && previous !== name) {
    const prevProfile = store.profiles.find((p) => p.name === previous && p.tool === tool.id);
    if (prevProfile) snapshotLiveAuthToProfile(prevProfile.dir, tool);
  }

  ensureProfileAuthSnapshot(profile.dir, tool);
  restoreClaudeAuthFromProfile(profile.dir, tool, name);

  store.applied[tool.id] = name;
  saveStore(store);
  useProfile(name, tool.id);

  return { profile, ...(previous && previous !== name ? { previous } : {}) };
}
