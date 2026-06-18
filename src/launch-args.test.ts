import { test, expect } from "bun:test";
import { join } from "node:path";
import { getTool, mergeToolArgs } from "./lib/tools.js";
import type { Profile } from "./types.js";

const profile: Profile = {
  name: "desktop",
  tool: "codex-app",
  email: "desktop@example.com",
  dir: "/tmp/accounts/codex-app/desktop",
  createdAt: "2026-06-18T00:00:00.000Z",
};

test("codex app declares a templated Electron user data dir launch arg", () => {
  const tool = getTool("codex-app");
  expect(tool.launchArgs).toEqual(["--user-data-dir={profileDir}/electron-user-data"]);
});

test("mergeToolArgs prepends rendered launch args", () => {
  const tool = getTool("codex-app");
  expect(mergeToolArgs(tool, [], { profile })).toEqual([
    `--user-data-dir=${join(profile.dir, "electron-user-data")}`,
  ]);
  expect(mergeToolArgs(tool, ["--inspect"], { profile })).toEqual([
    `--user-data-dir=${join(profile.dir, "electron-user-data")}`,
    "--inspect",
  ]);
});

test("mergeToolArgs does not duplicate an already-present launch arg", () => {
  const tool = getTool("codex-app");
  const rendered = `--user-data-dir=${join(profile.dir, "electron-user-data")}`;
  expect(mergeToolArgs(tool, [rendered], { profile })).toEqual([rendered]);
  expect(mergeToolArgs(tool, ["--inspect", rendered], { profile })).toEqual(["--inspect", rendered]);
});

test("mergeToolArgs is a no-op for tools without launch args or permissions", () => {
  const codex = getTool("codex");
  expect(codex.launchArgs).toBeUndefined();
  expect(mergeToolArgs(codex, ["login"])).toEqual(["login"]);
  expect(mergeToolArgs(codex, [])).toEqual([]);
});
