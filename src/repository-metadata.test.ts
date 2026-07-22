import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface PackageMetadata {
  repository?: { type?: string; url?: string };
  homepage?: string;
  bugs?: { url?: string };
}

describe("repository metadata", () => {
  test("points package consumers to the canonical repository", () => {
    const packageMetadata = JSON.parse(
      readFileSync(join(import.meta.dir, "../package.json"), "utf8"),
    ) as PackageMetadata;

    expect(packageMetadata.repository).toEqual({
      type: "git",
      url: "git+https://github.com/hasna/accounts.git",
    });
    expect(packageMetadata.homepage).toBe("https://github.com/hasna/accounts");
    expect(packageMetadata.bugs?.url).toBe(
      "https://github.com/hasna/accounts/issues",
    );
  });
});
