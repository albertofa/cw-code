import { describe, expect, test } from "bun:test";
import { ClientInputs } from "./clientInputs.js";

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
