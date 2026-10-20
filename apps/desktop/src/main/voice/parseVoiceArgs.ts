const MIME_TYPE_MAX = 100;

/** The renderer is untrusted input: check the shape of a transcription request before it reaches the service. */
export function parseTranscribeArgs(args: unknown): { audio: Uint8Array; mimeType: string } {
  const o = args && typeof args === "object" ? (args as Record<string, unknown>) : null;
  const audio = o?.audio;
  const mimeType = o?.mimeType;
  if (typeof mimeType !== "string" || !mimeType || mimeType.length > MIME_TYPE_MAX) {
    throw new Error("voice.transcribeGroq requires { audio, mimeType }");
  }
  if (audio instanceof ArrayBuffer) return { audio: new Uint8Array(audio), mimeType };
  if (ArrayBuffer.isView(audio)) return { audio: new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength), mimeType };
  throw new Error("voice.transcribeGroq requires { audio, mimeType }");
}

export function parseGroqKeyArg(arg: unknown): string {
  if (typeof arg !== "string") throw new Error("voice.setGroqKey requires the key as a string");
  return arg;
}
