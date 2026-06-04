import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AccountsError } from "../types.js";

function throwIfSymlink(path: string, label: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new AccountsError(`${label}: ${path}`);
  }
}

/** Walk directory components from root/base through parent; refuse symlinks and `..`. */
function assertDirChainSafe(targetFile: string, mustStayUnder?: string): void {
  const absFile = resolve(targetFile);
  const parent = dirname(absFile);
  const base = mustStayUnder ? resolve(mustStayUnder) : undefined;

  if (base) {
    const rel = absFile.startsWith(base + "/") ? absFile.slice(base.length + 1) : "";
    if (!rel && absFile !== base) {
      throw new AccountsError(`refusing to write outside profile directory: ${targetFile}`);
    }
    const segments = rel.split("/").filter(Boolean);
    if (segments.some((s) => s === "..")) {
      throw new AccountsError(`refusing path traversal: ${targetFile}`);
    }
    let cursor = base;
    for (let i = 0; i < segments.length - 1; i++) {
      cursor = resolve(cursor, segments[i]!);
      throwIfSymlink(cursor, "refusing to write under symlink directory");
    }
  } else {
    let cursor = parent;
    for (;;) {
      throwIfSymlink(cursor, "refusing to write under symlink directory");
      const next = dirname(cursor);
      if (next === cursor) break;
      cursor = next;
    }
  }
}

/** Refuse writes through symlinks; optionally confine to a base directory. */
export function assertSafeWritePath(filePath: string, opts?: { mustStayUnder?: string }): string {
  const absFile = resolve(filePath);
  const parent = dirname(absFile);

  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });

  throwIfSymlink(absFile, "refusing to write through symlink");
  assertDirChainSafe(absFile, opts?.mustStayUnder);

  const resolved = realpathSync(existsSync(absFile) ? absFile : parent);
  if (opts?.mustStayUnder) {
    const base = realpathSync(resolve(opts.mustStayUnder));
    if (resolved !== base && !resolved.startsWith(base + "/")) {
      throw new AccountsError(`refusing to write outside profile directory: ${filePath}`);
    }
  }
  return resolved;
}
