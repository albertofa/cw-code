import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GroqCredentialStore, GroqKeyError, type SecretCipher } from "./groqCredentialStore.js";

const dirs: string[] = [];

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "cw-groq-"));
  dirs.push(dir);
  return join(dir, "nested", "voice-groq.json");
}

function fakeCipher(available = true): SecretCipher & { broken: boolean } {
  const cipher = {
    broken: false,
    isEncryptionAvailable: () => available,
    encryptString: (plain: string) => Buffer.from(`enc:${Buffer.from(plain).toString("hex")}`),
    decryptString: (encrypted: Buffer) => {
      if (cipher.broken) throw new Error("cannot decrypt");
      return Buffer.from(encrypted.toString().replace(/^enc:/, ""), "hex").toString();
    }
  };
  return cipher;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("GroqCredentialStore", () => {
  it("starts empty", () => {
    const store = new GroqCredentialStore(tempFile(), fakeCipher());
    expect(store.status()).toEqual({ hasKey: false, encryptionAvailable: true, noticeAcceptedAt: null });
    expect(store.readKey()).toBeNull();
  });

  it("stores the key encrypted and reads it back in the main process", () => {
    const file = tempFile();
    const store = new GroqCredentialStore(file, fakeCipher());
    expect(store.setKey("  gsk_abc123  ").hasKey).toBe(true);
    expect(store.readKey()).toBe("gsk_abc123");
    expect(readFileSync(file, "utf8")).not.toContain("gsk_abc123");
  });

  it("never exposes the key through status", () => {
    const store = new GroqCredentialStore(tempFile(), fakeCipher());
    store.setKey("gsk_abc123");
    expect(JSON.stringify(store.status())).not.toContain("gsk_abc123");
  });

  it("clears the key without touching the accepted notice", () => {
    const store = new GroqCredentialStore(tempFile(), fakeCipher(), () => new Date("2026-10-19T12:00:00.000Z"));
    store.acceptNotice();
    store.setKey("gsk_abc123");
    expect(store.clearKey()).toEqual({ hasKey: false, encryptionAvailable: true, noticeAcceptedAt: "2026-10-19T12:00:00.000Z" });
  });

  it("records and revokes the notice acceptance", () => {
    const store = new GroqCredentialStore(tempFile(), fakeCipher(), () => new Date("2026-10-19T12:00:00.000Z"));
    expect(store.acceptNotice().noticeAcceptedAt).toBe("2026-10-19T12:00:00.000Z");
    expect(store.revokeNotice().noticeAcceptedAt).toBeNull();
  });

  it("refuses to store a key when the system cannot encrypt", () => {
    const store = new GroqCredentialStore(tempFile(), fakeCipher(false));
    expect(() => store.setKey("gsk_abc123")).toThrow(GroqKeyError);
    expect(store.status().hasKey).toBe(false);
  });

  it("rejects empty keys and keys with whitespace inside", () => {
    const store = new GroqCredentialStore(tempFile(), fakeCipher());
    expect(() => store.setKey("   ")).toThrow(GroqKeyError);
    expect(() => store.setKey("gsk abc")).toThrow(GroqKeyError);
  });

  it("treats a key that cannot be decrypted as missing and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cipher = fakeCipher();
    const store = new GroqCredentialStore(tempFile(), cipher);
    store.setKey("gsk_abc123");
    cipher.broken = true;
    expect(store.status().hasKey).toBe(false);
    expect(store.readKey()).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("treats a corrupt file as empty and warns instead of throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const file = tempFile();
    const store = new GroqCredentialStore(file, fakeCipher());
    store.setKey("gsk_abc123");
    writeFileSync(file, "{ not json", "utf8");
    expect(store.status()).toEqual({ hasKey: false, encryptionAvailable: true, noticeAcceptedAt: null });
    expect(warn).toHaveBeenCalled();
  });
});
