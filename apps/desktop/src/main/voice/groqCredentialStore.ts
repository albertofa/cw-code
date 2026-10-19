import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { GroqVoiceStatus } from "@cw-code/contracts";
import { readBytesIfExists, writeFileAtomic } from "../storage/atomicFile.js";

/** The slice of Electron's safeStorage the store needs, so tests can supply their own cipher. */
export interface SecretCipher {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

interface StoredGroqCredential {
  schemaVersion: 1;
  noticeAcceptedAt: string | null;
  /** base64 of the OS-encrypted key; never the plain key. */
  keyCipher: string | null;
}

const EMPTY: StoredGroqCredential = { schemaVersion: 1, noticeAcceptedAt: null, keyCipher: null };

export class GroqKeyError extends Error {}

/**
 * Holds the user's personal Groq key (encrypted with the OS keychain) and the record that they accepted
 * the data-sharing notice. Lives in its own file, outside the plain-text settings document.
 */
export class GroqCredentialStore {
  constructor(
    private readonly filePath: string,
    private readonly cipher: SecretCipher,
    private readonly now: () => Date = () => new Date()
  ) {}

  status(): GroqVoiceStatus {
    const stored = this.read();
    return {
      hasKey: this.decryptKey(stored) !== null,
      encryptionAvailable: this.cipher.isEncryptionAvailable(),
      noticeAcceptedAt: stored.noticeAcceptedAt
    };
  }

  acceptNotice(): GroqVoiceStatus {
    const stored = this.read();
    this.write({ ...stored, noticeAcceptedAt: this.now().toISOString() });
    return this.status();
  }

  revokeNotice(): GroqVoiceStatus {
    this.write({ ...this.read(), noticeAcceptedAt: null });
    return this.status();
  }

  setKey(rawKey: string): GroqVoiceStatus {
    const key = typeof rawKey === "string" ? rawKey.trim() : "";
    if (!key) throw new GroqKeyError("Enter your Groq API key.");
    if (/\s/.test(key)) throw new GroqKeyError("A Groq API key has no spaces or line breaks.");
    if (!this.cipher.isEncryptionAvailable()) {
      throw new GroqKeyError("This system cannot encrypt secrets, so cw-code will not store the key.");
    }
    const keyCipher = this.cipher.encryptString(key).toString("base64");
    this.write({ ...this.read(), keyCipher });
    return this.status();
  }

  clearKey(): GroqVoiceStatus {
    this.write({ ...this.read(), keyCipher: null });
    return this.status();
  }

  /** Main-process only: the plain key for an outgoing request. Null when none is stored or it cannot be decrypted. */
  readKey(): string | null {
    return this.decryptKey(this.read());
  }

  private decryptKey(stored: StoredGroqCredential): string | null {
    if (!stored.keyCipher) return null;
    try {
      const key = this.cipher.decryptString(Buffer.from(stored.keyCipher, "base64"));
      return key || null;
    } catch (error) {
      console.warn(`voice: could not decrypt the stored Groq key: ${(error as Error).message}`);
      return null;
    }
  }

  private read(): StoredGroqCredential {
    let bytes: Buffer | null;
    try {
      bytes = readBytesIfExists(this.filePath);
    } catch (error) {
      console.warn(`voice: could not read ${this.filePath}: ${(error as Error).message}`);
      return { ...EMPTY };
    }
    if (!bytes) return { ...EMPTY };
    try {
      const raw: unknown = JSON.parse(bytes.toString("utf8"));
      if (!raw || typeof raw !== "object") return { ...EMPTY };
      const o = raw as Record<string, unknown>;
      return {
        schemaVersion: 1,
        noticeAcceptedAt: typeof o.noticeAcceptedAt === "string" ? o.noticeAcceptedAt : null,
        keyCipher: typeof o.keyCipher === "string" && o.keyCipher ? o.keyCipher : null
      };
    } catch (error) {
      console.warn(`voice: ${this.filePath} is not valid JSON, treating it as empty: ${(error as Error).message}`);
      return { ...EMPTY };
    }
  }

  private write(next: StoredGroqCredential): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileAtomic(this.filePath, `${JSON.stringify(next, null, 2)}\n`);
  }
}
