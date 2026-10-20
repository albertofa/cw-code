import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppSettings } from "@cw-code/contracts";
import { DEFAULT_SETTINGS } from "../settings/SettingsStore.js";
import { GroqCredentialStore, type SecretCipher } from "./groqCredentialStore.js";
import { GROQ_MAX_AUDIO_BYTES } from "./groqTranscribe.js";
import { VoiceService } from "./VoiceService.js";

const dirs: string[] = [];

const cipher: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(plain, "utf8"),
  decryptString: (encrypted) => encrypted.toString("utf8")
};

const SPEECH = new Uint8Array(2048).fill(7);

function setup(overrides: Partial<AppSettings> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cw-voice-"));
  dirs.push(dir);
  const credentials = new GroqCredentialStore(join(dir, "voice-groq.json"), cipher);
  const fetchFn = vi.fn(
    async (_url: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ text: "texto ditado" }), { status: 200, headers: { "content-type": "application/json" } })
  );
  const settings: AppSettings = { ...DEFAULT_SETTINGS, voiceProvider: "groq", ...overrides };
  const service = new VoiceService(() => settings, credentials, fetchFn as unknown as typeof fetch);
  return { service, credentials, fetchFn };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("VoiceService.setGroqKey", () => {
  it("returns the status after saving, without the key", () => {
    const { service } = setup();
    const result = service.setGroqKey("gsk_abc123");
    expect(result).toMatchObject({ ok: true, status: { hasKey: true } });
    expect(JSON.stringify(result)).not.toContain("gsk_abc123");
  });

  it("reports an invalid key as a result instead of throwing", () => {
    const { service } = setup();
    expect(service.setGroqKey("  ")).toEqual({ ok: false, message: "Enter your Groq API key." });
  });
});

describe("VoiceService.transcribeGroq", () => {
  it("is off by default and sends nothing", async () => {
    const { service, credentials, fetchFn } = setup({ voiceProvider: "off" });
    credentials.acceptNotice();
    credentials.setKey("gsk_abc123");
    expect(await service.transcribeGroq(SPEECH, "audio/webm")).toMatchObject({ ok: false, code: "not-enabled" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("requires the data-sharing notice to be accepted first", async () => {
    const { service, credentials, fetchFn } = setup();
    credentials.setKey("gsk_abc123");
    expect(await service.transcribeGroq(SPEECH, "audio/webm")).toMatchObject({ ok: false, code: "notice-not-accepted" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("requires a personal key", async () => {
    const { service, credentials, fetchFn } = setup();
    credentials.acceptNotice();
    expect(await service.transcribeGroq(SPEECH, "audio/webm")).toMatchObject({ ok: false, code: "no-key" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("skips the request for a recording with no speech", async () => {
    const { service, credentials, fetchFn } = setup();
    credentials.acceptNotice();
    credentials.setKey("gsk_abc123");
    expect(await service.transcribeGroq(new Uint8Array(10), "audio/webm")).toMatchObject({ ok: false, code: "empty-audio" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("refuses a recording over Groq's upload limit before it leaves the machine", async () => {
    const { service, credentials, fetchFn } = setup();
    credentials.acceptNotice();
    credentials.setKey("gsk_abc123");
    const result = await service.transcribeGroq(new Uint8Array(GROQ_MAX_AUDIO_BYTES + 1), "audio/webm");
    expect(result).toMatchObject({ ok: false, code: "too-large" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("transcribes with the configured model and language", async () => {
    const { service, credentials, fetchFn } = setup({ voiceGroqModel: "whisper-large-v3", voiceLanguage: "en" });
    credentials.acceptNotice();
    credentials.setKey("gsk_abc123");
    expect(await service.transcribeGroq(SPEECH, "audio/webm;codecs=opus")).toEqual({ ok: true, text: "texto ditado" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    const form = init.body as FormData;
    expect(form.get("model")).toBe("whisper-large-v3");
    expect(form.get("language")).toBe("en");
    expect(init.headers).toEqual({ Authorization: "Bearer gsk_abc123" });
  });
});
