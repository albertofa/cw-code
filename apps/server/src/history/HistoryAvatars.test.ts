import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AvatarAuthError,
  AvatarNotFoundError,
  AvatarUnavailableError,
  HistoryAvatarService,
  classifyAvatarFailure,
  githubAvatarFromEmail,
  normalizeAvatarUrl,
  parseAvatarAuthors,
  type AvatarLookup,
  type AvatarRemote
} from "./HistoryAvatars.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const GITHUB: AvatarRemote = { host: "github.com", owner: "acme", repository: "widgets" };
const AVATAR = "https://avatars.githubusercontent.com/u/42?v=4";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function cacheFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "cw-avatars-"));
  dirs.push(dir);
  return join(dir, "history-avatars.json");
}

function setup(options: { lookup?: AvatarLookup; remote?: AvatarRemote | null; file?: string; now?: () => number } = {}) {
  const calls: string[] = [];
  const lookup: AvatarLookup =
    options.lookup ??
    (async (_owner, _repo, sha) => {
      calls.push(sha);
      return AVATAR;
    });
  const service = new HistoryAvatarService({
    cacheFile: options.file ?? cacheFile(),
    remote: async () => (options.remote === undefined ? GITHUB : options.remote),
    lookup: async (owner, repo, sha) => {
      if (options.lookup) calls.push(sha);
      return lookup(owner, repo, sha);
    },
    now: options.now
  });
  return { service, calls };
}

describe("githubAvatarFromEmail", () => {
  it("maps noreply addresses to avatar urls", () => {
    expect(githubAvatarFromEmail("12345+octo@users.noreply.github.com")).toBe("https://avatars.githubusercontent.com/u/12345?s=64");
    expect(githubAvatarFromEmail("octo@users.noreply.github.com")).toBe("https://avatars.githubusercontent.com/octo?s=64");
    expect(githubAvatarFromEmail("octo@example.com")).toBeNull();
  });
});

describe("normalizeAvatarUrl", () => {
  it("keeps only https urls on the GitHub avatar host and sets the size", () => {
    expect(normalizeAvatarUrl(AVATAR)).toBe("https://avatars.githubusercontent.com/u/42?v=4&s=64");
    expect(normalizeAvatarUrl("http://avatars.githubusercontent.com/u/42")).toBeNull();
    expect(normalizeAvatarUrl("https://evil.example.com/u/42")).toBeNull();
    expect(normalizeAvatarUrl("not a url")).toBeNull();
  });
});

describe("classifyAvatarFailure", () => {
  it("maps gh messages to failure kinds", () => {
    expect(classifyAvatarFailure("gh: Not Found (HTTP 404)")).toBeInstanceOf(AvatarNotFoundError);
    expect(classifyAvatarFailure("No commit found for SHA (HTTP 422)")).toBeInstanceOf(AvatarNotFoundError);
    expect(classifyAvatarFailure("API rate limit exceeded (HTTP 403)")).toBeInstanceOf(AvatarAuthError);
    expect(classifyAvatarFailure("Bad credentials (HTTP 401)")).toBeInstanceOf(AvatarAuthError);
    expect(classifyAvatarFailure("GitHub CLI not found")).toBeInstanceOf(AvatarUnavailableError);
    expect(classifyAvatarFailure("No authenticated github.com account in gh")).toBeInstanceOf(AvatarUnavailableError);
    const other = classifyAvatarFailure("connection reset");
    expect(other).not.toBeInstanceOf(AvatarNotFoundError);
    expect(other).not.toBeInstanceOf(AvatarAuthError);
    expect(other).not.toBeInstanceOf(AvatarUnavailableError);
  });
});

describe("parseAvatarAuthors", () => {
  it("accepts up to 3 full shas per author", () => {
    expect(parseAvatarAuthors([{ email: "a@b.c", shas: [SHA_A, SHA_B] }])).toEqual([{ email: "a@b.c", shas: [SHA_A, SHA_B] }]);
  });

  it("rejects malformed input", () => {
    expect(() => parseAvatarAuthors("x")).toThrow();
    expect(() => parseAvatarAuthors([{ email: "a b@c", shas: [SHA_A] }])).toThrow();
    expect(() => parseAvatarAuthors([{ email: "a@b.c", shas: [] }])).toThrow();
    expect(() => parseAvatarAuthors([{ email: "a@b.c", shas: ["abc"] }])).toThrow();
    expect(() => parseAvatarAuthors([{ email: "a@b.c", shas: [SHA_A, SHA_B, SHA_C, SHA_A] }])).toThrow();
    expect(() => parseAvatarAuthors(Array.from({ length: 101 }, () => ({ email: "a@b.c", shas: [SHA_A] })))).toThrow();
  });
});

describe("HistoryAvatarService", () => {
  it("uses the noreply address without calling gh", async () => {
    const { service, calls } = setup();
    const result = await service.resolve("/repo", [{ email: "7+octo@users.noreply.github.com", shas: [SHA_A] }]);
    expect(result.avatars["7+octo@users.noreply.github.com"]).toBe("https://avatars.githubusercontent.com/u/7?s=64");
    expect(calls).toEqual([]);
  });

  it("looks the author up, lowercases the email and persists the cache", async () => {
    const file = cacheFile();
    const { service, calls } = setup({ file });
    const result = await service.resolve("/repo", [{ email: "Dev@Example.com", shas: [SHA_A] }]);
    expect(result).toEqual({ avatars: { "dev@example.com": "https://avatars.githubusercontent.com/u/42?v=4&s=64" }, pending: [] });
    expect(calls).toEqual([SHA_A]);
    await service.flush();
    expect(JSON.parse(readFileSync(file, "utf8"))["dev@example.com"].url).toBe("https://avatars.githubusercontent.com/u/42?v=4&s=64");
    const again = setup({ file, lookup: async () => null });
    await again.service.resolve("/repo", [{ email: "dev@example.com", shas: [SHA_A] }]);
    expect(again.calls).toEqual([]);
  });

  it("returns null without calling gh when the remote is not GitHub", async () => {
    const { service, calls } = setup({ remote: { host: "gitlab.example.com", owner: "acme", repository: "widgets" } });
    const result = await service.resolve("/repo", [{ email: "dev@example.com", shas: [SHA_A] }]);
    expect(result.avatars["dev@example.com"]).toBeNull();
    expect(calls).toEqual([]);
  });

  it("tries the next sha when a commit is not on GitHub", async () => {
    const { service, calls } = setup({
      lookup: async (_owner, _repo, sha) => {
        if (sha === SHA_A) throw new AvatarNotFoundError("HTTP 404");
        return AVATAR;
      }
    });
    const result = await service.resolve("/repo", [{ email: "dev@example.com", shas: [SHA_A, SHA_B] }]);
    expect(calls).toEqual([SHA_A, SHA_B]);
    expect(result.avatars["dev@example.com"]).not.toBeNull();
  });

  it("caches an author whose commits are all missing on GitHub for 6 hours", async () => {
    let now = 1_000;
    const missing = setup({
      now: () => now,
      lookup: async () => {
        throw new AvatarNotFoundError("HTTP 404");
      }
    });
    const request = [{ email: "dev@example.com", shas: [SHA_A, SHA_B] }];
    expect(await missing.service.resolve("/repo", request)).toEqual({ avatars: { "dev@example.com": null }, pending: [] });
    await missing.service.resolve("/repo", request);
    expect(missing.calls).toEqual([SHA_A, SHA_B]);
    now += 6 * 60 * 60_000 + 1;
    await missing.service.resolve("/repo", request);
    expect(missing.calls).toEqual([SHA_A, SHA_B, SHA_A, SHA_B]);
  });

  it("stays pending when the failure is transient", async () => {
    const flaky = setup({
      lookup: async () => {
        throw new Error("timeout");
      }
    });
    expect(await flaky.service.resolve("/repo", [{ email: "dev@example.com", shas: [SHA_A] }])).toEqual({ avatars: {}, pending: ["dev@example.com"] });
  });

  it("caches a missing author as null and asks again after 7 days", async () => {
    let now = 1_000;
    const file = cacheFile();
    const first = setup({ file, now: () => now, lookup: async () => null });
    expect((await first.service.resolve("/repo", [{ email: "dev@example.com", shas: [SHA_A] }])).avatars["dev@example.com"]).toBeNull();
    await first.service.resolve("/repo", [{ email: "dev@example.com", shas: [SHA_A] }]);
    expect(first.calls).toEqual([SHA_A]);
    now += 8 * 24 * 60 * 60_000;
    await first.service.resolve("/repo", [{ email: "dev@example.com", shas: [SHA_A] }]);
    expect(first.calls).toEqual([SHA_A, SHA_A]);
  });

  it("pauses gh after an auth or rate limit failure", async () => {
    let now = 0;
    let fail = true;
    const { service, calls } = setup({
      now: () => now,
      lookup: async () => {
        if (fail) throw new AvatarAuthError("HTTP 401");
        return AVATAR;
      }
    });
    await service.resolve("/repo", [{ email: "a@example.com", shas: [SHA_A] }]);
    fail = false;
    expect((await service.resolve("/repo", [{ email: "b@example.com", shas: [SHA_B] }])).pending).toEqual(["b@example.com"]);
    expect(calls).toEqual([SHA_A]);
    now += 5 * 60_000 + 1;
    expect((await service.resolve("/repo", [{ email: "b@example.com", shas: [SHA_B] }])).pending).toEqual([]);
  });

  it("retries a pending author on the server and announces the result", async () => {
    let fail = true;
    const { service } = setup({
      lookup: async () => {
        if (fail) throw new Error("timeout");
        return AVATAR;
      }
    });
    let announced = 0;
    service.onResolved(() => (announced += 1));
    expect((await service.resolve("/repo", [{ email: "dev@example.com", shas: [SHA_A] }])).pending).toEqual(["dev@example.com"]);
    fail = false;
    await (service as unknown as { runRetries(): Promise<void> }).runRetries();
    expect(announced).toBe(1);
    expect((await service.resolve("/repo", [{ email: "dev@example.com", shas: [SHA_A] }])).avatars["dev@example.com"]).not.toBeNull();
    service.dispose();
  });

  it("gives up retrying after five attempts", async () => {
    const { service, calls } = setup({
      lookup: async () => {
        throw new Error("timeout");
      }
    });
    await service.resolve("/repo", [{ email: "dev@example.com", shas: [SHA_A] }]);
    const run = (service as unknown as { runRetries(): Promise<void> }).runRetries.bind(service);
    for (let attempt = 0; attempt < 7; attempt += 1) await run();
    expect(calls).toHaveLength(6);
    service.dispose();
  });

  it("writes pending cache changes synchronously on dispose", async () => {
    const file = cacheFile();
    const { service } = setup({ file });
    await service.resolve("/repo", [{ email: "dev@example.com", shas: [SHA_A] }]);
    service.dispose();
    expect(JSON.parse(readFileSync(file, "utf8"))["dev@example.com"].url).toBe("https://avatars.githubusercontent.com/u/42?v=4&s=64");
  });

  it("shares one lookup between concurrent requests for the same email", async () => {
    let release: (value: string) => void = () => {};
    const { service, calls } = setup({ lookup: () => new Promise<string>((resolve) => (release = resolve)) });
    const first = service.resolve("/repo", [{ email: "dev@example.com", shas: [SHA_A] }]);
    const second = service.resolve("/repo", [{ email: "dev@example.com", shas: [SHA_A] }]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    release(AVATAR);
    await Promise.all([first, second]);
    expect(calls).toEqual([SHA_A]);
  });

  it("ignores a broken cache file and drops cached urls from other hosts", async () => {
    const broken = cacheFile();
    writeFileSync(broken, "{\"dev@example.com\":");
    const first = setup({ file: broken });
    await first.service.resolve("/repo", [{ email: "dev@example.com", shas: [SHA_A] }]);
    expect(first.calls).toEqual([SHA_A]);
    const foreign = cacheFile();
    writeFileSync(foreign, String.fromCharCode(0xfeff) + JSON.stringify({ "dev@example.com": { url: "https://evil.example.com/a.png", checkedAt: Date.now() } }));
    const second = setup({ file: foreign });
    await second.service.resolve("/repo", [{ email: "dev@example.com", shas: [SHA_A] }]);
    expect(second.calls).toEqual([SHA_A]);
  });
});
