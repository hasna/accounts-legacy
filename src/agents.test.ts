import { test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProfile } from "./lib/profiles.js";
import {
  extractJsonArray,
  listAgentsAcrossProfiles,
  type AgentsRunner,
} from "./lib/agents.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "accounts-agents-test-"));
  process.env.ACCOUNTS_HOME = home;
  delete process.env.ACCOUNTS_STORE_PATH;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.ACCOUNTS_HOME;
});

test("extractJsonArray parses a clean JSON array", () => {
  expect(extractJsonArray('[{"pid":1}]')).toEqual([{ pid: 1 }]);
});

test("extractJsonArray strips pty and ANSI noise around the array", () => {
  const raw = '[?25l\r\n[\r\n  {"pid": 42, "name": "a [b] c"},\r\n  {"kind": "background"}\r\n]\r\n[?25h';
  expect(extractJsonArray(raw)).toEqual([{ pid: 42, name: "a [b] c" }, { kind: "background" }]);
});

test("extractJsonArray handles brackets inside strings and escapes", () => {
  const raw = 'noise [ {"name": "x\\"]y", "cwd": "/a[b"} ] trailing';
  expect(extractJsonArray(raw)).toEqual([{ name: 'x"]y', cwd: "/a[b" }]);
});

test("extractJsonArray returns undefined when no array present", () => {
  expect(extractJsonArray("error: something broke")).toBeUndefined();
});

test("listAgentsAcrossProfiles aggregates agents per claude profile", () => {
  addProfile({ name: "acct1", tool: "claude", email: "one@example.com" });
  addProfile({ name: "acct2", tool: "claude", email: "two@example.com" });
  addProfile({ name: "codexer", tool: "codex", email: "codex@example.com" });

  const runner: AgentsRunner = (profile) => {
    if (profile.name === "acct1") {
      return { ok: true, raw: '[{"kind":"background","sessionId":"s1","state":"working"}]' };
    }
    return { ok: true, raw: "[]" };
  };

  const results = listAgentsAcrossProfiles({ runner });
  expect(results.map((r) => r.profile)).toEqual(["acct1", "acct2"]);
  expect(results[0]?.email).toBe("one@example.com");
  expect(results[0]?.agents).toEqual([{ kind: "background", sessionId: "s1", state: "working" }]);
  expect(results[1]?.agents).toEqual([]);
});

test("listAgentsAcrossProfiles records per-profile errors without failing the run", () => {
  addProfile({ name: "good", tool: "claude", email: "good@example.com" });
  addProfile({ name: "bad", tool: "claude", email: "bad@example.com" });

  const runner: AgentsRunner = (profile) =>
    profile.name === "bad"
      ? { ok: false, raw: "", error: "claude binary not found" }
      : { ok: true, raw: '[{"kind":"interactive","sessionId":"s2"}]' };

  const results = listAgentsAcrossProfiles({ runner });
  const bad = results.find((r) => r.profile === "bad");
  const good = results.find((r) => r.profile === "good");
  expect(bad?.error).toContain("not found");
  expect(bad?.agents).toEqual([]);
  expect(good?.agents).toHaveLength(1);
});

test("listAgentsAcrossProfiles filters to a single profile and background kind", () => {
  addProfile({ name: "acct1", tool: "claude", email: "one@example.com" });
  addProfile({ name: "acct2", tool: "claude", email: "two@example.com" });

  const runner: AgentsRunner = () => ({
    ok: true,
    raw: '[{"kind":"background","sessionId":"b1"},{"kind":"interactive","sessionId":"i1"}]',
  });

  const results = listAgentsAcrossProfiles({ runner, profile: "acct1", backgroundOnly: true });
  expect(results).toHaveLength(1);
  expect(results[0]?.profile).toBe("acct1");
  expect(results[0]?.agents).toEqual([{ kind: "background", sessionId: "b1" }]);
});

test("listAgentsAcrossProfiles treats unparseable output as an error", () => {
  addProfile({ name: "acct1", tool: "claude", email: "one@example.com" });
  const runner: AgentsRunner = () => ({ ok: true, raw: "garbage with no json" });

  const results = listAgentsAcrossProfiles({ runner });
  expect(results[0]?.error).toBeDefined();
  expect(results[0]?.agents).toEqual([]);
});

test("accounts agents --help registers the command", () => {
  const result = spawnSync(process.execPath, ["run", "src/cli.ts", "agents", "--help"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ACCOUNTS_HOME: home },
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("--json");
  expect(result.stdout).toContain("--background");
});
