import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  releaseAbandonedLoginJournalLocks,
  type LoginRecoveryJournal,
} from "./login-recovery.js";

let home: string;
let profileLock: string | undefined;

beforeEach(() => {
  profileLock = undefined;
  home = mkdtempSync(join(tmpdir(), "accounts-login-recovery-test-"));
  process.env.ACCOUNTS_HOME = home;
  process.env.ACCOUNTS_TEST_KEYCHAIN_LOCK_PATH = join(home, "keychain.lock");
});

afterEach(() => {
  if (profileLock) rmSync(profileLock, { force: true });
  rmSync(home, { recursive: true, force: true });
  delete process.env.ACCOUNTS_HOME;
  delete process.env.ACCOUNTS_TEST_KEYCHAIN_LOCK_PATH;
});

test.skipIf(process.platform !== "linux")(
  "reclaims exact stale-incarnation locks when the owner PID was reused",
  () => {
    const profileDir = join(home, "profiles", "claude", "acct");
    const uid = typeof process.getuid === "function" ? process.getuid() : "user";
    const identity = createHash("sha256").update(profileDir).digest("hex").slice(0, 32);
    profileLock = join("/tmp", `accounts-claude-login-${uid}-${identity}.lock`);
    const keychainLock = process.env.ACCOUNTS_TEST_KEYCHAIN_LOCK_PATH!;
    const exactOwnerToken = `${process.pid}:${randomUUID()}\n`;
    writeFileSync(profileLock, exactOwnerToken, { mode: 0o600 });
    writeFileSync(keychainLock, exactOwnerToken, { mode: 0o600 });

    releaseAbandonedLoginJournalLocks({
      ownerPid: process.pid,
      ownerProcessStartId: "linux-0",
      preparation: {
        tool: { id: "claude" },
        profile: { dir: profileDir },
      },
    } as unknown as LoginRecoveryJournal);

    expect(existsSync(profileLock)).toBe(false);
    expect(existsSync(keychainLock)).toBe(false);
  },
);
