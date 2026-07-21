import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountsHome, withStoreLock } from "../storage.js";
import { AccountsError } from "../types.js";

function lockPath(): string {
  return join(accountsHome(), ".apply.lock");
}

// Built-in API login activation is bounded below this window across all retry
// attempts. Rollback therefore cannot abandon auth behind a legitimate apply,
// while malformed/dead locks still fail closed on a bounded timer and remain
// available for manual recovery.
export const DEFAULT_APPLY_LOCK_WAIT_MS = 60_000;

interface ApplyLockLease {
  fd: number;
  path: string;
  dev: number;
  ino: number;
}

function tryAcquireApplyLock(): ApplyLockLease | undefined {
  return withStoreLock(() => {
    const home = accountsHome();
    mkdirSync(home, { recursive: true });
    const path = lockPath();
    let fd: number | undefined;
    let dev: number | undefined;
    let ino: number | undefined;
    try {
      fd = openSync(path, "wx", 0o600);
      const stat = fstatSync(fd);
      dev = stat.dev;
      ino = stat.ino;
      writeFileSync(fd, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
      return { fd, path, dev, ino };
    } catch (err) {
      if (fd !== undefined) {
        // Every cooperating acquirer/releaser holds the registry lock here, so
        // inode validation and unlink cannot race another Accounts lease.
        try {
          if (dev !== undefined && ino !== undefined && existsSync(path)) {
            const current = lstatSync(path);
            if (current.isFile() && !current.isSymbolicLink() && current.dev === dev && current.ino === ino) {
              unlinkSync(path);
            }
          }
        } catch {
          /* preserve the original acquisition error and fail closed */
        }
        closeSync(fd);
      }
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return undefined;
      if (code === "ENOENT") {
        throw new AccountsError(`could not create apply lock at ${path}: accounts home missing`);
      }
      throw err;
    }
  });
}

function releaseApplyLock(lease: ApplyLockLease): void {
  try {
    withStoreLock(() => {
      try {
        if (!existsSync(lease.path)) return;
        const current = lstatSync(lease.path);
        if (
          current.isFile() &&
          !current.isSymbolicLink() &&
          current.dev === lease.dev &&
          current.ino === lease.ino
        ) {
          unlinkSync(lease.path);
        }
      } catch {
        /* leave an unverifiable lock in place and fail closed */
      }
    });
  } catch {
    // If the registry lock is unavailable, retain the apply lock for manual
    // recovery rather than risking deletion of a replacement lease.
  } finally {
    closeSync(lease.fd);
  }
}

/** Exclusive lock for apply operations (best-effort cross-process). */
export function withApplyLock<T>(fn: () => T): T {
  const lease = tryAcquireApplyLock();
  if (!lease) {
    throw new AccountsError(
      `another accounts apply is in progress at ${lockPath()}; ` +
      "automatic stale-lock reclaim is disabled because ownership cannot be proven",
    );
  }
  try {
    return fn();
  } finally {
    releaseApplyLock(lease);
  }
}

/** Exclusive apply lock for async activation/rollback; never wrap an interactive child with it. */
export async function withApplyLockAsync<T>(fn: () => Promise<T>): Promise<T> {
  const lease = tryAcquireApplyLock();
  if (!lease) {
    throw new AccountsError(
      `another accounts apply is in progress at ${lockPath()}; ` +
      "automatic stale-lock reclaim is disabled because ownership cannot be proven",
    );
  }
  try {
    return await fn();
  } finally {
    releaseApplyLock(lease);
  }
}

/** Wait for an in-flight apply, then run a synchronous rollback check under the same lock. */
export async function withApplyLockWait<T>(
  fn: () => T,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_APPLY_LOCK_WAIT_MS;
  const pollMs = opts.pollMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const lease = tryAcquireApplyLock();
    if (lease) {
      try {
        return fn();
      } finally {
        releaseApplyLock(lease);
      }
    }
    if (Date.now() >= deadline) {
      throw new AccountsError(`timed out waiting for the accounts apply lock at ${lockPath()}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
  }
}
