import { expect, test } from "bun:test";
import { AccountsError, getTool, mergeToolArgs } from "./index.js";

test("public mergeToolArgs rejects conflicting Claude permission modes", () => {
  const claude = getTool("claude");

  for (const [permissions, args] of [
    ["plan", ["--permission-mode", "bypassPermissions"]],
    ["plan", ["--permission-mode=bypassPermissions"]],
    ["bypass", ["--permission-mode", "plan"]],
    ["bypass", ["--permission-mode=plan"]],
  ] as const) {
    expect(() => mergeToolArgs(claude, [...args], { permissions })).toThrow(AccountsError);
  }
});

for (const [label, args, error] of [
  [
    "dangerous alias plus native mode",
    ["--dangerously-skip-permissions", "--permission-mode", "plan"],
    "--permission-mode cannot be combined with another permission source",
  ],
  [
    "two native modes",
    ["--permission-mode=plan", "--permission-mode=bypassPermissions"],
    "--permissions may be supplied only once",
  ],
  [
    "raw preset plus native mode",
    ["--permissions=dangerous", "--permission-mode", "plan"],
    "--permission-mode cannot be combined with another permission source",
  ],
] as const) {
  test(`public mergeToolArgs rejects ${label}`, () => {
    expect(() => mergeToolArgs(getTool("claude"), [...args])).toThrow(error);
  });
}

test("public mergeToolArgs preserves coherent Claude permission sources", () => {
  const claude = getTool("claude");

  for (const args of [
    ["--dangerously-skip-permissions"],
    ["--permission-mode", "plan"],
    ["--permission-mode=plan"],
    ["--permissions=dangerous"],
  ]) {
    expect(mergeToolArgs(claude, args)).toEqual(args);
  }
  for (const [permissions, args] of [
    ["plan", ["--permission-mode", "plan"]],
    ["plan", ["--permission-mode=plan"]],
    ["bypass", ["--permission-mode", "bypassPermissions"]],
    ["bypass", ["--permission-mode=bypassPermissions"]],
  ] as const) {
    expect(mergeToolArgs(claude, [...args], { permissions })).toEqual(args);
  }
});

test("public mergeToolArgs leaves Claude-style permission args unchanged for other tools", () => {
  const args = [
    "--dangerously-skip-permissions",
    "--permission-mode",
    "plan",
    "--permissions=dangerous",
  ];

  expect(mergeToolArgs(getTool("codex"), args)).toEqual(args);
});
