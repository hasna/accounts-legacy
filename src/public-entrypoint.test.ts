import { expect, test } from "bun:test";
import { AccountsError, getTool, mergeToolArgs } from "./index.js";

test("public mergeToolArgs rejects conflicting Claude permission modes", () => {
  const claude = getTool("claude");

  for (const args of [
    ["--permission-mode", "bypassPermissions"],
    ["--permission-mode=bypassPermissions"],
  ]) {
    expect(() => mergeToolArgs(claude, args, { permissions: "plan" })).toThrow(AccountsError);
  }
});
