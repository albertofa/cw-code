// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceSettings } from "../cw.js";
import type { ActiveRecording } from "./audioRecorder.js";
import { useVoiceDictation, type VoiceDictation } from "./useVoiceDictation.js";

const startRecording = vi.fn<(onLimitReached: () => void) => Promise<ActiveRecording>>();

vi.mock("./audioRecorder.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./audioRecorder.js")>();
  return { ...actual, startRecording: (onLimitReached: () => void) => startRecording(onLimitReached) };
});

const VOICE: VoiceSettings = { provider: "groq", language: "auto", groqModel: "whisper-large-v3-turbo" };

/** A start that stays in flight until the test resolves it, like a pending microphone prompt. */
function deferredRecording() {
  const recording = { stop: vi.fn(), cancel: vi.fn() };
  let install!: () => void;
  startRecording.mockReturnValueOnce(
    new Promise<ActiveRecording>((resolve) => {
      install = () => resolve(recording as unknown as ActiveRecording);
    })
  );
  return { recording, install };
}

let container: HTMLDivElement;
let root: Root;
let api: VoiceDictation;

function mount(onText = vi.fn()) {
  function Probe() {
    api = useVoiceDictation({ voice: VOICE, disabled: false, onText });
    return null;
  }
  act(() => root.render(<Probe />));
  return onText;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  startRecording.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useVoiceDictation", () => {
  it("drops a start that the user stopped before the recorder was ready", async () => {
    const { recording, install } = deferredRecording();
    const onText = mount();

    act(() => api.toggle());
    expect(api.phase).toBe("recording");

    act(() => api.toggle());
    expect(api.phase).toBe("idle");

    await act(async () => {
      install();
    });

    expect(recording.cancel).toHaveBeenCalledTimes(1);
    expect(recording.stop).not.toHaveBeenCalled();
    expect(onText).not.toHaveBeenCalled();
    expect(api.phase).toBe("idle");
  });

  it("stops and transcribes once the recorder is installed", async () => {
    const { recording, install } = deferredRecording();
    recording.stop.mockResolvedValue({ blob: new Blob(["x"]), mimeType: "audio/webm", durationMs: 10 });
    const transcribeGroq = vi.fn().mockResolvedValue({ ok: true, text: " hello " });
    (window as unknown as { cw: unknown }).cw = { voice: { transcribeGroq } };
    const onText = mount();

    act(() => api.toggle());
    await act(async () => {
      install();
    });
    expect(api.phase).toBe("recording");

    await act(async () => api.toggle());

    expect(recording.stop).toHaveBeenCalledTimes(1);
    expect(recording.cancel).not.toHaveBeenCalled();
    expect(onText).toHaveBeenCalledWith("hello");
    expect(api.phase).toBe("idle");
  });
});
