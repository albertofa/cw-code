import { describe, expect, it, vi } from "vitest";
import { audioFileName, GROQ_TRANSCRIPTION_URL, transcribeWithGroq, type GroqTranscribeInput } from "./groqTranscribe.js";

const KEY = "gsk_test_secret_value";

function input(overrides: Partial<GroqTranscribeInput> = {}): GroqTranscribeInput {
  return {
    apiKey: KEY,
    model: "whisper-large-v3-turbo",
    language: "pt",
    audio: new Uint8Array([1, 2, 3, 4]),
    mimeType: "audio/webm;codecs=opus",
    ...overrides
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("audioFileName", () => {
  it("maps recorder mime types, ignoring codec parameters", () => {
    expect(audioFileName("audio/webm;codecs=opus")).toBe("dictation.webm");
    expect(audioFileName("audio/WAV")).toBe("dictation.wav");
    expect(audioFileName("audio/mp4")).toBe("dictation.m4a");
  });

  it("rejects formats Groq does not accept", () => {
    expect(audioFileName("audio/aac")).toBeNull();
    expect(audioFileName("")).toBeNull();
  });
});

describe("transcribeWithGroq", () => {
  it("posts the recording with the key, model and language and returns the trimmed text", async () => {
    const fetchFn = vi.fn(async (_url: unknown, _init?: RequestInit) => jsonResponse(200, { text: "  olá mundo \n" }));
    const result = await transcribeWithGroq(input(), fetchFn as unknown as typeof fetch);

    expect(result).toEqual({ ok: true, text: "olá mundo" });
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(GROQ_TRANSCRIPTION_URL);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ Authorization: `Bearer ${KEY}` });
    const form = init.body as FormData;
    expect(form.get("model")).toBe("whisper-large-v3-turbo");
    expect(form.get("language")).toBe("pt");
    expect(form.get("response_format")).toBe("json");
    expect(form.get("temperature")).toBe("0");
    expect((form.get("file") as File).name).toBe("dictation.webm");
  });

  it("omits the language when it is automatic", async () => {
    const fetchFn = vi.fn(async (_url: unknown, _init?: RequestInit) => jsonResponse(200, { text: "hi" }));
    await transcribeWithGroq(input({ language: "auto" }), fetchFn as unknown as typeof fetch);
    expect(((fetchFn.mock.calls[0] as [string, RequestInit])[1].body as FormData).has("language")).toBe(false);
  });

  it("refuses an unsupported format without calling the network", async () => {
    const fetchFn = vi.fn();
    const result = await transcribeWithGroq(input({ mimeType: "audio/aac" }), fetchFn as unknown as typeof fetch);
    expect(result).toMatchObject({ ok: false, code: "unknown" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    [401, "invalid-key"],
    [403, "invalid-key"],
    [429, "rate-limited"],
    [413, "too-large"],
    [500, "server"],
    [503, "server"],
    [400, "unknown"]
  ])("maps HTTP %i to %s without leaking the key", async (status, code) => {
    const fetchFn = async () => jsonResponse(status, { error: { message: "something went wrong" } });
    const result = await transcribeWithGroq(input(), fetchFn as unknown as typeof fetch);
    expect(result).toMatchObject({ ok: false, code });
    expect(JSON.stringify(result)).not.toContain(KEY);
    if (!result.ok) expect(result.message).toContain("something went wrong");
  });

  it("copes with an error body that is not JSON", async () => {
    const fetchFn = async () => new Response("<html>bad gateway</html>", { status: 502 });
    const result = await transcribeWithGroq(input(), fetchFn as unknown as typeof fetch);
    expect(result).toMatchObject({ ok: false, code: "server" });
  });

  it("reports an unexpected success body as a server problem", async () => {
    const notJson = async () => new Response("not json", { status: 200 });
    expect(await transcribeWithGroq(input(), notJson as unknown as typeof fetch)).toMatchObject({ ok: false, code: "server" });
    const noText = async () => jsonResponse(200, { other: 1 });
    expect(await transcribeWithGroq(input(), noText as unknown as typeof fetch)).toMatchObject({ ok: false, code: "server" });
  });

  it("reports a network failure", async () => {
    const fetchFn = async () => {
      throw new TypeError("fetch failed");
    };
    const result = await transcribeWithGroq(input(), fetchFn as unknown as typeof fetch);
    expect(result).toMatchObject({ ok: false, code: "network" });
  });

  it("times out a request that never answers", async () => {
    const fetchFn = (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    const result = await transcribeWithGroq(input({ timeoutMs: 10 }), fetchFn as unknown as typeof fetch);
    expect(result).toMatchObject({ ok: false, code: "timeout" });
  });
});
