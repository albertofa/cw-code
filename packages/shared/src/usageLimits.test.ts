import { describe, expect, it } from "bun:test";
import { isLimitedModel, limitWindowFamily } from "./usageLimits.js";

describe("usage limit windows", () => {
  it("maps the model windows to their family and leaves account windows alone", () => {
    expect(limitWindowFamily("seven_day_overage_included")).toEqual({ family: "fable", label: "Fable" });
    expect(limitWindowFamily("seven_day_opus")?.family).toBe("opus");
    expect(limitWindowFamily("five_hour")).toBeNull();
    expect(limitWindowFamily(undefined)).toBeNull();
  });

  it("treats the recorded model and every model of the limited family as limited", () => {
    expect(isLimitedModel("fable", { window: "seven_day_overage_included" })).toBe(true);
    expect(isLimitedModel("claude-opus-5-5", { window: "seven_day_opus" })).toBe(true);
    expect(isLimitedModel("claude-sonnet-5-5", { window: "seven_day_overage_included" })).toBe(false);
    expect(isLimitedModel("Custom-Model", { model: "custom-model" })).toBe(true);
    expect(isLimitedModel("claude-sonnet-5-5", { model: "fable" })).toBe(false);
    expect(isLimitedModel("", { model: "fable" })).toBe(false);
  });
});
