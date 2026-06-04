import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type Store, storeSchema, AccountsError, profileNameSchema } from "./types.js";
import { assertSafeWritePath } from "./lib/safe-path.js";

function validateEnvPath(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\0") || /[\r\n]/.test(trimmed)) {
    throw new AccountsError(`invalid ${label}`);
  }
  return trimmed;
}

/** Base directory for all accounts state. Override with `ACCOUNTS_HOME`. */
export function accountsHome(): string {
  const override = process.env.ACCOUNTS_HOME;
  if (override && override.trim()) return validateEnvPath(override, "ACCOUNTS_HOME");
  return join(homedir(), ".hasna", "accounts");
}

/** Path to the registry file. Override with `ACCOUNTS_STORE_PATH`. */
export function storePath(): string {
  const override = process.env.ACCOUNTS_STORE_PATH;
  if (override && override.trim()) return validateEnvPath(override, "ACCOUNTS_STORE_PATH");
  return join(accountsHome(), "accounts.json");
}

/** Base directory under which managed profile config dirs are created. */
export function profilesDir(): string {
  return join(accountsHome(), "profiles");
}

const EMPTY_STORE: Store = { version: 1, current: {}, applied: {}, profiles: [], tools: [] };

export function loadStore(): Store {
  const path = storePath();
  if (!existsSync(path)) return structuredClone(EMPTY_STORE);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new AccountsError(`could not parse store at ${path}: ${(err as Error).message}`);
  }
  const parsed = storeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AccountsError(`invalid store at ${path}: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  const store = parsed.data;
  for (const p of store.profiles) {
    const check = profileNameSchema.safeParse(p.name);
    if (!check.success) {
      throw new AccountsError(`invalid profile name in store "${p.name}": ${check.error.issues[0]?.message}`);
    }
  }
  for (const toolId of Object.keys(store.current)) {
    const name = store.current[toolId];
    if (!name || !profileNameSchema.safeParse(name).success) delete store.current[toolId];
    else if (!store.profiles.some((p) => p.name === name && p.tool === toolId)) delete store.current[toolId];
  }
  for (const toolId of Object.keys(store.applied)) {
    const name = store.applied[toolId];
    if (!name || !profileNameSchema.safeParse(name).success) delete store.applied[toolId];
    else if (!store.profiles.some((p) => p.name === name && p.tool === toolId)) delete store.applied[toolId];
  }
  return store;
}

export function saveStore(store: Store): void {
  const path = storePath();
  assertSafeWritePath(path, { mustStayUnder: accountsHome() });
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
}
