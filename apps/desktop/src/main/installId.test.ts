import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSTALL_ID_FILE, readOrCreateInstallId } from "./installId.js";

const UUID = "0b6f7c1e-7d8a-4b51-9f3e-2a1c5d6e7f80";
const OTHER = "11111111-2222-4333-8444-555555555555";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cw-install-id-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("readOrCreateInstallId", () => {
  it("creates the id once and returns the stored one afterwards", () => {
    expect(readOrCreateInstallId(root, () => UUID)).toBe(UUID);
    expect(readFileSync(join(root, INSTALL_ID_FILE), "utf8").trim()).toBe(UUID);
    expect(readOrCreateInstallId(root, () => OTHER)).toBe(UUID);
  });

  it("creates the user data folder when it is missing", () => {
    expect(readOrCreateInstallId(join(root, "nested", "userData"), () => UUID)).toBe(UUID);
  });

  it("replaces a missing, empty or malformed id", () => {
    writeFileSync(join(root, INSTALL_ID_FILE), "not-an-id\n");
    expect(readOrCreateInstallId(root, () => OTHER)).toBe(OTHER);
    writeFileSync(join(root, INSTALL_ID_FILE), "");
    expect(readOrCreateInstallId(root, () => UUID)).toBe(UUID);
  });

  it("defaults to a random UUID", () => {
    expect(readOrCreateInstallId(root)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
