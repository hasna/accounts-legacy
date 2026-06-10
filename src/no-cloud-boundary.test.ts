import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const checkedFiles = [
  "package.json",
  "src/index.ts",
  "src/storage.ts",
  "src/cli.ts",
  "src/mcp.ts",
];

describe("no shared cloud package boundary", () => {
  test("runtime package files do not depend on @hasna/cloud or open-cloud", () => {
    const combined = checkedFiles
      .map((file) => readFileSync(join(process.cwd(), file), "utf8"))
      .join("\n");

    expect(combined).not.toMatch(/@hasna\/cloud|open-cloud|HASNA_ACCOUNTS_CLOUD|ACCOUNTS_CLOUD/);
  });
});
