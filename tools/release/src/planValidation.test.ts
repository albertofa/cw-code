import { describe, expect, it } from "vitest";
import { type ReleasePlan, validatePlanShape } from "./planValidation.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function validAlphaPlan(overrides: Partial<ReleasePlan> = {}): ReleasePlan {
  return {
    schema: 1,
    channel: "alpha",
    version: "0.0.1-alpha.22",
    tag: "v0.0.1-alpha.22",
    sourceSha: SHA_A,
    previousTag: "v0.0.1-alpha.21",
    prerelease: true,
    makeLatest: false,
    notes: "## Features\n\n- feat: x",
    createdAt: "2026-09-25T06:00:00.000Z",
    ...overrides
  };
}

function validStablePlan(overrides: Partial<ReleasePlan> = {}): ReleasePlan {
  return {
    schema: 1,
    channel: "stable",
    version: "0.0.1",
    tag: "v0.0.1",
    sourceSha: SHA_B,
    candidate: { tag: "v0.0.1-alpha.21", sha: SHA_B },
    previousTag: null,
    prerelease: false,
    makeLatest: true,
    notes: "## Features\n\n- feat: x",
    createdAt: "2026-09-25T06:00:00.000Z",
    ...overrides
  };
}

describe("validatePlanShape", () => {
  it("accepts a well-formed alpha plan", () => {
    expect(validatePlanShape(validAlphaPlan())).toEqual({ ok: true, plan: validAlphaPlan() });
  });

  it("accepts a well-formed stable plan", () => {
    expect(validatePlanShape(validStablePlan())).toEqual({ ok: true, plan: validStablePlan() });
  });

  it("rejects non-object input", () => {
    expect(validatePlanShape(null).ok).toBe(false);
    expect(validatePlanShape("not a plan").ok).toBe(false);
    expect(validatePlanShape(42).ok).toBe(false);
  });

  it("rejects the wrong schema", () => {
    const result = validatePlanShape(validAlphaPlan({ schema: 2 as unknown as 1 }));
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown channel", () => {
    const result = validatePlanShape({ ...validAlphaPlan(), channel: "beta" });
    expect(result.ok).toBe(false);
  });

  it("rejects a tag that does not equal v + version", () => {
    const result = validatePlanShape(validAlphaPlan({ tag: "v0.0.1-alpha.99" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/tag/);
  });

  it("rejects a channel that does not match the version shape", () => {
    const result = validatePlanShape(validAlphaPlan({ channel: "stable" }));
    expect(result.ok).toBe(false);
  });

  it("rejects a sourceSha that is not a full 40-hex SHA", () => {
    const result = validatePlanShape(validAlphaPlan({ sourceSha: "abc123" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/sourceSha/);
  });

  it("rejects an alpha plan with prerelease false", () => {
    expect(validatePlanShape(validAlphaPlan({ prerelease: false })).ok).toBe(false);
  });

  it("rejects an alpha plan with makeLatest true", () => {
    expect(validatePlanShape(validAlphaPlan({ makeLatest: true })).ok).toBe(false);
  });

  it("rejects an alpha plan that carries a candidate", () => {
    const result = validatePlanShape(validAlphaPlan({ candidate: { tag: "v0.0.1-alpha.21", sha: SHA_A } }));
    expect(result.ok).toBe(false);
  });

  it("rejects a stable plan with prerelease true", () => {
    expect(validatePlanShape(validStablePlan({ prerelease: true })).ok).toBe(false);
  });

  it("rejects a stable plan with makeLatest false", () => {
    expect(validatePlanShape(validStablePlan({ makeLatest: false })).ok).toBe(false);
  });

  it("rejects a stable plan missing a candidate", () => {
    const { candidate: _candidate, ...withoutCandidate } = validStablePlan();
    expect(validatePlanShape(withoutCandidate).ok).toBe(false);
  });

  it("rejects a stable plan whose candidate base does not match the version base", () => {
    const result = validatePlanShape(validStablePlan({ candidate: { tag: "v0.0.2-alpha.0", sha: SHA_B } }));
    expect(result.ok).toBe(false);
  });

  it("rejects a stable plan whose candidate tag is not an alpha tag", () => {
    const result = validatePlanShape(validStablePlan({ candidate: { tag: "v0.0.1", sha: SHA_B } }));
    expect(result.ok).toBe(false);
  });

  it("rejects a stable plan whose candidate SHA is not a full 40-hex SHA", () => {
    const result = validatePlanShape(validStablePlan({ candidate: { tag: "v0.0.1-alpha.21", sha: "short" } }));
    expect(result.ok).toBe(false);
  });
});
