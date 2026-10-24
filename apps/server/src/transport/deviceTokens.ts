import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendCrashLog } from "../debug/crashLog.js";

export interface DeviceRecord {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number | null;
}

interface DevicesFile {
  version: 1;
  devices: DeviceRecord[];
}

const DEVICES_FILE = "devices.json";
const OWNER_ONLY = 0o600;
const MAX_NAME_LENGTH = 64;
const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function isRecord(value: unknown): value is DeviceRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    typeof record.tokenHash === "string" &&
    TOKEN_HASH_PATTERN.test(record.tokenHash) &&
    typeof record.createdAt === "number" &&
    (record.lastSeenAt === null || typeof record.lastSeenAt === "number")
  );
}

export class DeviceTokens {
  private devices: DeviceRecord[];
  private readonly path: string;

  constructor(private readonly dir: string) {
    this.path = join(dir, DEVICES_FILE);
    this.devices = this.load();
  }

  list(): DeviceRecord[] {
    return this.devices.map((device) => ({ ...device }));
  }

  count(): number {
    return this.devices.length;
  }

  create(name: string): { record: DeviceRecord; token: string } {
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > MAX_NAME_LENGTH) {
      throw Object.assign(new Error(`device name must be 1 to ${MAX_NAME_LENGTH} characters`), { code: "invalid-name" });
    }
    const token = randomBytes(32).toString("hex");
    const record: DeviceRecord = {
      id: `dev_${randomBytes(4).toString("hex")}`,
      name: trimmed,
      tokenHash: hashToken(token).toString("hex"),
      createdAt: Date.now(),
      lastSeenAt: null
    };
    this.devices = [...this.devices, record];
    this.save();
    return { record: { ...record }, token };
  }

  revoke(id: string): boolean {
    const remaining = this.devices.filter((device) => device.id !== id);
    if (remaining.length === this.devices.length) return false;
    this.devices = remaining;
    this.save();
    return true;
  }

  verify(token: string): DeviceRecord | null {
    const received = hashToken(token);
    let match: DeviceRecord | null = null;
    for (const device of this.devices) {
      if (timingSafeEqual(Buffer.from(device.tokenHash, "hex"), received)) match = device;
    }
    return match ? { ...match } : null;
  }

  touch(id: string, at: number): void {
    const device = this.devices.find((candidate) => candidate.id === id);
    if (!device) return;
    device.lastSeenAt = at;
    try {
      this.save();
    } catch (error) {
      console.warn(`could not record device activity: ${(error as Error).message}`);
    }
  }

  private load(): DeviceRecord[] {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      return this.corrupt((error as Error).message);
    }
    try {
      const parsed = JSON.parse(raw) as Partial<DevicesFile> | null;
      if (parsed?.version === 1 && Array.isArray(parsed.devices) && parsed.devices.every(isRecord)) return parsed.devices;
      return this.corrupt("unexpected shape");
    } catch (error) {
      return this.corrupt((error as Error).message);
    }
  }

  private corrupt(reason: string): DeviceRecord[] {
    const message = `${this.path} is unreadable (${reason}); treating it as having no devices`;
    console.warn(message);
    appendCrashLog(message);
    return [];
  }

  private save(): void {
    mkdirSync(this.dir, { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    const file: DevicesFile = { version: 1, devices: this.devices };
    writeFileSync(temp, JSON.stringify(file, null, 2), { mode: OWNER_ONLY });
    try {
      chmodSync(temp, OWNER_ONLY);
    } catch (error) {
      if (process.platform !== "win32") console.warn(`could not restrict ${temp} to its owner: ${(error as Error).message}`);
    }
    renameSync(temp, this.path);
  }
}
