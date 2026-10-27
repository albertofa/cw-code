export type LineChangeKind = "added" | "modified" | "deleted";

export interface LineChange {
  kind: LineChangeKind;
  from: number;
  to: number;
}

const MAX_EDIT_DISTANCE = 2000;
const EQUAL = 0;
const INSERT = 1;
const DELETE = 2;

export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

function internLines(a: readonly string[], b: readonly string[]): [Int32Array, Int32Array] {
  const ids = new Map<string, number>();
  const intern = (lines: readonly string[]) =>
    Int32Array.from(lines, (line) => {
      let id = ids.get(line);
      if (id === undefined) {
        id = ids.size;
        ids.set(line, id);
      }
      return id;
    });
  return [intern(a), intern(b)];
}

function myers(a: Int32Array, b: Int32Array): number[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  const limit = Math.min(max, MAX_EDIT_DISTANCE);
  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], n: number, m: number): number[] {
  const ops: number[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const snapshot = trace[d];
    const at = (k: number) => snapshot[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push(EQUAL);
      x--;
      y--;
    }
    if (d > 0) ops.push(x === prevX ? INSERT : DELETE);
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

function changeFor(lineBefore: number, inserted: number, deleted: number): LineChange {
  if (inserted === 0) return { kind: "deleted", from: lineBefore, to: lineBefore };
  return { kind: deleted > 0 ? "modified" : "added", from: lineBefore + 1, to: lineBefore + inserted };
}

export function diffLines(base: readonly string[], current: readonly string[]): LineChange[] {
  let start = 0;
  while (start < base.length && start < current.length && base[start] === current[start]) start++;
  let endBase = base.length;
  let endCurrent = current.length;
  while (endBase > start && endCurrent > start && base[endBase - 1] === current[endCurrent - 1]) {
    endBase--;
    endCurrent--;
  }
  const deletedCount = endBase - start;
  const insertedCount = endCurrent - start;
  if (deletedCount === 0 && insertedCount === 0) return [];
  if (deletedCount === 0 || insertedCount === 0) return [changeFor(start, insertedCount, deletedCount)];
  const [a, b] = internLines(base.slice(start, endBase), current.slice(start, endCurrent));
  const ops = myers(a, b);
  if (!ops) return [changeFor(start, insertedCount, deletedCount)];
  const changes: LineChange[] = [];
  let line = start;
  let inserted = 0;
  let deleted = 0;
  let runStart = start;
  const flush = () => {
    if (inserted > 0 || deleted > 0) changes.push(changeFor(runStart, inserted, deleted));
    inserted = 0;
    deleted = 0;
  };
  for (const op of ops) {
    if (op === EQUAL) {
      flush();
      line++;
      runStart = line;
    } else if (op === INSERT) {
      inserted++;
      line++;
    } else {
      deleted++;
    }
  }
  flush();
  return changes;
}
