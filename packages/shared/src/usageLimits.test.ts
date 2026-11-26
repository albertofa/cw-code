import { describe, expect, it } from "bun:test";
import { MODEL_LIMIT_WINDOWS, isLimitedModel, limitWindowFamily } from "./usageLimits.js";

describe("usage limit windows", () => {
  it("maps the model windows to their family and leaves account windows alone", () => {
    expect(limitWindowFamily("seven_day_overage_included")).toEqual({ family: "fable", label: "Fable" });
    expect(limitWindowFamily("seven_day_opus")?.family).toBe("opus");
    expect(limitWindowFamily("five_hour")).toBeNull();
    expect(limitWindowFamily(undefined)).toBeNull();
  });

  it("lists every window that has a family, and only those", () => {
    expect([...MODEL_LIMIT_WINDOWS].sort()).toEqual(["seven_day_opus", "seven_day_overage_included", "seven_day_sonnet"]);
    for (const window of MODEL_LIMIT_WINDOWS) expect(limitWindowFamily(window)).not.toBeNull();
  });

  it("treats the recorded model and every model of the limited family as limited", () => {
    expect(isLimitedModel("fable", { window: "seven_day_overage_included" })).toBe(true);
    expect(isLimitedModel("claude-opus-5-5", { window: "seven_day_opus" })).toBe(true);
    expect(isLimitedModel("claude-sonnet-5-5", { window: "seven_day_overage_included" })).toBe(false);
    expect(isLimitedModel("Custom-Model", { model: "custom-model" })).toBe(true);
    expect(isLimitedModel("claude-sonnet-5-5", { model: "fable" })).toBe(false);
    expect(isLimitedModel("", { model: "fable" })).toBe(false);
    expect(isLimitedModel("claude-opus-5-5", { model: "claude-opus-5-5[1m]" })).toBe(true);
    expect(isLimitedModel("claude-opus-5-5[1m]", { model: "claude-opus-5-5" })).toBe(true);
  });
});
