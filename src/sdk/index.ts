// Public SDK surface for @hasna/accounts, generated from the accounts-serve
// OpenAPI document (see src/server/openapi.ts). Import via `@hasna/accounts/sdk`.
//
// self_hosted client convention: ACCOUNTS_API_URL + ACCOUNTS_API_KEY (never a
// DSN). The generated client speaks the Hasna auth convention (x-api-key).

export * from "./client.js";
import { AccountsClient, type AccountsClientOptions } from "./client.js";

export interface AccountsClientEnvOptions extends Partial<AccountsClientOptions> {
  env?: NodeJS.ProcessEnv;
}

/**
 * Build an {@link AccountsClient} from the environment.
 * Reads ACCOUNTS_API_URL and ACCOUNTS_API_KEY (overridable via options).
 */
export function createAccountsClientFromEnv(options: AccountsClientEnvOptions = {}): AccountsClient {
  const env = options.env ?? process.env;
  const baseUrl = options.baseUrl ?? env.ACCOUNTS_API_URL;
  if (!baseUrl) {
    throw new Error("createAccountsClientFromEnv requires ACCOUNTS_API_URL (or options.baseUrl).");
  }
  const apiKey = options.apiKey ?? env.ACCOUNTS_API_KEY;
  return new AccountsClient({
    baseUrl,
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    ...(options.headers !== undefined ? { headers: options.headers } : {}),
  });
}
