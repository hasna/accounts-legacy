import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
  path: string;
  dev: number;
  ino: number;
  token: string;
}

const APPLY_LOCK_TOKEN_RE = /^[1-9]\d*:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Pre-generate the exact token a durable operation records before acquiring the apply lock. */
export function createApplyLockToken(): string {
  return `${process.pid}:${randomUUID()}`;
}

function requireApplyLockToken(token: string): string {
  if (!APPLY_LOCK_TOKEN_RE.test(token) || !token.startsWith(`${process.pid}:`)) {
    throw new AccountsError("invalid apply lock ownership token");
  }
  return token;
}

function fsyncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EPERM", "EACCES", "EISDIR"].includes(code ?? "")) {
      throw error;
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function tryAcquireApplyLock(exactToken: string = createApplyLockToken()): ApplyLockLease | undefined {
  const token = requireApplyLockToken(exactToken);
  return withStoreLock(() => {
    const home = accountsHome();
    mkdirSync(home, { recursive: true });
    const path = lockPath();
    const candidate = `${path}.candidate-${process.pid}-${randomUUID()}`;
    let fd: number | undefined;
    try {
      fd = openSync(candidate, "wx", 0o600);
      writeFileSync(fd, `${token}\n`, { encoding: "utf8", mode: 0o600 });
      fsyncSync(fd);
      const stat = fstatSync(fd);
      closeSync(fd);
      fd = undefined;
      try {
        // Publish a fully initialized inode. A hard death can leave an owned
        // complete lock, never an empty/partial lock that recovery cannot CAS.
        linkSync(candidate, path);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST") {
          return undefined;
        }
        throw error;
      }
      rmSync(candidate, { force: true });
      fsyncDirectory(home);
      return { path, dev: stat.dev, ino: stat.ino, token };
    } catch (err) {
      if (fd !== undefined) closeSync(fd);
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new AccountsError(`could not create apply lock at ${path}: accounts home missing`);
      }
      throw err;
    } finally {
      rmSync(candidate, { force: true });
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
          current.ino === lease.ino &&
          readFileSync(lease.path, "utf8") === `${lease.token}\n`
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
  }
}

/** Exclusive lock for apply operations (best-effort cross-process). */
export function withApplyLock<T>(fn: () => T, exactToken?: string): T {
  const lease = tryAcquireApplyLock(exactToken);
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
export async function withApplyLockAsync<T>(
  fn: () => Promise<T>,
  exactToken?: string,
): Promise<T> {
  const lease = tryAcquireApplyLock(exactToken);
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
  opts: { timeoutMs?: number; pollMs?: number; exactToken?: string } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_APPLY_LOCK_WAIT_MS;
  const pollMs = opts.pollMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const lease = tryAcquireApplyLock(opts.exactToken);
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
