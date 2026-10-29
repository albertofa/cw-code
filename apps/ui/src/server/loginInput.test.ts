import { describe, expect, it } from "bun:test";
import { readLoginInput } from "./loginInput.js";

const PAGE = "https://box.example/cw/";

describe("readLoginInput", () => {
  it("accepts a raw token", () => {
    expect(readLoginInput("  abc123  ", PAGE)).toEqual({ kind: "token", token: "abc123" });
  });

  it("rejects empty input and tokens with spaces", () => {
    expect(readLoginInput("   ", PAGE).kind).toBe("error");
    expect(readLoginInput("abc 123", PAGE).kind).toBe("error");
  });

  it("uses the token of a pairing link for this page", () => {
    expect(readLoginInput("https://box.example/cw/#token=abc", PAGE)).toEqual({ kind: "token", token: "abc" });
    expect(readLoginInput("https://box.example/cw/index.html#token=abc", PAGE)).toEqual({ kind: "token", token: "abc" });
    expect(readLoginInput("https://box.example/cw/#token=abc", "https://box.example/cw/index.html")).toEqual({ kind: "token", token: "abc" });
    expect(readLoginInput("wss://box.example/cw/ws#token=abc", PAGE)).toEqual({ kind: "token", token: "abc" });
  });

  it("navigates to the pairing link of another server", () => {
    expect(readLoginInput("https://other.example/#token=abc", PAGE)).toEqual({ kind: "navigate", href: "https://other.example/#token=abc" });
    expect(readLoginInput("wss://other.example/ws#token=abc", PAGE)).toEqual({ kind: "navigate", href: "https://other.example/#token=abc" });
    expect(readLoginInput("https://box.example/#token=abc", PAGE)).toEqual({ kind: "navigate", href: "https://box.example/#token=abc" });
  });

  it("rejects invalid links and links without a token", () => {
    expect(readLoginInput("ftp://box.example/#token=abc", PAGE).kind).toBe("error");
    expect(readLoginInput("https://box.example/cw/", PAGE).kind).toBe("error");
  });
});
