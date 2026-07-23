import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export interface ExactProcessLockObservation {
  path: string;
  text: string;
  dev: number;
  ino: number;
}

let beforeClaimForTest:
  | ((observation: ExactProcessLockObservation) => void)
  | undefined;

export function setBeforeExactProcessLockClaimForTest(
  hook: ((observation: ExactProcessLockObservation) => void) | undefined,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("exact process lock test hook is unavailable outside tests");
  }
  beforeClaimForTest = hook;
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

const UNIQUE_RECLAIM_SUFFIX =
  /^([1-9]\d*)-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const LEGACY_RECLAIM_SUFFIX = /^[0-9a-f]{24}$/i;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function reclaimPrefix(path: string): string {
  return `${basename(path)}.reclaim-`;
}

/**
 * Remove abandoned unique reclaim aliases and report whether a live claimant
 * still fences publication for this canonical lock path.
 *
 * Reclaim aliases are same-directory hard links. Their unique names are never
 * reused, so a dead claimant's alias can be removed without risking a later
 * owner. Legacy deterministic aliases have no reclaimer identity and therefore
 * remain fail-closed: an old process could still be paused immediately before
 * its canonical unlink.
 */
interface ExactProcessLockReclaimScan {
  liveClaim: boolean;
  deletionBlocked: boolean;
}

function scanExactProcessLockReclaimClaims(path: string): ExactProcessLockReclaimScan {
  const directory = dirname(path);
  const prefix = reclaimPrefix(path);
  let liveClaim = false;
  let deletionBlocked = false;
  let removed = false;
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { liveClaim: false, deletionBlocked: false };
    }
    throw error;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const suffix = name.slice(prefix.length);
    const unique = suffix.match(UNIQUE_RECLAIM_SUFFIX);
    const legacy = LEGACY_RECLAIM_SUFFIX.test(suffix);
    if (!unique && !legacy) {
      liveClaim = true;
      deletionBlocked = true;
      continue;
    }
    const claimPath = join(directory, name);
    let claim: ReturnType<typeof lstatSync>;
    try {
      claim = lstatSync(claimPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!claim.isFile() || claim.isSymbolicLink()) {
      liveClaim = true;
      deletionBlocked = true;
      continue;
    }
    // Legacy deterministic claims have no reclaimer identity. A still-live old
    // process may be paused after validating the canonical inode but before
    // unlinking it, so both publication and another deletion must fail closed.
    if (legacy) {
      liveClaim = true;
      deletionBlocked = true;
      continue;
    }
    if (unique && processAlive(Number(unique[1]))) {
      liveClaim = true;
      continue;
    }
    try {
      unlinkSync(claimPath);
      removed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (removed) fsyncDirectory(directory);
  return { liveClaim, deletionBlocked };
}

export function exactProcessLockHasLiveReclaimClaims(path: string): boolean {
  return scanExactProcessLockReclaimClaims(path).liveClaim;
}

export function observeExactProcessLock(
  path: string,
  exactText: string,
): ExactProcessLockObservation | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    if (readFileSync(path, "utf8") !== exactText) return undefined;
    return { path, text: exactText, dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Remove one byte- and inode-exact process lock observation.
 *
 * Each deleter uses a unique hard-link claim carrying its PID and a UUID.
 * Normal acquisition scans these aliases before publishing. That keeps a
 * paused live claimant from racing a successor, while a later process can
 * safely remove an abandoned claimant's never-reused alias.
 */
export function removeObservedExactProcessLock(
  observation: ExactProcessLockObservation,
): boolean {
  beforeClaimForTest?.(observation);
  if (scanExactProcessLockReclaimClaims(observation.path).deletionBlocked) {
    return false;
  }
  const claimPath = `${observation.path}.reclaim-${process.pid}-${randomUUID()}`;
  let claim: ReturnType<typeof lstatSync> | undefined;
  let removed = false;
  try {
    try {
      linkSync(observation.path, claimPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return false;
      throw error;
    }
    claim = lstatSync(claimPath);
    if (
      !claim.isFile() ||
      claim.isSymbolicLink() ||
      claim.dev !== observation.dev ||
      claim.ino !== observation.ino
    ) {
      return false;
    }
    const current = lstatSync(observation.path);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.dev !== observation.dev ||
      current.ino !== observation.ino ||
      readFileSync(observation.path, "utf8") !== observation.text
    ) {
      return false;
    }
    unlinkSync(observation.path);
    removed = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  } finally {
    if (claim) {
      try {
        const currentClaim = lstatSync(claimPath);
        if (currentClaim.dev === claim.dev && currentClaim.ino === claim.ino) {
          unlinkSync(claimPath);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  if (removed) fsyncDirectory(dirname(observation.path));
  return removed;
}
