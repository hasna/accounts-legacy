import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderSdk, sdkClientPath } from "./sdk/generate-sdk.js";
import { buildOpenApiDoc } from "./server/openapi.js";

describe("accounts SDK", () => {
  test("generated client.ts is in sync with the OpenAPI spec", () => {
    const onDisk = readFileSync(sdkClientPath(), "utf8");
    const { code, warnings } = renderSdk();
    expect(warnings).toEqual([]);
    expect(onDisk).toBe(code);
  });

  test("SDK re-exports the typed client + env factory", async () => {
    const mod = await import("./sdk/index.js");
    expect(typeof mod.AccountsClient).toBe("function");
    expect(typeof mod.createAccountsClientFromEnv).toBe("function");
  });

  test("createAccountsClientFromEnv reads ACCOUNTS_API_URL/KEY", async () => {
    const { createAccountsClientFromEnv } = await import("./sdk/index.js");
    const client = createAccountsClientFromEnv({ env: { ACCOUNTS_API_URL: "http://x", ACCOUNTS_API_KEY: "k" } as any });
    expect(client).toBeDefined();
    expect(() => createAccountsClientFromEnv({ env: {} as any })).toThrow(/ACCOUNTS_API_URL/);
  });

  test("OpenAPI document covers health/ready/version + versioned CRUD", () => {
    const doc = buildOpenApiDoc("1.2.3");
    expect(doc.info.version).toBe("1.2.3");
    for (const p of ["/health", "/ready", "/version", "/v1/accounts", "/v1/accounts/{tool}/{name}", "/v1/current", "/v1/current/{tool}", "/v1/tools"]) {
      expect(doc.paths[p]).toBeDefined();
    }
    expect((doc.paths["/v1/accounts"] as any).post.operationId).toBe("createAccount");
  });
});
