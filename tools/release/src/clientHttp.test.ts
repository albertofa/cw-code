import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type FetchLike, createClientHttp } from "./clientHttp.ts";

interface Call {
  url: string;
  headers: Record<string, string>;
  redirect: RequestRedirect | undefined;
  hasSignal: boolean;
}

function fakeFetch(respond: (url: string) => Response): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, headers: { ...(init.headers as Record<string, string>) }, redirect: init.redirect, hasSignal: init.signal instanceof AbortSignal });
      return respond(url);
    }
  };
}

describe("createClientHttp", () => {
  it("sends the token only to api.github.com and never follows an API redirect", async () => {
    const { fetch, calls } = fakeFetch(() => new Response("[]", { status: 200 }));
    const http = createClientHttp({ fetch, apiToken: "token-value" });
    await http.api("https://api.github.com/repos/albertofa/cw-code/releases?per_page=100");
    await http.text("https://github.com/albertofa/cw-code/releases/latest", "application/json");
    await http.size("https://github.com/albertofa/cw-code/releases/download/v1.0.0/cw-code-Setup-1.0.0-x64.exe");
    await http.digest("https://github.com/albertofa/cw-code/releases/download/v1.0.0/signing.json");
    expect(calls.map((call) => call.headers.Authorization ?? null)).toEqual(["Bearer token-value", null, null, null]);
    expect(calls.map((call) => call.redirect)).toEqual(["error", "follow", "follow", "follow"]);
    expect(calls.every((call) => call.hasSignal && call.headers["User-Agent"] === "cw-code-release-check")).toBe(true);
  });

  it("refuses to send an API request anywhere but api.github.com", async () => {
    const { fetch, calls } = fakeFetch(() => new Response("", { status: 200 }));
    const http = createClientHttp({ fetch, apiToken: "token-value" });
    await expect(http.api("https://github.com/albertofa/cw-code/releases")).rejects.toThrow(/only serves https:\/\/api\.github\.com\//);
    expect(calls).toEqual([]);
  });

  it("stays anonymous without a token", async () => {
    const { fetch, calls } = fakeFetch(() => new Response("[]", { status: 200 }));
    await createClientHttp({ fetch }).api("https://api.github.com/repos/albertofa/cw-code/releases");
    expect(calls[0].headers.Authorization).toBeUndefined();
  });

  it("reads the total size from a one-byte range request, or from Content-Length when ranges are ignored", async () => {
    const ranged = fakeFetch(() => new Response("M", { status: 206, headers: { "Content-Range": "bytes 0-0/104844558" } }));
    const http = createClientHttp({ fetch: ranged.fetch });
    expect(await http.size("https://example.test/installer.exe")).toEqual({ status: 206, size: 104844558 });
    expect(ranged.calls[0].headers.Range).toBe("bytes=0-0");
    const whole = fakeFetch(() => new Response("abcd", { status: 200, headers: { "Content-Length": "4" } }));
    expect(await createClientHttp({ fetch: whole.fetch }).size("https://example.test/installer.exe")).toEqual({ status: 200, size: 4 });
    const missing = fakeFetch(() => new Response("Not Found", { status: 404 }));
    expect(await createClientHttp({ fetch: missing.fetch }).size("https://example.test/installer.exe")).toEqual({ status: 404, size: null });
  });

  it("hashes a full download", async () => {
    const body = Buffer.from("installer bytes");
    const { fetch } = fakeFetch(() => new Response(body, { status: 200 }));
    expect(await createClientHttp({ fetch }).digest("https://example.test/file")).toEqual({
      status: 200,
      sha512: createHash("sha512").update(body).digest("base64"),
      size: body.length
    });
  });

  it("turns a network failure into status 0 instead of throwing, so callers can retry", async () => {
    const fetch: FetchLike = async () => {
      throw new Error("getaddrinfo ENOTFOUND github.com");
    };
    const http = createClientHttp({ fetch });
    expect(await http.text("https://github.com/x", "*/*")).toEqual({ status: 0, body: "no response: getaddrinfo ENOTFOUND github.com" });
    expect(await http.digest("https://github.com/x")).toEqual({ status: 0, sha512: "", size: 0 });
    expect(await http.size("https://github.com/x")).toEqual({ status: 0, size: null });
    expect((await http.api("https://api.github.com/x")).status).toBe(0);
  });
});
