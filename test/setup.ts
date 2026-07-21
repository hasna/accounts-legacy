// Keep the default Bun test process and its child CLI fixtures hermetic on
// stations configured for the real Accounts API. Individual tests can still
// opt into cloud mode by passing an explicit environment object or child env.
for (const key of [
  "HASNA_ACCOUNTS_API_URL",
  "HASNA_ACCOUNTS_API_KEY",
  "ACCOUNTS_API_URL",
  "ACCOUNTS_API_KEY",
  "ACCOUNTS_STORAGE_MODE",
  "HASNA_ACCOUNTS_MODE",
]) {
  delete process.env[key];
}
process.env.HASNA_ACCOUNTS_STORAGE_MODE = "local";
