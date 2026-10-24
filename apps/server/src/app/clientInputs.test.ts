import { describe, expect, test } from "bun:test";
import type { RunRef } from "@cw-code/contracts";
import { ClientInputs } from "./clientInputs.js";

const run = (runId: number, owner = "o"): RunRef => ({ host: "github.com", owner, repo: "r", runId });
const ids = (refs: RunRef[]): number[] => refs.map((ref) => ref.runId);

describe("ClientInputs run refs", () => {
  test("round-robins across clients so every client's first refs get in", () => {
    const inputs = new ClientInputs();
    inputs.setRunRefs("a", [run(1), run(2), run(3)]);
    inputs.setRunRefs("b", [run(4), run(5)]);
    expect(ids(inputs.runRefsUnion(["a", "b"], 3))).toEqual([1, 4, 2]);
  });

  test("dedupes by run key ignoring case", () => {
    const inputs = new ClientInputs();
    inputs.setRunRefs("a", [run(1, "Acme"), run(2)]);
    inputs.setRunRefs("b", [run(1, "acme"), run(3)]);
    expect(ids(inputs.runRefsUnion(["a", "b"], 10))).toEqual([1, 2, 3]);
  });

  test("ignores clients outside the requested list and cleared clients", () => {
    const inputs = new ClientInputs();
    inputs.setRunRefs("a", [run(1)]);
    inputs.setRunRefs("b", [run(2)]);
    expect(ids(inputs.runRefsUnion(["b"], 10))).toEqual([2]);
    inputs.clearRunRefs("b");
    expect(ids(inputs.runRefsUnion(["a", "b"], 10))).toEqual([1]);
  });

  test("returns nothing for no clients", () => {
    expect(new ClientInputs().runRefsUnion([], 5)).toEqual([]);
  });
});

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

  test("dropClient forgets runs and paths", () => {
    const inputs = new ClientInputs();
    inputs.setRunRefs("a", [run(1)]);
    inputs.setPaths("a", "s1", ["a.ts"]);
    inputs.dropClient("a");
    expect(inputs.runRefsUnion(["a"], 5)).toEqual([]);
    expect(inputs.pathsUnion("s1", ["a"])).toEqual([]);
  });
});
