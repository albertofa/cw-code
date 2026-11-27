import { describe, expect, test } from "bun:test";
import { createRefCounter } from "./refCounter.js";

describe("createRefCounter", () => {
  test("reports only the first acquire and the last release of a key", () => {
    const counter = createRefCounter<string>();
    expect(counter.acquire("a", "A")).toBe(true);
    expect(counter.acquire("a", "A2")).toBe(false);
    expect(counter.release("a")).toBe(false);
    expect(counter.values()).toEqual(["A"]);
    expect(counter.release("a")).toBe(true);
    expect(counter.size).toBe(0);
  });

  test("ignores a release of a key that is not held", () => {
    const counter = createRefCounter<string>();
    expect(counter.release("missing")).toBe(false);
    counter.acquire("a", "A");
    counter.release("a");
    expect(counter.release("a")).toBe(false);
  });

  test("lists every held value once", () => {
    const counter = createRefCounter<number>();
    counter.acquire("a", 1);
    counter.acquire("b", 2);
    counter.acquire("a", 1);
    expect(counter.values()).toEqual([1, 2]);
    expect(counter.size).toBe(2);
  });
});
