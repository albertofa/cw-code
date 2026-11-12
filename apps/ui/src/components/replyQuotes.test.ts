import { describe, expect, it } from "bun:test";
import { cleanQuote, formatQuotedReply, splitQuotedReply } from "./replyQuotes.js";

describe("formatQuotedReply", () => {
  it("returns the body untouched without quotes", () => {
    expect(formatQuotedReply([], "hello")).toBe("hello");
    expect(formatQuotedReply(["  \n "], "hello")).toBe("hello");
  });

  it("writes each quote as a blockquote before the body", () => {
    expect(formatQuotedReply(["first", "second line\n\nafter gap"], "why?")).toBe("> first\n\n> second line\n>\n> after gap\n\nwhy?");
  });

  it("sends quotes alone when the body is empty", () => {
    expect(formatQuotedReply(["only"], "")).toBe("> only");
  });
});

describe("splitQuotedReply", () => {
  it("round-trips formatted replies", () => {
    const quotes = ["first", "second line\n\nafter gap"];
    expect(splitQuotedReply(formatQuotedReply(quotes, "why?\n> not a leading quote"))).toEqual({ quotes, body: "why?\n> not a leading quote" });
    expect(splitQuotedReply(formatQuotedReply(["only"], ""))).toEqual({ quotes: ["only"], body: "" });
  });

  it("leaves prompts without leading quotes alone", () => {
    expect(splitQuotedReply("plain\n> later")).toEqual({ quotes: [], body: "plain\n> later" });
  });
});

describe("cleanQuote", () => {
  it("trims and collapses blank runs", () => {
    expect(cleanQuote("  a  \r\n\r\n\r\n\r\nb \n")).toBe("a\n\nb");
  });
});
