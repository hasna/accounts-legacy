import { expect, test } from "bun:test";
import { resolveStore } from "./lib/store.js";

const INHERITED_ACCOUNTS_ENV_KEYS = [
  "HASNA_ACCOUNTS_API_URL",
  "HASNA_ACCOUNTS_API_KEY",
  "ACCOUNTS_API_URL",
  "ACCOUNTS_API_KEY",
  "ACCOUNTS_STORAGE_MODE",
  "HASNA_ACCOUNTS_MODE",
] as const;

test("Bun test setup neutralizes inherited Accounts cloud configuration", () => {
  expect(process.env.HASNA_ACCOUNTS_STORAGE_MODE).toBe("local");
  for (const key of INHERITED_ACCOUNTS_ENV_KEYS) expect(process.env[key]).toBeUndefined();
  expect(resolveStore().transport).toBe("local");
});

test("explicit cloud fixtures can override the hermetic test defaults", () => {
  const explicitCloudEnv = {
    ...process.env,
    HASNA_ACCOUNTS_STORAGE_MODE: "cloud",
    HASNA_ACCOUNTS_API_URL: "https://accounts.test.invalid",
    HASNA_ACCOUNTS_API_KEY: "test-only-placeholder",
  } as NodeJS.ProcessEnv;

  expect(resolveStore(explicitCloudEnv).transport).toBe("api");
});
