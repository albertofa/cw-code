import { describe, expect, it } from "bun:test";
import { computeGraphLayout, type LayoutCommit } from "./graphLayout.js";

const c = (sha: string, ...parents: string[]): LayoutCommit => ({ sha, parents });

function dedupeByLane(segments: { lane: number; color: number }[]): string[] {
  const unique = new Map<number, number>();
  for (const s of segments) unique.set(s.lane, s.color);
  return [...unique.entries()].sort((a, b) => a[0] - b[0]).map(([lane, color]) => `${lane}:${color}`);
}

function assertInvariant(commits: LayoutCommit[]) {
  const { rows } = computeGraphLayout(commits, 8);
  for (let i = 0; i < rows.length; i++) {
    const { up, down } = rows[i];
    for (const segment of up) {
      if (segment.from !== segment.to) continue;
      const continues = down.some((d) => d.to === segment.from);
      if (continues) expect(down, `row ${i} lane ${segment.from}`).toContainEqual(segment);
    }
  }
  for (let i = 0; i < rows.length - 1; i++) {
    const down = dedupeByLane(rows[i].down.map((s) => ({ lane: s.to, color: s.color })));
    const up = dedupeByLane(rows[i + 1].up.map((s) => ({ lane: s.from, color: s.color })));
    expect(down, `row ${i}`).toEqual(up);
  }
}

function mainCycles(cycles: number): LayoutCommit[] {
  const created: LayoutCommit[] = [c("m0")];
  let main = "m0";
  for (let i = 1; i <= cycles; i++) {
    created.push(c(`f${i}a`, main), c(`f${i}b`, `f${i}a`), c(`m${i}`, main, `f${i}b`));
    main = `m${i}`;
  }
  return created.reverse();
}

function syntheticHistory(size: number): LayoutCommit[] {
  let seed = 42;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const tips: string[] = ["c0"];
  const created: LayoutCommit[] = [];
  for (let i = 1; i <= size; i++) {
    const tipIndex = Math.floor(rand() * tips.length);
    const commit = c(`c${i}`, tips[tipIndex]);
    created.push(commit);
    tips[tipIndex] = commit.sha;
    const roll = rand();
    if (roll < 0.08 && tips.length < 12) {
      tips.push(commit.sha);
    } else if (roll < 0.16 && tips.length > 1) {
      const other = Math.floor(rand() * tips.length);
      if (other !== tipIndex) {
        commit.parents.push(tips[other]);
        tips.splice(other, 1);
      }
    }
  }
  return [...created.reverse(), c("c0")];
}

describe("computeGraphLayout", () => {
  it("keeps a linear history on lane 0", () => {
    const commits = [c("d", "c"), c("c", "b"), c("b", "a"), c("a")];
    const { rows, laneCount } = computeGraphLayout(commits, 8);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0, 0]);
    expect(new Set(rows.map((r) => r.color)).size).toBe(1);
    expect(laneCount).toBe(1);
    expect(rows[0].up).toEqual([]);
    expect(rows[0].down).toEqual([{ from: 0, to: 0, color: 0 }]);
    expect(rows[1].up).toEqual([{ from: 0, to: 0, color: 0 }]);
    expect(rows[3].down).toEqual([]);
    assertInvariant(commits);
  });

  it("handles a branch and a merge keeping the first parent on the node lane", () => {
    const commits = [c("m", "a2", "b1"), c("b1", "a1"), c("a2", "a1"), c("a1", "root"), c("root")];
    const { rows, laneCount } = computeGraphLayout(commits, 8);
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0, 0, 0]);
    expect(rows[2].color).toBe(0);
    expect(rows[3].color).toBe(0);
    expect(laneCount).toBe(2);
    expect(rows[0].down).toEqual([
      { from: 0, to: 0, color: 0 },
      { from: 0, to: 1, color: 1 },
    ]);
    expect(rows[1].down).toEqual([
      { from: 0, to: 0, color: 0 },
      { from: 1, to: 1, color: 1 },
    ]);
    expect(rows[2].down).toEqual([
      { from: 0, to: 0, color: 0 },
      { from: 1, to: 1, color: 1 },
    ]);
    expect(rows[3].up).toEqual([
      { from: 0, to: 0, color: 0 },
      { from: 1, to: 0, color: 1 },
    ]);
    expect(rows[3].down).toEqual([{ from: 0, to: 0, color: 0 }]);
    assertInvariant(commits);
  });

  it("spreads an octopus merge over three lanes", () => {
    const commits = [c("m", "p1", "p2", "p3"), c("p1", "r"), c("p2", "r"), c("p3", "r"), c("r")];
    const { rows, laneCount } = computeGraphLayout(commits, 8);
    expect(rows[0].down).toEqual([
      { from: 0, to: 0, color: 0 },
      { from: 0, to: 1, color: 1 },
      { from: 0, to: 2, color: 2 },
    ]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 1, 2, 0]);
    expect(rows[4].up.map((s) => [s.from, s.to])).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
    ]);
    expect(laneCount).toBe(3);
    assertInvariant(commits);
  });

  it("draws a diagonal over an active lane", () => {
    const commits = [c("M", "a", "c"), c("a", "a1", "d"), c("c", "z"), c("a1", "z"), c("d", "z"), c("z")];
    const { rows } = computeGraphLayout(commits, 8);
    expect(rows[1].lane).toBe(0);
    expect(rows[1].down).toEqual([
      { from: 0, to: 0, color: 0 },
      { from: 1, to: 1, color: 1 },
      { from: 0, to: 2, color: 2 },
    ]);
    assertInvariant(commits);
  });

  it("converges three lanes into one node", () => {
    const commits = [c("A", "p"), c("B", "q"), c("C", "p"), c("q", "p"), c("p")];
    const { rows } = computeGraphLayout(commits, 8);
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 2, 1, 0]);
    expect(rows[3].down).toEqual([
      { from: 0, to: 0, color: 0 },
      { from: 2, to: 2, color: 2 },
      { from: 1, to: 1, color: 1 },
    ].sort((a, b) => a.to - b.to));
    expect(rows[4].up.map((s) => [s.from, s.to])).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
    ]);
    assertInvariant(commits);
  });

  it("converges two children of the same parent at the parent row", () => {
    const commits = [c("f1", "p"), c("f2", "p"), c("p", "r"), c("r")];
    const { rows, laneCount } = computeGraphLayout(commits, 8);
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0, 0]);
    expect(laneCount).toBe(2);
    expect(rows[1].down).toEqual([
      { from: 0, to: 0, color: 0 },
      { from: 1, to: 1, color: 1 },
    ]);
    expect(rows[2].up).toEqual([
      { from: 0, to: 0, color: 0 },
      { from: 1, to: 0, color: 1 },
    ]);
    expect(rows[2].down).toEqual([{ from: 0, to: 0, color: 0 }]);
    assertInvariant(commits);
  });

  it("keeps the lane open when the parent is outside the list", () => {
    const commits = [c("b", "a"), c("a", "missing")];
    const { rows } = computeGraphLayout(commits, 8);
    expect(rows[1].lane).toBe(0);
    expect(rows[1].down).toEqual([{ from: 0, to: 0, color: 0 }]);
  });

  it("puts WIP on top and links it to HEAD", () => {
    const commits = [c("WIP", "head"), c("other", "base"), c("head", "base"), c("base")];
    const { rows } = computeGraphLayout(commits, 8);
    expect(rows[0].lane).toBe(0);
    expect(rows[0].up).toEqual([]);
    expect(rows[0].down).toEqual([{ from: 0, to: 0, color: 0 }]);
    expect(rows[2].lane).toBe(0);
    assertInvariant(commits);
  });

  it("reuses freed lanes without compacting", () => {
    const commits = [c("m", "a", "b"), c("b", "a"), c("a", "z"), c("n", "k"), c("z"), c("k")];
    const { rows, laneCount } = computeGraphLayout(commits, 8);
    expect(rows[3].lane).toBe(1);
    expect(laneCount).toBe(2);
    assertInvariant(commits);
  });

  it("keeps the main first-parent chain on lane 0 with a stable color", () => {
    const commits = mainCycles(30);
    const { rows } = computeGraphLayout(commits, 8);
    const mainRows = rows.filter((_, i) => /^m\d+$/.test(commits[i].sha));
    expect(mainRows).toHaveLength(31);
    expect(new Set(mainRows.map((r) => r.lane))).toEqual(new Set([0]));
    expect(new Set(mainRows.map((r) => r.color)).size).toBe(1);
    assertInvariant(commits);
  });

  it("wraps colors around the palette size", () => {
    const { rows } = computeGraphLayout([c("a"), c("b"), c("c"), c("d")], 2);
    expect(rows.map((r) => r.color)).toEqual([0, 1, 0, 1]);
  });

  it("returns an empty layout for no commits", () => {
    expect(computeGraphLayout([], 8)).toEqual({ rows: [], laneCount: 0 });
  });

  it("satisfies the invariants on a synthetic history", () => {
    assertInvariant(syntheticHistory(500));
  });

  it("lays out 10k commits in under 1 s", () => {
    const commits = syntheticHistory(10000);
    const start = performance.now();
    const { rows } = computeGraphLayout(commits, 8);
    const elapsed = performance.now() - start;
    expect(rows).toHaveLength(10001);
    expect(elapsed).toBeLessThan(1000);
  });
});
