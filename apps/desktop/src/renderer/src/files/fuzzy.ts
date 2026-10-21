export interface FuzzyMatch {
  score: number;
  positions: number[];
}

export interface RankedFile extends FuzzyMatch {
  path: string;
}

const MATCH = 1;
const SEGMENT_START_BONUS = 8;
const SEPARATOR_BONUS = 6;
const CAMEL_BONUS = 6;
const CONSECUTIVE_BONUS = 5;
const BASENAME_BONUS = 3;
const GAP_PENALTY = 1;
const TRAILING_GAP_PENALTY = 0.1;
const LENGTH_PENALTY = 0.05;
const UNREACHABLE = Number.NEGATIVE_INFINITY;

let matchScores = new Float64Array(0);
let bestScores = new Float64Array(0);
let runBonuses = new Float64Array(0);
let consecutiveFlags = new Uint8Array(0);
let bonuses = new Float64Array(0);
let earliest = new Int32Array(0);
let latest = new Int32Array(0);

function ensureCapacity(rows: number, width: number): void {
  const cells = rows * width;
  if (matchScores.length < cells) {
    matchScores = new Float64Array(cells);
    bestScores = new Float64Array(cells);
    runBonuses = new Float64Array(cells);
    consecutiveFlags = new Uint8Array(cells);
  }
  if (bonuses.length < width) bonuses = new Float64Array(width);
  if (earliest.length < rows) {
    earliest = new Int32Array(rows);
    latest = new Int32Array(rows);
  }
}

function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, "").toLowerCase();
}

function foldCase(path: string): string {
  const lower = path.toLowerCase();
  if (lower.length === path.length) return lower;
  let folded = "";
  for (const char of path) {
    const lowerChar = char.toLowerCase();
    folded += lowerChar.length === char.length ? lowerChar : char;
  }
  return folded;
}

function computeWindows(query: string, text: string): boolean {
  const m = query.length;
  ensureCapacity(m, text.length);
  let position = 0;
  for (let i = 0; i < m; i++) {
    const code = query.charCodeAt(i);
    while (position < text.length && text.charCodeAt(position) !== code) position++;
    if (position === text.length) return false;
    earliest[i] = position++;
  }
  position = text.length - 1;
  for (let i = m - 1; i >= 0; i--) {
    const code = query.charCodeAt(i);
    while (text.charCodeAt(position) !== code) position--;
    latest[i] = position--;
  }
  return true;
}

function isLower(code: number): boolean {
  return code >= 97 && code <= 122;
}

function isUpper(code: number): boolean {
  return code >= 65 && code <= 90;
}

function fillBonuses(path: string): void {
  let previous = 47;
  for (let index = 0; index < path.length; index++) {
    const code = path.charCodeAt(index);
    let bonus = 0;
    if (previous === 47) bonus = SEGMENT_START_BONUS;
    else if (previous === 45 || previous === 95 || previous === 46 || previous === 32) bonus = SEPARATOR_BONUS;
    else if (isLower(previous) && isUpper(code)) bonus = CAMEL_BONUS;
    bonuses[index] = bonus;
    previous = code;
  }
}

function scoreCandidate(query: string, path: string, text: string): number {
  const m = query.length;
  const n = path.length;
  fillBonuses(path);
  const basenameStart = path.lastIndexOf("/") + 1;

  for (let i = 0; i < m; i++) {
    const queryCode = query.charCodeAt(i);
    const row = i * n;
    const previousRow = row - n;
    const last = i === m - 1;
    const low = earliest[i];
    const matchEnd = latest[i];
    const end = last ? n - 1 : latest[i + 1] - 1;
    const carryPenalty = last ? TRAILING_GAP_PENALTY : GAP_PENALTY;
    for (let j = low; j <= end; j++) {
      let match = UNREACHABLE;
      let consecutive = 0;
      let runBonus = 0;
      if (j <= matchEnd && text.charCodeAt(j) === queryCode) {
        const base = MATCH + (j >= basenameStart ? BASENAME_BONUS : 0);
        if (i === 0) {
          match = base + bonuses[j];
          runBonus = bonuses[j];
        } else {
          const fresh = bestScores[previousRow + j - 1] + base + bonuses[j];
          const previousRun = runBonuses[previousRow + j - 1];
          const chained = matchScores[previousRow + j - 1] + base + Math.max(previousRun, CONSECUTIVE_BONUS);
          if (chained > fresh) {
            match = chained;
            consecutive = 1;
            runBonus = previousRun;
          } else {
            match = fresh;
            runBonus = bonuses[j];
          }
        }
      }
      matchScores[row + j] = match;
      consecutiveFlags[row + j] = consecutive;
      runBonuses[row + j] = runBonus;
      const carried = j > low ? bestScores[row + j - 1] - carryPenalty : UNREACHABLE;
      bestScores[row + j] = match > carried ? match : carried;
    }
  }
  return bestScores[m * n - 1] - n * LENGTH_PENALTY;
}

function tracePositions(query: string, n: number): number[] {
  const m = query.length;
  const positions = new Array<number>(m);
  let j = n - 1;
  let matchRequired = false;
  for (let i = m - 1; i >= 0; i--) {
    const row = i * n;
    const low = earliest[i];
    const high = Math.min(j, latest[i]);
    for (j = high; j >= low; j--) {
      const match = matchScores[row + j];
      if (match !== UNREACHABLE && (matchRequired || match === bestScores[row + j])) {
        matchRequired = consecutiveFlags[row + j] === 1;
        positions[i] = j;
        j--;
        break;
      }
    }
  }
  return positions;
}

export function fuzzyMatch(query: string, path: string): FuzzyMatch | null {
  const needle = normalizeQuery(query);
  if (needle.length === 0) return { score: 0, positions: [] };
  const text = foldCase(path);
  if (needle.length > text.length || !computeWindows(needle, text)) return null;
  const score = scoreCandidate(needle, path, text);
  return { score, positions: tracePositions(needle, path.length) };
}

export function rankFiles(query: string, paths: string[], limit = 50): RankedFile[] {
  const needle = normalizeQuery(query);
  const candidates: Array<{ path: string; score: number }> = [];
  for (const path of paths) {
    if (needle.length === 0) {
      candidates.push({ path, score: 0 });
      continue;
    }
    const text = foldCase(path);
    if (needle.length > text.length || !computeWindows(needle, text)) continue;
    candidates.push({ path, score: scoreCandidate(needle, path, text) });
  }
  candidates.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  return candidates.slice(0, limit).map(({ path, score }) => {
    if (needle.length === 0) return { path, score, positions: [] };
    const text = foldCase(path);
    computeWindows(needle, text);
    scoreCandidate(needle, path, text);
    return { path, score, positions: tracePositions(needle, path.length) };
  });
}
