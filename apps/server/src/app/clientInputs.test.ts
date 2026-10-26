import { describe, expect, test } from "bun:test";
import { ClientInputs, MAX_WATCHED_PRS_PER_CLIENT } from "./clientInputs.js";

describe("ClientInputs paths", () => {
  test("unions deduped sorted paths per session", () => {
    const inputs = new ClientInputs();
    inputs.setPaths("a", "s1", ["b.ts", "a.ts"]);
    inputs.setPaths("b", "s1", ["a.ts", "c.ts"]);
    inputs.setPaths("b", "s2", ["z.ts"]);
    expect(inputs.pathsUnion("s1", ["a", "b"])).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(inputs.pathsUnion("s2", ["a", "b"])).toEqual(["z.ts"]);
  });

  test("clearPaths removes one session for one client", () => {
    const inputs = new ClientInputs();
    inputs.setPaths("a", "s1", ["a.ts"]);
    inputs.clearPaths("a", "s1");
    expect(inputs.pathsUnion("s1", ["a"])).toEqual([]);
  });

  test("dropClient forgets paths", () => {
    const inputs = new ClientInputs();
    inputs.setPaths("a", "s1", ["a.ts"]);
    inputs.dropClient("a");
    expect(inputs.pathsUnion("s1", ["a"])).toEqual([]);
  });
});

describe("ClientInputs watched pull requests", () => {
  const ref = (number: number) => ({ host: "github.com", owner: "o", repo: "r", number });

  test("unions refs across clients until each client unwatches", () => {
    const inputs = new ClientInputs();
    expect(inputs.watchPr("a", ref(1))).toBe(true);
    expect(inputs.watchPr("a", ref(1))).toBe(false);
    inputs.watchPr("b", ref(1));
    inputs.watchPr("b", ref(2));
    expect([...inputs.watchedPrs().values()]).toEqual([ref(1), ref(2)]);
    expect(inputs.unwatchPr("a", ref(1))).toBe(true);
    expect(inputs.unwatchPr("a", ref(1))).toBe(false);
    expect([...inputs.watchedPrs().values()]).toEqual([ref(1), ref(2)]);
  });

  test("dropClient forgets the client's watched pull requests", () => {
    const inputs = new ClientInputs();
    inputs.watchPr("a", ref(1));
    expect(inputs.dropClient("a")).toEqual({ prsChanged: true });
    expect(inputs.dropClient("a")).toEqual({ prsChanged: false });
    expect(inputs.watchedPrs().size).toBe(0);
  });

  test("caps the pull requests one client can watch", () => {
    const inputs = new ClientInputs();
    for (let number = 1; number <= MAX_WATCHED_PRS_PER_CLIENT; number += 1) inputs.watchPr("a", ref(number));
    expect(() => inputs.watchPr("a", ref(MAX_WATCHED_PRS_PER_CLIENT + 1))).toThrow("at most");
    expect(inputs.watchPr("b", ref(MAX_WATCHED_PRS_PER_CLIENT + 1))).toBe(true);
  });
});
