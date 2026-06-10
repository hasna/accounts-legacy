import { spawnSync } from "node:child_process";
import { platform } from "node:os";
import type { Profile } from "../types.js";
import { listProfiles } from "./profiles.js";
import { getTool } from "./tools.js";

export type AgentEntry = Record<string, unknown>;

export interface ProfileAgents {
  profile: string;
  tool: string;
  email?: string;
  dir: string;
  agents: AgentEntry[];
  error?: string;
}

export interface AgentsRunnerResult {
  ok: boolean;
  raw: string;
  error?: string;
}

export type AgentsRunner = (profile: Profile) => AgentsRunnerResult;

/**
 * Extract the first top-level JSON array from output that may be wrapped in
 * pty/ANSI noise (`claude agents --json` only works on a TTY, so we run it
 * under `script` and the JSON arrives surrounded by control sequences).
 */
export function extractJsonArray(raw: string): unknown[] | undefined {
  const text = raw.replace(/\r/g, "");
  for (let start = text.indexOf("["); start !== -1; start = text.indexOf("[", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "[") depth++;
      else if (ch === "]") {
        depth--;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(start, i + 1)) as unknown;
            if (Array.isArray(parsed)) return parsed;
          } catch {
            /* not valid JSON from this bracket — try the next candidate */
          }
          break;
        }
      }
    }
  }
  return undefined;
}

/**
 * Run `<bin> agents --json` for a profile's config dir under a pseudo-TTY.
 * Claude Code switches to print-mode argument parsing when stdout is not a
 * TTY and never reaches the `agents` subcommand, so a plain pipe won't work.
 */
export function runClaudeAgentsJson(profile: Profile, timeoutMs = 20_000): AgentsRunnerResult {
  const tool = getTool(profile.tool);
  const bin = tool.bin ?? "claude";
  const env = { ...process.env, [tool.envVar]: profile.dir };
  const args =
    platform() === "darwin"
      ? ["-q", "/dev/null", bin, "agents", "--json"]
      : ["-qefc", `${bin} agents --json`, "/dev/null"];
  const res = spawnSync("script", args, {
    encoding: "utf8",
    env,
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.error) return { ok: false, raw: "", error: res.error.message };
  if (res.signal) return { ok: false, raw: res.stdout ?? "", error: `timed out (${res.signal})` };
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || "").trim().split("\n").pop() ?? "";
    return { ok: false, raw: res.stdout ?? "", error: `exit ${res.status}${detail ? `: ${detail}` : ""}` };
  }
  return { ok: true, raw: res.stdout ?? "" };
}

export interface ListAgentsOptions {
  tool?: string;
  profile?: string;
  backgroundOnly?: boolean;
  runner?: AgentsRunner;
}

/** List agent sessions for every profile of a tool (default: claude). */
export function listAgentsAcrossProfiles(opts: ListAgentsOptions = {}): ProfileAgents[] {
  const toolId = opts.tool ?? "claude";
  const runner = opts.runner ?? runClaudeAgentsJson;
  const profiles = listProfiles(toolId).filter((p) => !opts.profile || p.name === opts.profile);

  return profiles.map((profile) => {
    const base: ProfileAgents = {
      profile: profile.name,
      tool: profile.tool,
      ...(profile.email ? { email: profile.email } : {}),
      dir: profile.dir,
      agents: [],
    };
    const result = runner(profile);
    if (!result.ok) return { ...base, error: result.error ?? "failed to list agents" };

    const parsed = extractJsonArray(result.raw);
    if (!parsed) return { ...base, error: "could not parse agents output" };

    const agents = (parsed as AgentEntry[]).filter(
      (a) => !opts.backgroundOnly || a.kind === "background",
    );
    return { ...base, agents };
  });
}
