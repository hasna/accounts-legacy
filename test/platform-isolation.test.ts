import { expect, test } from "bun:test";
import { isAbsolute, join, relative } from "node:path";
import {
  controlledTestsRoot,
  controlledTestsRootFor,
  executableFilename,
  resolveControlledTestParent,
  resolveControlledTestParentFor,
} from "./support/isolation-paths.js";

test("default test roots stay inside the worktree-local ignored cache", () => {
  const cwd = process.cwd();
  const controlledRoot = controlledTestsRoot(cwd);

  expect(controlledRoot).toBe(join(cwd, "node_modules", ".cache", "accounts-tests"));
  expect(resolveControlledTestParent(cwd, join(cwd, "outside-tests"))).toBe(controlledRoot);
  expect(resolveControlledTestParent(cwd, "/tmp/inherited-accounts-tests")).toBe(controlledRoot);

  const launchRoot = join(controlledRoot, "postgres-launch-fixture");
  expect(resolveControlledTestParent(cwd, launchRoot)).toBe(launchRoot);
  const relativeLaunchRoot = relative(controlledRoot, launchRoot);
  expect(relativeLaunchRoot.startsWith("..") || isAbsolute(relativeLaunchRoot)).toBe(false);
});

test("Windows path injection never selects SystemRoot temp or an inherited temp directory", () => {
  const cwd = "C:\\worktrees\\accounts";
  const controlledRoot = "C:\\worktrees\\accounts\\node_modules\\.cache\\accounts-tests";

  expect(controlledTestsRootFor(cwd, "win32")).toBe(controlledRoot);
  expect(resolveControlledTestParentFor(cwd, "C:\\Windows\\temp", "win32")).toBe(controlledRoot);
  expect(resolveControlledTestParentFor(cwd, "D:\\inherited-temp", "win32")).toBe(controlledRoot);
  expect(resolveControlledTestParentFor(
    cwd,
    `${controlledRoot}\\postgres-launch-fixture`,
    "win32",
  )).toBe(`${controlledRoot}\\postgres-launch-fixture`);
});

test("platform-injected executable names use native binaries rather than Windows command files", () => {
  expect(executableFilename("security", "darwin")).toBe("security");
  expect(executableFilename("security", "linux")).toBe("security");
  expect(executableFilename("security", "win32")).toBe("security.exe");
  expect(executableFilename("security", "win32")).not.toEndWith(".cmd");
});
