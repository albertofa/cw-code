import { describeMicError, pickRecorderMimeType } from "./recorderSupport.js";

/** A dictation is a short prompt, not a recording session; stop on its own after this long. */
export const MAX_RECORDING_MS = 5 * 60_000;

export interface RecordedAudio {
  blob: Blob;
  mimeType: string;
  durationMs: number;
}

export interface ActiveRecording {
  stop(): Promise<RecordedAudio>;
  /** Discards the recording and releases the microphone. */
  cancel(): void;
}

/** A failure already phrased for the user. */
export class MicError extends Error {}

export async function startRecording(onLimitReached: () => void): Promise<ActiveRecording> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    throw new MicError("Audio recording is not supported in this window.");
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    });
  } catch (error) {
    throw new MicError(describeMicError(error));
  }
  const release = () => stream.getTracks().forEach((track) => track.stop());

  const mimeType = pickRecorderMimeType((type) => MediaRecorder.isTypeSupported(type));
  if (!mimeType) {
    release();
    throw new MicError("This system cannot record audio in a format cw-code can use.");
  }

  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32_000 });
  } catch (error) {
    release();
    throw new MicError(describeMicError(error));
  }

  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  const startedAt = performance.now();
  const limitTimer = setTimeout(onLimitReached, MAX_RECORDING_MS);
  recorder.start();

  return {
    stop: () =>
      new Promise<RecordedAudio>((resolve, reject) => {
        clearTimeout(limitTimer);
        recorder.onerror = () => {
          release();
          reject(new MicError("The recording failed. Try again."));
        };
        recorder.onstop = () => {
          release();
          resolve({ blob: new Blob(chunks, { type: mimeType }), mimeType, durationMs: performance.now() - startedAt });
        };
        if (recorder.state === "inactive") recorder.onstop(new Event("stop"));
        else recorder.stop();
      }),
    cancel: () => {
      clearTimeout(limitTimer);
      chunks.length = 0;
      recorder.ondataavailable = null;
      recorder.onstop = release;
      if (recorder.state === "inactive") release();
      else recorder.stop();
    }
  };
}
