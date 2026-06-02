import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ToolDef } from "../types.js";

/**
 * Best-effort: read the account email a tool stored inside its config dir.
 * For Claude Code this is `<dir>/.claude.json` -> oauthAccount.emailAddress.
 *
 * When `CLAUDE_CONFIG_DIR` is set, Claude Code writes `.claude.json` inside that
 * dir. But the DEFAULT install keeps it one level up at `~/.claude.json` (next to
 * the `~/.claude` dir). So when importing the tool's default dir we also check the
 * parent dir. Returns undefined when no email can be found.
 */
export function detectEmail(dir: string, tool: ToolDef): string | undefined {
  if (!tool.accountFile || !tool.emailPath) return undefined;
  const candidates = [join(dir, tool.accountFile)];
  if (dir === tool.defaultDir) candidates.push(join(dirname(dir), tool.accountFile));
  for (const file of candidates) {
    const email = readEmail(file, tool.emailPath);
    if (email) return email;
  }
  return undefined;
}

function readEmail(file: string, path: string[]): string | undefined {
  if (!existsSync(file)) return undefined;
  let cursor: unknown;
  try {
    cursor = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  for (const key of path) {
    if (cursor && typeof cursor === "object" && key in (cursor as Record<string, unknown>)) {
      cursor = (cursor as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return typeof cursor === "string" && cursor.includes("@") ? cursor : undefined;
}
