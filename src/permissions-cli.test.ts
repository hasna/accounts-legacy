import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "accounts-permissions-cli-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function runCli(...args: string[]) {
  return spawnSync(process.execPath, ["run", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ACCOUNTS_HOME: home },
  });
}

test("switch CLI accepts --permissions and returns tool-specific command args", () => {
  const add = runCli("add", "codexer", "--tool", "codex");
  expect(add.status).toBe(0);

  const result = runCli("switch", "codexer", "--tool", "codex", "--resume", "--permissions", "dangerous", "--json");
  expect(result.status).toBe(0);

  const parsed = JSON.parse(result.stdout) as { command: string[]; permissions?: string };
  expect(parsed.permissions).toBe("dangerous");
  expect(parsed.command).toEqual(["codex", "--dangerously-bypass-approvals-and-sandbox", "resume", "--last"]);
});

test("profile metadata can be added, shown, and updated through the CLI", () => {
  const add = runCli(
    "add",
    "account001",
    "--email",
    "owner@example.com",
    "--display-name",
    "Owner One",
    "--identity",
    "agent:owner-one",
    "--card-last4",
    "4242",
    "--metadata",
    "machine=spark02",
    "--metadata",
    "slot=1",
  );
  expect(add.status).toBe(0);

  const set = runCli("set", "account001", "--metadata", "source=manual", "--display-name", "Owner 1");
  expect(set.status).toBe(0);

  const show = runCli("show", "account001", "--json");
  expect(show.status).toBe(0);
  const profile = JSON.parse(show.stdout) as {
    email?: string;
    displayName?: string;
    identity?: string;
    cardLast4?: string;
    metadata?: Record<string, unknown>;
  };
  expect(profile.email).toBe("owner@example.com");
  expect(profile.displayName).toBe("Owner 1");
  expect(profile.identity).toBe("agent:owner-one");
  expect(profile.cardLast4).toBe("4242");
  expect(profile.metadata).toEqual({ machine: "spark02", slot: 1, source: "manual" });
});

test("CLI rejects invalid metadata updates without poisoning the store", () => {
  expect(runCli("add", "account001").status).toBe(0);

  const emptyName = runCli("set", "account001", "--display-name", "");
  expect(emptyName.status).not.toBe(0);
  expect(runCli("list").status).toBe(0);

  const reservedKey = runCli("set", "account001", "--metadata", "__proto__=null");
  expect(reservedKey.status).not.toBe(0);
  expect(runCli("list").status).toBe(0);
});

test("CLI does not coerce huge numeric-looking metadata values to null", () => {
  const huge = "9".repeat(400);
  const add = runCli("add", "account001", "--metadata", `huge=${huge}`);
  expect(add.status).toBe(0);

  const show = runCli("show", "account001", "--json");
  expect(show.status).toBe(0);
  const profile = JSON.parse(show.stdout) as { metadata?: Record<string, unknown> };
  expect(profile.metadata?.huge).toBe(huge);
});
