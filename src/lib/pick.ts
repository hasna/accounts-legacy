import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { Profile } from "../types.js";
import { AccountsError } from "../types.js";
import { listProfiles, currentProfile } from "./profiles.js";
import { appliedProfile } from "./apply.js";

export interface PickOptions {
  tool?: string;
  mode?: "apply" | "env" | "none";
}

/** Map CLI flags to pick mode (Commander `--no-act` → `act: false`). */
export function resolvePickMode(opts: { env?: boolean; act?: boolean }): PickOptions["mode"] {
  if (opts.act === false) return "none";
  if (opts.env) return "env";
  return "apply";
}

export interface PickResult {
  profile: Profile;
  mode: "apply" | "env" | "none";
}

export async function pickProfile(opts: PickOptions = {}): Promise<PickResult | undefined> {
  const profiles = listProfiles(opts.tool);
  if (profiles.length === 0) {
    throw new AccountsError("no profiles — create one with `accounts add <name>` or `accounts import`");
  }

  console.log("");
  for (let i = 0; i < profiles.length; i++) {
    const p = profiles[i]!;
    const markers: string[] = [];
    if (currentProfile(p.tool)?.name === p.name) markers.push("active");
    if (appliedProfile(p.tool)?.name === p.name) markers.push("applied");
    const tag = markers.length ? ` (${markers.join(", ")})` : "";
    const email = p.email ? ` ${p.email}` : "";
    console.log(`  ${i + 1}. ${p.name}${email}${tag}`);
  }
  console.log("");

  const rl = readline.createInterface({ input, output });
  const answer = await rl.question("Select profile [1-" + profiles.length + "]: ");
  rl.close();

  const idx = Number.parseInt(answer.trim(), 10) - 1;
  if (Number.isNaN(idx) || idx < 0 || idx >= profiles.length) {
    throw new AccountsError("invalid selection");
  }

  const profile = profiles[idx]!;
  const mode = opts.mode ?? "apply";
  return { profile, mode };
}
