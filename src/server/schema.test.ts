import { describe, expect, test } from "bun:test";
import { createAccountSchema, loginUpdateAccountSchema, updateAccountSchema } from "./schema.js";

describe("accounts API path validation", () => {
  test("create rejects NUL and newline directory paths", () => {
    expect(
      createAccountSchema.safeParse({ name: "bad-dir", tool: "claude", dir: "/tmp/bad\0path" }).success,
    ).toBe(false);
    expect(
      createAccountSchema.safeParse({ name: "bad-dir", tool: "claude", dir: "/tmp/bad\npath" }).success,
    ).toBe(false);
  });

  test("update rejects invalid directory paths", () => {
    expect(updateAccountSchema.safeParse({ dir: "/tmp/bad\0path" }).success).toBe(false);
    expect(updateAccountSchema.safeParse({ dir: "/tmp/bad\rpath" }).success).toBe(false);
  });

  test("login email update accepts an account whose prior email is absent", () => {
    expect(loginUpdateAccountSchema.parse({
      expectedIncarnationId: "11111111-1111-4111-8111-111111111111",
      expectedEmail: null,
      email: "detected@example.test",
    })).toEqual({
      expectedIncarnationId: "11111111-1111-4111-8111-111111111111",
      expectedEmail: null,
      email: "detected@example.test",
    });
  });
});
