import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FILE_CREDENTIALS_LINE = 'cli_auth_credentials_store = "file"';

function insertRootConfigLine(config: string, line: string): string {
  if (config.trim() === "") return `${line}\n`;
  const lines = config.split(/\r?\n/);
  const tableIndex = lines.findIndex((entry) => /^\s*\[[^\]]+\]\s*(?:#.*)?$/.test(entry));
  if (tableIndex === -1) return `${config.trimEnd()}\n\n${line}\n`;

  const before = lines.slice(0, tableIndex).join("\n").trimEnd();
  const after = lines.slice(tableIndex).join("\n").trimStart();
  return `${before}${before ? "\n\n" : ""}${line}\n\n${after}${after.endsWith("\n") ? "" : "\n"}`;
}

export function ensureCodexAppProfileConfig(profileDir: string): void {
  mkdirSync(profileDir, { recursive: true });
  const configPath = join(profileDir, "config.toml");
  const current = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  if (/^\s*cli_auth_credentials_store\s*=/.test(current)) return;
  writeFileSync(configPath, insertRootConfigLine(current, FILE_CREDENTIALS_LINE), { mode: 0o600 });
}
