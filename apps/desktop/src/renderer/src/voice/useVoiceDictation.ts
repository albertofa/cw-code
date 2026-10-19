import { useCallback, useEffect, useRef, useState } from "react";
import type { VoiceSettings } from "../cw.js";
import { MicError, startRecording, type ActiveRecording } from "./audioRecorder.js";

export type DictationPhase = "idle" | "recording" | "transcribing";

export interface VoiceDictation {
  phase: DictationPhase;
  /** Seconds recorded so far while recording. */
  elapsedSeconds: number;
  error: string | null;
  toggle(): void;
  cancel(): void;
  clearError(): void;
}

const NO_SPEECH = "No speech was detected. Try again closer to the microphone.";

async function transcribe(audio: { blob: Blob; mimeType: string }): Promise<string> {
  const result = await window.cw.voice.transcribeGroq(await audio.blob.arrayBuffer(), audio.mimeType);
  if (!result.ok) throw new MicError(result.message);
  return result.text;
}

/**
 * Record → transcribe → hand the text back. The provider is read when a recording stops, so changing
 * it in Settings applies to the next dictation. A cancelled or superseded run never delivers text.
 */
export function useVoiceDictation({
  voice,
  disabled,
  onText
}: {
  voice: VoiceSettings | null;
  disabled: boolean;
  onText: (text: string) => void;
}): VoiceDictation {
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recordingRef = useRef<ActiveRecording | null>(null);
  const runRef = useRef(0);
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const phaseRef = useRef<DictationPhase>("idle");
  phaseRef.current = phase;

  const cancel = useCallback(() => {
    runRef.current += 1;
    recordingRef.current?.cancel();
    recordingRef.current = null;
    setPhase("idle");
  }, []);

  const finish = useCallback(async () => {
    const recording = recordingRef.current;
    if (!recording) return;
    recordingRef.current = null;
    const run = ++runRef.current;
    const current = voiceRef.current;
    setPhase("transcribing");
    try {
      const audio = await recording.stop();
      if (run !== runRef.current) return;
      if (!current || current.provider === "off") throw new MicError("Dictation is turned off in Settings → Voice.");
      const text = (await transcribe(audio)).trim();
      if (run !== runRef.current) return;
      if (text) onTextRef.current(text);
      else setError(NO_SPEECH);
    } catch (err) {
      if (run !== runRef.current) return;
      setError(err instanceof Error && err.message ? err.message : "Dictation failed.");
    } finally {
      if (run === runRef.current) setPhase("idle");
    }
  }, []);

  const toggle = useCallback(() => {
    if (phaseRef.current === "transcribing") return;
    if (phaseRef.current === "recording") {
      void finish();
      return;
    }
    setError(null);
    const run = ++runRef.current;
    setPhase("recording");
    setElapsedSeconds(0);
    startRecording(() => void finish())
      .then((recording) => {
        if (run !== runRef.current) {
          recording.cancel();
          return;
        }
        recordingRef.current = recording;
      })
      .catch((err: unknown) => {
        if (run !== runRef.current) return;
        setPhase("idle");
        setError(err instanceof Error ? err.message : "Could not start recording.");
      });
  }, [finish]);

  useEffect(() => {
    if (phase !== "recording") return;
    const startedAt = Date.now();
    const timer = setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)), 250);
    return () => clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    if (phase !== "recording") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      cancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [phase, cancel]);

  useEffect(() => {
    if ((disabled || !voice || voice.provider === "off") && phaseRef.current !== "idle") cancel();
  }, [disabled, voice, cancel]);

  useEffect(() => cancel, [cancel]);

  return { phase, elapsedSeconds, error, toggle, cancel, clearError: () => setError(null) };
}
