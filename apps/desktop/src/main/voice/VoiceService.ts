import type { AppSettings, GroqKeyResult, GroqVoiceStatus, VoiceTranscribeResult } from "@cw-code/contracts";
import { GroqKeyError, type GroqCredentialStore } from "./groqCredentialStore.js";
import { GROQ_MAX_AUDIO_BYTES, transcribeWithGroq } from "./groqTranscribe.js";

/** Recordings shorter than this hold no speech; Groq bills a 10 second minimum, so skip the round trip. */
const MIN_AUDIO_BYTES = 512;

function failure(code: Extract<VoiceTranscribeResult, { ok: false }>["code"], message: string): VoiceTranscribeResult {
  return { ok: false, code, message };
}

/**
 * Main-process side of dictation. Audio only leaves the machine through here, and only when the user chose
 * Groq, accepted the data-sharing notice and stored their own key.
 */
export class VoiceService {
  constructor(
    private readonly getSettings: () => AppSettings,
    private readonly credentials: GroqCredentialStore,
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  groqStatus(): GroqVoiceStatus {
    return this.credentials.status();
  }

  acceptGroqNotice(): GroqVoiceStatus {
    return this.credentials.acceptNotice();
  }

  revokeGroqNotice(): GroqVoiceStatus {
    return this.credentials.revokeNotice();
  }

  setGroqKey(key: string): GroqKeyResult {
    try {
      return { ok: true, status: this.credentials.setKey(key) };
    } catch (error) {
      if (error instanceof GroqKeyError) return { ok: false, message: error.message };
      throw error;
    }
  }

  clearGroqKey(): GroqVoiceStatus {
    return this.credentials.clearKey();
  }

  async transcribeGroq(audio: Uint8Array, mimeType: string): Promise<VoiceTranscribeResult> {
    const settings = this.getSettings();
    if (settings.voiceProvider !== "groq") {
      return failure("not-enabled", "Groq dictation is not selected in Settings → Voice.");
    }
    if (this.credentials.status().noticeAcceptedAt === null) {
      return failure("notice-not-accepted", "Accept the data-sharing notice in Settings → Voice before using Groq.");
    }
    const apiKey = this.credentials.readKey();
    if (!apiKey) return failure("no-key", "Add your Groq API key in Settings → Voice.");
    if (audio.byteLength < MIN_AUDIO_BYTES) return failure("empty-audio", "No speech was recorded.");
    if (audio.byteLength > GROQ_MAX_AUDIO_BYTES) {
      return failure("too-large", "The recording is too large to send. Record a shorter clip.");
    }
    return transcribeWithGroq(
      { apiKey, model: settings.voiceGroqModel, language: settings.voiceLanguage, audio, mimeType },
      this.fetchFn
    );
  }
}
