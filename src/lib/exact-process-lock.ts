import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";

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
 * Every deleter for the same lease uses the same hard-link claim. Only the
 * claimant can progress to unlinking the canonical name, while a replacement
 * published before the claim is detected by the inode/text comparison.
 */
export function removeObservedExactProcessLock(
  observation: ExactProcessLockObservation,
): boolean {
  beforeClaimForTest?.(observation);
  const claimHash = createHash("sha256")
    .update(`${observation.dev}:${observation.ino}:`)
    .update(observation.text)
    .digest("hex")
    .slice(0, 24);
  const claimPath = `${observation.path}.reclaim-${claimHash}`;
  let claim: ReturnType<typeof lstatSync> | undefined;
  let removed = false;
  try {
    try {
      linkSync(observation.path, claimPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EEXIST") return false;
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
