const RECORDER_MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];

export function pickRecorderMimeType(isSupported: (mimeType: string) => boolean): string | null {
  return RECORDER_MIME_CANDIDATES.find((mimeType) => isSupported(mimeType)) ?? null;
}

/** Turns a getUserMedia / MediaRecorder failure into a message the user can act on. */
export function describeMicError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Microphone access is blocked. Allow microphone access for desktop apps in your system's privacy settings.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No microphone was found. Connect one and try again.";
    case "NotReadableError":
    case "AbortError":
      return "The microphone is busy or unavailable. Close other apps that use it and try again.";
    default: {
      const detail = error instanceof Error && error.message ? `: ${error.message}` : "";
      return `Could not start recording${detail}`;
    }
  }
}
