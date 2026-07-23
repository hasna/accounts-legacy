import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serialize } from "node:v8";
import {
  recoverAbandonedLoginLeaseIntents,
  releaseAbandonedLoginJournalLocks,
  type LoginRecoveryJournal,
} from "./login-recovery.js";
import { acquireClaudeKeychainLock } from "./claude-launch.js";
import { setBeforeExactProcessLockClaimForTest } from "./exact-process-lock.js";

let home: string;
let profileLock: string | undefined;

beforeEach(() => {
  profileLock = undefined;
  home = mkdtempSync(join(tmpdir(), "accounts-login-recovery-test-"));
  process.env.ACCOUNTS_HOME = home;
  process.env.ACCOUNTS_TEST_KEYCHAIN_LOCK_PATH = join(home, "keychain.lock");
});

afterEach(() => {
  setBeforeExactProcessLockClaimForTest(undefined);
  if (profileLock) rmSync(profileLock, { force: true });
  rmSync(home, { recursive: true, force: true });
  delete process.env.ACCOUNTS_HOME;
  delete process.env.ACCOUNTS_TEST_KEYCHAIN_LOCK_PATH;
});

test.skipIf(process.platform !== "linux")(
  "does not unlink a live successor that replaces an observed abandoned process lock",
  async () => {
    const profileDir = join(home, "profiles", "claude", "acct");
    const keychainLock = process.env.ACCOUNTS_TEST_KEYCHAIN_LOCK_PATH!;
    const abandonedToken = `${process.pid}:${randomUUID()}`;
    const successorToken = `${process.pid}:${randomUUID()}`;
    const releaseAbandoned = await acquireClaudeKeychainLock(undefined, abandonedToken);

    setBeforeExactProcessLockClaimForTest(() => {
      setBeforeExactProcessLockClaimForTest(undefined);
      releaseAbandoned();
      writeFileSync(keychainLock, successorToken, { mode: 0o600 });
    });

    releaseAbandonedLoginJournalLocks({
      ownerPid: process.pid,
      ownerProcessStartId: "linux-0",
      preparation: {
        tool: { id: "claude" },
        profile: { dir: profileDir },
      },
      finalizationState: {
        writes: {
          keychainLockToken: abandonedToken,
        },
      },
    } as unknown as LoginRecoveryJournal);

    expect(readFileSync(keychainLock, "utf8")).toBe(successorToken);
  },
);

test("normal process lock release does not unlink a replacement lease", async () => {
  const keychainLock = process.env.ACCOUNTS_TEST_KEYCHAIN_LOCK_PATH!;
  const ownerToken = `${process.pid}:${randomUUID()}`;
  const successorToken = `${process.pid}:${randomUUID()}`;
  const releaseOwner = await acquireClaudeKeychainLock(undefined, ownerToken);

  setBeforeExactProcessLockClaimForTest(() => {
    setBeforeExactProcessLockClaimForTest(undefined);
    rmSync(keychainLock, { force: true });
    writeFileSync(keychainLock, successorToken, { mode: 0o600 });
  });

  releaseOwner();

  expect(readFileSync(keychainLock, "utf8")).toBe(successorToken);
});

test.skipIf(process.platform !== "linux")(
  "fails closed when another exact-inode deletion claim already exists",
  async () => {
    const profileDir = join(home, "profiles", "claude", "acct");
    const keychainLock = process.env.ACCOUNTS_TEST_KEYCHAIN_LOCK_PATH!;
    const abandonedToken = `${process.pid}:${randomUUID()}`;
    await acquireClaudeKeychainLock(undefined, abandonedToken);
    let claimPath = "";

    setBeforeExactProcessLockClaimForTest((observation) => {
      setBeforeExactProcessLockClaimForTest(undefined);
      const claimHash = createHash("sha256")
        .update(`${observation.dev}:${observation.ino}:`)
        .update(observation.text)
        .digest("hex")
        .slice(0, 24);
      claimPath = `${observation.path}.reclaim-${claimHash}`;
      linkSync(observation.path, claimPath);
    });

    releaseAbandonedLoginJournalLocks({
      ownerPid: process.pid,
      ownerProcessStartId: "linux-0",
      preparation: {
        tool: { id: "claude" },
        profile: { dir: profileDir },
      },
      finalizationState: {
        writes: {
          keychainLockToken: abandonedToken,
        },
      },
    } as unknown as LoginRecoveryJournal);

    expect(readFileSync(keychainLock, "utf8")).toBe(abandonedToken);
    expect(readFileSync(claimPath, "utf8")).toBe(abandonedToken);
  },
);

test.skipIf(process.platform !== "linux")(
  "does not reclaim a newer exact-token lock when the owner PID was reused",
  () => {
    const profileDir = join(home, "profiles", "claude", "acct");
    const uid = typeof process.getuid === "function" ? process.getuid() : "user";
    const identity = createHash("sha256").update(profileDir).digest("hex").slice(0, 32);
    profileLock = join("/tmp", `accounts-claude-login-${uid}-${identity}.lock`);
    const keychainLock = process.env.ACCOUNTS_TEST_KEYCHAIN_LOCK_PATH!;
    const newerProfileToken = `${process.pid}:${randomUUID()}`;
    const newerKeychainToken = `${process.pid}:${randomUUID()}`;
    const newerApplyToken = `${process.pid}:${randomUUID()}`;
    writeFileSync(profileLock, newerProfileToken, { mode: 0o600 });
    writeFileSync(keychainLock, newerKeychainToken, { mode: 0o600 });
    writeFileSync(join(home, ".apply.lock"), `${newerApplyToken}\n`, { mode: 0o600 });

    releaseAbandonedLoginJournalLocks({
      ownerPid: process.pid,
      ownerProcessStartId: "linux-0",
      preparation: {
        tool: { id: "claude" },
        profile: { dir: profileDir },
      },
      finalizationState: {
        writes: {
          keychainLockToken: `${process.pid}:${randomUUID()}`,
          applyLockToken: `${process.pid}:${randomUUID()}`,
        },
      },
    } as unknown as LoginRecoveryJournal);

    expect(readFileSync(profileLock, "utf8")).toBe(newerProfileToken);
    expect(readFileSync(keychainLock, "utf8")).toBe(newerKeychainToken);
    expect(readFileSync(join(home, ".apply.lock"), "utf8")).toBe(`${newerApplyToken}\n`);
  },
);

test.skipIf(process.platform !== "linux")(
  "reclaims only the matching exact tokens recorded by a dead finalization",
  () => {
    const profileDir = join(home, "profiles", "claude", "acct");
    const uid = typeof process.getuid === "function" ? process.getuid() : "user";
    const identity = createHash("sha256").update(profileDir).digest("hex").slice(0, 32);
    profileLock = join("/tmp", `accounts-claude-login-${uid}-${identity}.lock`);
    const keychainLock = process.env.ACCOUNTS_TEST_KEYCHAIN_LOCK_PATH!;
    const keychainToken = `${process.pid}:${randomUUID()}`;
    const applyToken = `${process.pid}:${randomUUID()}`;
    writeFileSync(keychainLock, keychainToken, { mode: 0o600 });
    writeFileSync(join(home, ".apply.lock"), `${applyToken}\n`, { mode: 0o600 });

    releaseAbandonedLoginJournalLocks({
      ownerPid: process.pid,
      ownerProcessStartId: "linux-0",
      preparation: {
        tool: { id: "claude" },
        profile: { dir: profileDir },
      },
      finalizationState: {
        writes: {
          keychainLockToken: keychainToken,
          applyLockToken: applyToken,
        },
      },
    } as unknown as LoginRecoveryJournal);

    expect(existsSync(keychainLock)).toBe(false);
    expect(existsSync(join(home, ".apply.lock"))).toBe(false);
  },
);

test.skipIf(process.platform !== "linux")(
  "reclaims later dead finalization tokens after earlier mismatched contenders are skipped",
  () => {
    const profileDir = join(home, "profiles", "claude", "acct");
    const keychainLock = process.env.ACCOUNTS_TEST_KEYCHAIN_LOCK_PATH!;
    const firstKeychainToken = `${process.pid}:${randomUUID()}`;
    const firstApplyToken = `${process.pid}:${randomUUID()}`;
    const secondKeychainToken = `${process.pid}:${randomUUID()}`;
    const secondApplyToken = `${process.pid}:${randomUUID()}`;
    writeFileSync(keychainLock, secondKeychainToken, { mode: 0o600 });
    writeFileSync(join(home, ".apply.lock"), `${secondApplyToken}\n`, { mode: 0o600 });

    for (const [keychainLockToken, applyLockToken] of [
      [firstKeychainToken, firstApplyToken],
      [secondKeychainToken, secondApplyToken],
    ] as const) {
      releaseAbandonedLoginJournalLocks({
        ownerPid: process.pid,
        ownerProcessStartId: "linux-0",
        preparation: {
          tool: { id: "claude" },
          profile: { dir: profileDir },
        },
        finalizationState: {
          writes: { keychainLockToken, applyLockToken },
        },
      } as unknown as LoginRecoveryJournal);
    }

    expect(existsSync(keychainLock)).toBe(false);
    expect(existsSync(join(home, ".apply.lock"))).toBe(false);
  },
);

test.skipIf(process.platform !== "linux")(
  "processes multiple dead profile contenders independently without touching unrelated leases",
  () => {
    const profileDir = join(home, "profiles", "claude", "acct");
    const uid = typeof process.getuid === "function" ? process.getuid() : "user";
    const identity = createHash("sha256").update(profileDir).digest("hex").slice(0, 32);
    profileLock = join("/tmp", `accounts-claude-login-${uid}-${identity}.lock`);
    const firstId = "00000000-0000-4000-8000-000000000001";
    const secondId = "00000000-0000-4000-8000-000000000002";
    const firstToken = `${process.pid}:${randomUUID()}`;
    const secondToken = `${process.pid}:${randomUUID()}`;
    const keychainToken = `${process.pid}:${randomUUID()}`;
    const applyToken = `${process.pid}:${randomUUID()}`;
    const directory = join(home, "login-finalization-journals");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const [id, profileLockToken] of [
      [firstId, firstToken],
      [secondId, secondToken],
    ] as const) {
      writeFileSync(
        join(directory, `${id}.lease`),
        serialize({
          version: 1,
          id,
          ownerPid: process.pid,
          ownerProcessStartId: "linux-0",
          profileDir,
          profileLockToken,
        }),
        { mode: 0o600 },
      );
    }
    writeFileSync(profileLock, secondToken, { mode: 0o600 });
    writeFileSync(process.env.ACCOUNTS_TEST_KEYCHAIN_LOCK_PATH!, keychainToken, { mode: 0o600 });
    writeFileSync(join(home, ".apply.lock"), `${applyToken}\n`, { mode: 0o600 });

    recoverAbandonedLoginLeaseIntents();

    expect(existsSync(profileLock)).toBe(false);
    expect(existsSync(join(directory, `${firstId}.lease`))).toBe(false);
    expect(existsSync(join(directory, `${secondId}.lease`))).toBe(false);
    expect(readFileSync(process.env.ACCOUNTS_TEST_KEYCHAIN_LOCK_PATH!, "utf8"))
      .toBe(keychainToken);
    expect(readFileSync(join(home, ".apply.lock"), "utf8")).toBe(`${applyToken}\n`);
  },
);
