import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateOwnerToken } from "./ownerToken.js";

const HEX_TOKEN = /^[0-9a-f]{64}$/;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cw-owner-token-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("loadOrCreateOwnerToken", () => {
  test("creates the directory and a persisted token", () => {
    const dir = join(root, "nested", "data");
    const token = loadOrCreateOwnerToken(dir);
    expect(token).toMatch(HEX_TOKEN);
    expect(readFileSync(join(dir, "server-token"), "utf8")).toBe(token);
  });

  test("reuses an existing valid token, trimming whitespace", () => {
    const token = "ab".repeat(32);
    writeFileSync(join(root, "server-token"), `${token}\n`);
    expect(loadOrCreateOwnerToken(root)).toBe(token);
  });

  test("returns the same token on repeated calls", () => {
    expect(loadOrCreateOwnerToken(root)).toBe(loadOrCreateOwnerToken(root));
  });

  test.each([["garbage"], [""], ["AB".repeat(32)], ["ab".repeat(31)]])("regenerates an invalid token %p", (invalid) => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      writeFileSync(join(root, "server-token"), invalid);
      const token = loadOrCreateOwnerToken(root);
      expect(token).toMatch(HEX_TOKEN);
      expect(readFileSync(join(root, "server-token"), "utf8")).toBe(token);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
