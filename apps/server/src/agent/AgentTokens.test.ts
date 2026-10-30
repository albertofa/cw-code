import { describe, expect, test } from "bun:test";
import { AgentTokens } from "./AgentTokens.js";

describe("AgentTokens", () => {
  test("mints a base64url token of 32 random bytes", () => {
    const token = new AgentTokens().tokenFor("s1");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("reuses the token for the same session and mints distinct ones per session", () => {
    const tokens = new AgentTokens();
    const first = tokens.tokenFor("s1");
    expect(tokens.tokenFor("s1")).toBe(first);
    expect(tokens.tokenFor("s2")).not.toBe(first);
  });

  test("verifies a minted token to its session", () => {
    const tokens = new AgentTokens();
    const first = tokens.tokenFor("s1");
    const second = tokens.tokenFor("s2");
    expect(tokens.verify(first)).toEqual({ sessionId: "s1" });
    expect(tokens.verify(second)).toEqual({ sessionId: "s2" });
  });

  test("rejects unknown and tampered tokens", () => {
    const tokens = new AgentTokens();
    const token = tokens.tokenFor("s1");
    expect(tokens.verify("nope")).toBeNull();
    expect(tokens.verify("")).toBeNull();
    expect(tokens.verify(`${token}x`)).toBeNull();
  });

  test("revoke invalidates the token and a later tokenFor mints a new one", () => {
    const tokens = new AgentTokens();
    const token = tokens.tokenFor("s1");
    tokens.revoke("s1");
    expect(tokens.verify(token)).toBeNull();
    const next = tokens.tokenFor("s1");
    expect(next).not.toBe(token);
    expect(tokens.verify(next)).toEqual({ sessionId: "s1" });
  });

  test("revoking an unknown session is a no-op", () => {
    const tokens = new AgentTokens();
    const token = tokens.tokenFor("s1");
    tokens.revoke("other");
    expect(tokens.verify(token)).toEqual({ sessionId: "s1" });
  });
});
