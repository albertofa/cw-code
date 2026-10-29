import { describe, expect, it } from "bun:test";
import { isBotLogin, stripBotSuffix } from "./avatar.js";

describe("bot logins", () => {
  it("only treats a literal [bot] suffix as a bot", () => {
    expect(isBotLogin("renovate[bot]")).toBe(true);
    expect(isBotLogin("ArthurDotSaito")).toBe(false);
    expect(isBotLogin("bob")).toBe(false);
    expect(isBotLogin("robot")).toBe(false);
  });

  it("strips only the [bot] suffix", () => {
    expect(stripBotSuffix("renovate[bot]")).toBe("renovate");
    expect(stripBotSuffix("ArthurDotSaito")).toBe("ArthurDotSaito");
  });
});
