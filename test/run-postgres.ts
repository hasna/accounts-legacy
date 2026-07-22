import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { controlledTestsRoot } from "./support/isolation-paths.js";

const controlledRoot = controlledTestsRoot(process.cwd());
const requestedLaunchId = process.env.ACCOUNTS_TEST_LAUNCH_ID;
const launchId = requestedLaunchId && /^[a-z0-9-]{1,48}$/i.test(requestedLaunchId)
  ? `${requestedLaunchId}-`
  : "";
mkdirSync(controlledRoot, { recursive: true });
const launchRoot = mkdtempSync(join(controlledRoot, `postgres-launch-${launchId}`));
let exitCode = 1;

try {
  const child = Bun.spawn({
    cmd: [process.execPath, "test", "./src/server/postgres.integration.ts", ...process.argv.slice(2)],
    cwd: process.cwd(),
    env: {
      ...process.env,
      ACCOUNTS_REQUIRE_POSTGRES: "1",
      ACCOUNTS_POSTGRES_TEST_TARGET: "1",
      ACCOUNTS_TEST_ROOT_PARENT: launchRoot,
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  exitCode = await child.exited;
} finally {
  rmSync(launchRoot, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 25,
  });
}

process.exit(exitCode);
