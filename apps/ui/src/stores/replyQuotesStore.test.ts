import { describe, expect, it } from "bun:test";
import { MAX_DRAFT_QUOTES, MAX_QUOTE_LENGTH } from "@cw-code/shared/draftQuotes";
import { fitQuote, selectReplyQuotes, useReplyQuotesStore } from "./replyQuotesStore.js";

const texts = (sessionId: string) => selectReplyQuotes(useReplyQuotesStore.getState(), sessionId).map((quote) => quote.text);

describe("replyQuotesStore", () => {
  it("truncates an excerpt past the draft limit instead of keeping it whole", () => {
    expect(fitQuote("short")).toBe("short");
    const long = fitQuote("x".repeat(MAX_QUOTE_LENGTH + 500));
    expect(long.length).toBe(MAX_QUOTE_LENGTH);
    expect(long.endsWith("…")).toBe(true);
  });

  it("refuses quotes past the draft limit and ignores duplicates", () => {
    const store = useReplyQuotesStore.getState();
    for (let i = 0; i < MAX_DRAFT_QUOTES; i++) expect(store.add("cap", `q${i}`)).toBe(true);
    expect(store.add("cap", "q0")).toBe(true);
    expect(store.add("cap", "one more")).toBe(false);
    expect(texts("cap")).toHaveLength(MAX_DRAFT_QUOTES);
  });

  it("restores saved quotes within the limits", () => {
    useReplyQuotesStore.getState().replace("restore", [...Array.from({ length: MAX_DRAFT_QUOTES + 3 }, (_, i) => `r${i}`), "", "r0"]);
    expect(texts("restore")).toEqual(Array.from({ length: MAX_DRAFT_QUOTES }, (_, i) => `r${i}`));
  });
});
