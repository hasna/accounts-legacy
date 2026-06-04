import type { Profile } from "../types.js";
import { applyProfile } from "./apply.js";
import { ensureProfileAuthSnapshot } from "./claude-auth.js";
import { getProfile, redetectEmail, useProfile } from "./profiles.js";
import { getTool } from "./tools.js";

export interface FinalizeLoginResult {
  profile: Profile;
  applied: boolean;
}

/**
 * Finish an isolated login after the tool process exits successfully.
 * Claude login becomes the live/default account; other tools are marked active
 * and have metadata re-detected where possible.
 */
export function finalizeLogin(name: string, toolId?: string): FinalizeLoginResult {
  const profile = getProfile(name, toolId);
  const tool = getTool(profile.tool);

  if (tool.id === "claude") {
    ensureProfileAuthSnapshot(profile.dir, tool, { overwrite: true });
    redetectEmail(name, tool.id);
    return { profile: applyProfile(name, tool.id).profile, applied: true };
  }

  const updated = redetectEmail(name, tool.id);
  useProfile(name, tool.id);
  return { profile: updated, applied: false };
}
