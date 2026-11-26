import { describe, expect, it } from "bun:test";
import { dayBucket, dayLabels } from "./daySeparators.js";

const at = (year: number, month: number, day: number, hour = 12, minute = 0): number => new Date(year, month - 1, day, hour, minute).getTime();

describe("dayBucket", () => {
  const wednesday = at(2026, 11, 25, 15);

  it("splits today and yesterday at local midnight", () => {
    expect(dayBucket(wednesday, at(2026, 11, 25, 0, 0)).label).toBe("Today");
    expect(dayBucket(wednesday, at(2026, 11, 24, 23, 59)).label).toBe("Yesterday");
    expect(dayBucket(wednesday, at(2026, 11, 24, 0, 0)).label).toBe("Yesterday");
  });

  it("treats future timestamps as today", () => {
    expect(dayBucket(wednesday, at(2026, 11, 26)).label).toBe("Today");
  });

  it("starts the week on Monday", () => {
    expect(dayBucket(wednesday, at(2026, 11, 23, 0, 0)).label).toBe("Earlier this week");
    expect(dayBucket(wednesday, at(2026, 11, 22, 23, 59)).label).toBe("Last week");
    expect(dayBucket(wednesday, at(2026, 11, 16, 0, 0)).label).toBe("Last week");
    expect(dayBucket(wednesday, at(2026, 11, 15, 23, 59)).label).toBe("Earlier this month");
  });

  it("uses yesterday, not last week, on a Monday", () => {
    const monday = at(2026, 11, 23, 9);
    expect(dayBucket(monday, at(2026, 11, 22)).label).toBe("Yesterday");
    expect(dayBucket(monday, at(2026, 11, 21)).label).toBe("Last week");
  });

  it("names older months with their year", () => {
    expect(dayBucket(wednesday, at(2026, 11, 1, 0, 0)).label).toBe("Earlier this month");
    expect(dayBucket(wednesday, at(2026, 10, 31, 23, 59)).label).toBe("October 2026");
    expect(dayBucket(wednesday, at(2025, 12, 3)).label).toBe("December 2025");
  });

  it("prefers last week over the month name across a month boundary", () => {
    const tuesday = at(2026, 12, 1, 10);
    expect(dayBucket(tuesday, at(2026, 11, 24)).label).toBe("Last week");
    expect(dayBucket(tuesday, at(2026, 11, 20)).label).toBe("November 2026");
  });
});

describe("dayLabels", () => {
  const now = at(2026, 11, 25, 15);

  it("keeps null entries unlabelled", () => {
    expect(dayLabels(now, [null, at(2026, 11, 25)])).toEqual([null, "Today"]);
  });

  it("never returns to a newer bucket once an older one is reached", () => {
    expect(dayLabels(now, [at(2026, 11, 25), at(2026, 11, 24), at(2026, 11, 25), at(2026, 10, 2)])).toEqual([
      "Today",
      "Yesterday",
      "Yesterday",
      "October 2026"
    ]);
  });
});
