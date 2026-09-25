import { describe, expect, it } from "vitest";
import { describeUpdateError, formatLogValue, redactUpdateText } from "./updateLog.js";

const HOME = "C:\\Users\\Jane Doe";

describe("redactUpdateText", () => {
  it("strips query strings, fragments, and URL credentials", () => {
    const text = "GET https://user:pa55@objects.githubusercontent.com/x/cw-code-Setup-1.0.0-x64.exe?X-Amz-Signature=abc&token=zzz#frag done";
    expect(redactUpdateText(text, HOME)).toBe("GET https://objects.githubusercontent.com/x/cw-code-Setup-1.0.0-x64.exe done");
  });

  it("masks GitHub tokens and authorization values", () => {
    const text = "Authorization: Bearer abcdefghijklmnop token=ghs_0123456789abcdefghijklmn github_pat_11AAAAAAA0123456789_abcdefghij";
    const redacted = redactUpdateText(text, HOME);
    expect(redacted).not.toMatch(/abcdefghijklmnop|ghs_0123|github_pat_11/);
    expect(redacted).toContain("<redacted");
  });

  it("does not mangle ordinary words", () => {
    expect(redactUpdateText("cancellation token was cancelled", HOME)).toBe("cancellation token was cancelled");
  });

  it("replaces the home directory with either slash style and other user profiles", () => {
    const text = `C:\\Users\\Jane Doe\\AppData\\Local\\cw-code-updater and c:/users/jane doe/x and C:\\Users\\bob\\y`;
    expect(redactUpdateText(text, HOME)).toBe("~\\AppData\\Local\\cw-code-updater and ~/x and C:\\Users\\<user>\\y");
  });

  it("caps runaway messages such as dumped release feeds", () => {
    const redacted = redactUpdateText(`<feed>${"x".repeat(10_000)}</feed>`, HOME);
    expect(redacted.length).toBeLessThanOrEqual(2_001);
  });
});

describe("formatLogValue", () => {
  it("stringifies common logger inputs", () => {
    expect(formatLogValue("plain")).toBe("plain");
    expect(formatLogValue(undefined)).toBe("");
    expect(formatLogValue({ a: 1 })).toBe('{"a":1}');
    expect(formatLogValue(new Error("boom"))).toContain("boom");
  });
});

describe("describeUpdateError", () => {
  it("uses the first line, redacted, and marks unknown errors retryable", () => {
    const error = new Error(`Cannot find latest.yml at https://github.com/a/b?token=secret in ${HOME}\\x\nstack line`);
    expect(describeUpdateError(error, HOME)).toEqual({
      message: "Cannot find latest.yml at https://github.com/a/b in ~\\x",
      retryable: true
    });
  });

  it("explains offline errors in user terms", () => {
    const failure = describeUpdateError(new Error("net::ERR_INTERNET_DISCONNECTED"), HOME);
    expect(failure.message).toContain("Could not reach the update server");
    expect(failure.retryable).toBe(true);
  });

  it("marks signature and configuration errors as not retryable", () => {
    const signature = Object.assign(new Error("not signed by the application owner"), { code: "ERR_UPDATER_INVALID_SIGNATURE" });
    expect(describeUpdateError(signature, HOME).retryable).toBe(false);
    const checksum = Object.assign(new Error("sha512 checksum mismatch"), { code: "ERR_CHECKSUM_MISMATCH" });
    expect(describeUpdateError(checksum, HOME).retryable).toBe(true);
  });

  it("handles non-Error throwables", () => {
    expect(describeUpdateError("plain failure", HOME).message).toBe("plain failure");
    expect(describeUpdateError(null, HOME).message).toBe("Unknown updater error");
  });
});
