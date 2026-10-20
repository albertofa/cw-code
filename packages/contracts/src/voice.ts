/** Where dictated speech is turned into text. "off" keeps the microphone button hidden. */
export type VoiceProvider = "off" | "groq";

export type VoiceLanguage = "pt" | "en" | "es" | "auto";

export type GroqVoiceModel = "whisper-large-v3-turbo" | "whisper-large-v3";

export interface VoiceSettings {
  provider: VoiceProvider;
  language: VoiceLanguage;
  groqModel: GroqVoiceModel;
}

/** State of the personal Groq credential. The key itself never leaves the main process. */
export interface GroqVoiceStatus {
  hasKey: boolean;
  /** False when the OS cannot encrypt secrets; saving a key is refused in that case. */
  encryptionAvailable: boolean;
  /** ISO timestamp of when the user accepted the data-sharing notice; null until then. */
  noticeAcceptedAt: string | null;
}

export type GroqKeyResult = { ok: true; status: GroqVoiceStatus } | { ok: false; message: string };

export type VoiceErrorCode =
  | "not-enabled"
  | "notice-not-accepted"
  | "no-key"
  | "invalid-key"
  | "rate-limited"
  | "too-large"
  | "empty-audio"
  | "network"
  | "timeout"
  | "server"
  | "unknown";

export type VoiceTranscribeResult =
  | { ok: true; text: string }
  | { ok: false; code: VoiceErrorCode; message: string };
