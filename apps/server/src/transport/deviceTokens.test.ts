import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceTokens } from "./deviceTokens.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cw-device-tokens-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("DeviceTokens", () => {
  test("creates a device whose token verifies", () => {
    const devices = new DeviceTokens(root);
    const { record, token } = devices.create("  Phone  ");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(record.id).toMatch(/^dev_[0-9a-f]{8}$/);
    expect(record.name).toBe("Phone");
    expect(devices.verify(token)?.id).toBe(record.id);
    expect(devices.verify("0".repeat(64))).toBeNull();
    expect(devices.verify("short")).toBeNull();
    expect(devices.count()).toBe(1);
  });

  test("rejects empty and oversize names", () => {
    const devices = new DeviceTokens(root);
    expect(() => devices.create("   ")).toThrow();
    expect(() => devices.create("x".repeat(65))).toThrow();
    expect(devices.count()).toBe(0);
  });

  test("never writes the raw token to disk", () => {
    const devices = new DeviceTokens(root);
    const { token } = devices.create("Laptop");
    expect(readFileSync(join(root, "devices.json"), "utf8")).not.toContain(token);
  });

  test("persists devices across instances", () => {
    const { token } = new DeviceTokens(root).create("Tablet");
    expect(new DeviceTokens(root).verify(token)?.name).toBe("Tablet");
  });

  test("revoke removes the device and its token stops verifying", () => {
    const devices = new DeviceTokens(root);
    const { record, token } = devices.create("Phone");
    expect(devices.revoke(record.id)).toBe(true);
    expect(devices.revoke(record.id)).toBe(false);
    expect(devices.verify(token)).toBeNull();
    expect(new DeviceTokens(root).count()).toBe(0);
  });

  test("touch records lastSeenAt", () => {
    const devices = new DeviceTokens(root);
    const { record } = devices.create("Phone");
    devices.touch(record.id, 1234);
    expect(new DeviceTokens(root).list()[0]?.lastSeenAt).toBe(1234);
  });

  test("a corrupt file means zero devices", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      writeFileSync(join(root, "devices.json"), "{not json");
      const devices = new DeviceTokens(root);
      expect(devices.count()).toBe(0);
      expect(warn).toHaveBeenCalled();
      expect(devices.create("Phone").record.name).toBe("Phone");
      expect(readdirSync(root).some((name) => name.startsWith("devices.json.corrupt-"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test("touch persists only when the stored value is stale", () => {
    const devices = new DeviceTokens(root);
    const { record } = devices.create("Phone");
    devices.touch(record.id, 1_000_000);
    devices.touch(record.id, 1_030_000);
    expect(devices.list()[0]?.lastSeenAt).toBe(1_030_000);
    expect(new DeviceTokens(root).list()[0]?.lastSeenAt).toBe(1_000_000);
    devices.touch(record.id, 1_070_000);
    expect(new DeviceTokens(root).list()[0]?.lastSeenAt).toBe(1_070_000);
  });

  test("a failed save leaves the in-memory list unchanged", () => {
    const devices = new DeviceTokens(root);
    const { record } = devices.create("Phone");
    rmSync(root, { recursive: true, force: true });
    writeFileSync(root, "not a directory");
    try {
      expect(() => devices.revoke(record.id)).toThrow();
      expect(() => devices.create("Other")).toThrow();
      expect(devices.count()).toBe(1);
    } finally {
      rmSync(root, { force: true });
      mkdirSync(root);
    }
  });

  test("an unreadable file is kept and never overwritten", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      mkdirSync(join(root, "devices.json"));
      const devices = new DeviceTokens(root);
      expect(devices.count()).toBe(0);
      expect(() => devices.create("Phone")).toThrow();
      expect(existsSync(join(root, "devices.json"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
