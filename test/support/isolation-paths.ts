import { platform as runtimePlatform } from "node:os";
import { posix, win32 } from "node:path";

function pathsFor(targetPlatform: NodeJS.Platform): typeof posix {
  return targetPlatform === "win32" ? win32 : posix;
}

export function controlledTestsRootFor(cwd: string, targetPlatform: NodeJS.Platform): string {
  return pathsFor(targetPlatform).resolve(cwd, "node_modules", ".cache", "accounts-tests");
}

export function controlledTestsRoot(cwd: string): string {
  return controlledTestsRootFor(cwd, runtimePlatform());
}

export function resolveControlledTestParentFor(
  cwd: string,
  candidate: string | undefined,
  targetPlatform: NodeJS.Platform,
): string {
  const paths = pathsFor(targetPlatform);
  const controlledRoot = controlledTestsRootFor(cwd, targetPlatform);
  if (!candidate) return controlledRoot;

  const resolvedCandidate = paths.resolve(candidate);
  const childPath = paths.relative(controlledRoot, resolvedCandidate);
  if (childPath === "") return controlledRoot;
  if (childPath === ".." || childPath.startsWith(`..${paths.sep}`)) return controlledRoot;
  if (paths.isAbsolute(childPath)) return controlledRoot;
  return resolvedCandidate;
}

export function resolveControlledTestParent(cwd: string, candidate?: string): string {
  return resolveControlledTestParentFor(cwd, candidate, runtimePlatform());
}

export function executableFilename(
  name: string,
  targetPlatform: NodeJS.Platform = runtimePlatform(),
): string {
  return targetPlatform === "win32" ? `${name}.exe` : name;
}
