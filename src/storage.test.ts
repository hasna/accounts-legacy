import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProfile } from "./lib/profiles.js";
import {
  ACCOUNTS_STORAGE_ENV,
  accountsStorageSnapshotKey,
  createAccountsStorageSnapshot,
  getAccountsStorageStatus,
  restoreAccountsStorageSnapshot,
  storageSync,
} from "./storage.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "accounts-storage-test-"));
  process.env.ACCOUNTS_HOME = home;
  delete process.env.ACCOUNTS_STORE_PATH;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.ACCOUNTS_HOME;
});

function runStorageCli(...args: string[]) {
  return spawnSync(process.execPath, ["run", "src/cli.ts", "storage", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ACCOUNTS_HOME: home,
      ACCOUNTS_STORE_PATH: "",
      ACCOUNTS_STORAGE_MODE: "",
      ACCOUNTS_S3_BUCKET: "",
      HASNA_ACCOUNTS_STORAGE_MODE: "",
      HASNA_ACCOUNTS_S3_BUCKET: "",
    },
  });
}

test("storage status exposes local paths and canonical S3 env names", () => {
  const status = getAccountsStorageStatus({});

  expect(status.mode).toBe("local");
  expect(status.local.home).toBe(home);
  expect(status.remote.configured).toBe(false);
  expect(status.env.s3Bucket).toBe(ACCOUNTS_STORAGE_ENV.s3Bucket);
  expect(status.tables).toEqual([]);
});

test("creates and restores local accounts storage snapshots", () => {
  addProfile({ name: "work", tool: "claude", email: "work@example.test" });
  const snapshot = createAccountsStorageSnapshot({ HASNA_ACCOUNTS_MACHINE_ID: "test-machine" });

  expect(snapshot.source).toBe("accounts");
  expect(snapshot.machineId).toBe("test-machine");
  expect(snapshot.store.profiles[0]?.email).toBe("work@example.test");

  rmSync(home, { recursive: true, force: true });
  restoreAccountsStorageSnapshot(snapshot);
  const restored = createAccountsStorageSnapshot();
  expect(restored.store.profiles[0]?.name).toBe("work");
});

test("sync is a no-op until S3 is configured", async () => {
  const result = await storageSync({});

  expect(result.skipped).toBe(true);
  expect(result.reason).toContain("S3 bucket is not configured");
  expect(result.key).toBe("accounts/accounts.json");
});

test("storage CLI status emits local JSON without remote config", () => {
  const result = runStorageCli("status", "--json");

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout) as ReturnType<typeof getAccountsStorageStatus>;
  expect(payload.mode).toBe("local");
  expect(payload.local.home).toBe(home);
  expect(payload.remote.configured).toBe(false);
  expect(payload.env.s3Bucket).toBe(ACCOUNTS_STORAGE_ENV.s3Bucket);
});

test("storage CLI sync skips cleanly without remote config", () => {
  const result = runStorageCli("sync", "--json");

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout) as Awaited<ReturnType<typeof storageSync>>;
  expect(payload.skipped).toBe(true);
  expect(payload.reason).toContain("S3 bucket is not configured");
  expect(payload.key).toBe("accounts/accounts.json");
});

test("snapshot key respects configured S3 prefix", () => {
  expect(accountsStorageSnapshotKey({ HASNA_ACCOUNTS_S3_PREFIX: "internal/accounts" })).toBe("internal/accounts/accounts.json");
});
