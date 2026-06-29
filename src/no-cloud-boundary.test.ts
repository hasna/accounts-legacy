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
  test("runtime package files do not depend on retired shared cloud markers", () => {
    const combined = checkedFiles
      .map((file) => readFileSync(join(process.cwd(), file), "utf8"))
      .join("\n");

    const retiredMarkers = [
      ["@hasna", "cloud"].join("/"),
      ["@hasna", ["open", "cloud"].join("-")].join("/"),
      ["open", "cloud"].join("-"),
      ["cloud", "tool"].join("-"),
      ["HASNA", "ACCOUNTS", "CLOUD"].join("_"),
      ["ACCOUNTS", "CLOUD"].join("_"),
    ];

    expect(combined).not.toMatch(new RegExp(retiredMarkers.join("|")));
  });
});
