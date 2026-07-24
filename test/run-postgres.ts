import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { controlledTestsRoot } from "./support/isolation-paths.js";

const controlledRoot = controlledTestsRoot(process.cwd());
const requestedLaunchId = process.env.ACCOUNTS_TEST_LAUNCH_ID;
const launchId = requestedLaunchId && /^[a-z0-9-]{1,48}$/i.test(requestedLaunchId)
  ? `${requestedLaunchId}-`
  : "";
mkdirSync(controlledRoot, { recursive: true });
const launchRoot = mkdtempSync(join(controlledRoot, `postgres-launch-${launchId}`));
let exitCode = 1;
let cleaned = false;
let child: Subprocess | undefined;

function cleanupLaunchRoot(): void {
  if (cleaned) return;
  cleaned = true;
  rmSync(launchRoot, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 25,
  });
}

// Arm signal handling before spawning so a signal delivered to this launcher can
// never orphan the child test process or strand its unique controlled root:
// kill the child, purge the root, and re-exit with the conventional status.
let signalHandled = false;
const signalNumbers = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 } as const;
for (const signal of Object.keys(signalNumbers) as (keyof typeof signalNumbers)[]) {
  process.on(signal, () => {
    if (signalHandled) return;
    signalHandled = true;
    try {
      child?.kill();
    } catch {
      // Child may already be gone; cleanup below still runs.
    }
    cleanupLaunchRoot();
    process.exit(128 + signalNumbers[signal]);
  });
}

child = Bun.spawn({
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

try {
  exitCode = await child.exited;
} finally {
  cleanupLaunchRoot();
}

process.exit(exitCode);
