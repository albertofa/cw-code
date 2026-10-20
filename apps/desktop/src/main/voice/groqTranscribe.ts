import type { GroqVoiceModel, VoiceErrorCode, VoiceLanguage, VoiceTranscribeResult } from "@cw-code/contracts";

export const GROQ_TRANSCRIPTION_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
/** Groq's direct-upload cap on the free tier; larger recordings are refused before leaving the machine. */
export const GROQ_MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const ERROR_MESSAGE_MAX = 300;

export interface GroqTranscribeInput {
  apiKey: string;
  model: GroqVoiceModel;
  language: VoiceLanguage;
  audio: Uint8Array;
  mimeType: string;
  timeoutMs?: number;
}

const FILE_EXTENSION_BY_MIME: Record<string, string> = {
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/flac": "flac"
};

export function audioFileName(mimeType: string): string | null {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  const extension = FILE_EXTENSION_BY_MIME[base];
  return extension ? `dictation.${extension}` : null;
}

function failure(code: VoiceErrorCode, message: string): VoiceTranscribeResult {
  return { ok: false, code, message };
}

function truncate(text: string): string {
  return text.length <= ERROR_MESSAGE_MAX ? text : `${text.slice(0, ERROR_MESSAGE_MAX)}…`;
}

async function groqErrorDetail(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
    return typeof message === "string" ? truncate(message) : "";
  } catch {
    return "";
  }
}

function statusFailure(status: number, detail: string): VoiceTranscribeResult {
  const suffix = detail ? ` (${detail})` : "";
  if (status === 401 || status === 403) {
    return failure("invalid-key", `Groq rejected the API key. Check it in Settings → Voice.${suffix}`);
  }
  if (status === 429) return failure("rate-limited", `Groq rate limit reached. Try again in a moment.${suffix}`);
  if (status === 413) return failure("too-large", `Groq refused the recording because it is too large.${suffix}`);
  if (status >= 500) return failure("server", `Groq had a server problem (HTTP ${status}). Try again.${suffix}`);
  return failure("unknown", `Groq could not transcribe this recording (HTTP ${status}).${suffix}`);
}

/**
 * One transcription request to Groq's OpenAI-compatible endpoint. Never throws: every failure comes back as a
 * typed result, and the key appears only in the Authorization header.
 */
export async function transcribeWithGroq(
  input: GroqTranscribeInput,
  fetchFn: typeof fetch = fetch
): Promise<VoiceTranscribeResult> {
  const fileName = audioFileName(input.mimeType);
  if (!fileName) return failure("unknown", `The recording format "${input.mimeType}" is not supported by Groq.`);

  const form = new FormData();
  form.append("file", new Blob([input.audio as BlobPart], { type: input.mimeType }), fileName);
  form.append("model", input.model);
  form.append("response_format", "json");
  form.append("temperature", "0");
  if (input.language !== "auto") form.append("language", input.language);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchFn(GROQ_TRANSCRIPTION_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${input.apiKey}` },
      body: form,
      signal: controller.signal
    });
    if (!response.ok) return statusFailure(response.status, await groqErrorDetail(response));
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return failure("server", "Groq returned an unexpected response.");
    }
    const text = (body as { text?: unknown } | null)?.text;
    if (typeof text !== "string") return failure("server", "Groq returned an unexpected response.");
    return { ok: true, text: text.trim() };
  } catch (error) {
    if ((error as Error).name === "AbortError") return failure("timeout", "Groq took too long to answer. Try again.");
    return failure("network", "Could not reach Groq. Check your internet connection.");
  } finally {
    clearTimeout(timer);
  }
}
