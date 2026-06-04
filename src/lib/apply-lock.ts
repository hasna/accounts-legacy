import { closeSync, existsSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountsHome } from "../storage.js";
import { AccountsError } from "../types.js";

function lockPath(): string {
  return join(accountsHome(), ".apply.lock");
}

/** Exclusive lock for apply operations (best-effort cross-process). */
export function withApplyLock<T>(fn: () => T): T {
  const home = accountsHome();
  mkdirSync(home, { recursive: true });
  const path = lockPath();
  let fd: number | undefined;
  try {
    fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
    return fn();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new AccountsError(
        `another accounts apply is in progress; wait and retry (or remove ${path} if stale)`,
      );
    }
    if (code === "ENOENT") {
      throw new AccountsError(`could not create apply lock at ${path}: accounts home missing`);
    }
    throw err;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch {
        /* ignore */
      }
    }
  }
}
