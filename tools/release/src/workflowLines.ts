import { readFileSync } from "node:fs";

export function readWorkflowText(path: string): string {
  return readFileSync(path, "utf8").replace(/
/g, "
");
}

export function topLevelBlock(lines: string[], key: string): string[] {
  const start = lines.indexOf(`${key}:`);
  if (start === -1) throw new Error(`workflow has no top-level "${key}:"`);
  const end = lines.findIndex((line, index) => index > start && /^\S/.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

export function jobBlocks(lines: string[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of topLevelBlock(lines, "jobs")) {
    const header = /^ {2}([\w-]+):$/.exec(line);
    if (header) {
      current = [];
      result.set(header[1], current);
    } else if (current) {
      current.push(line);
    }
  }
  return result;
}

export function runScriptLines(source: string[]): string[] {
  const result: string[] = [];
  let blockIndent: number | null = null;
  for (const line of source) {
    const indent = line.length - line.trimStart().length;
    if (blockIndent !== null) {
      if (line.trim() === "" || indent > blockIndent) {
        result.push(line);
        continue;
      }
      blockIndent = null;
    }
    const run = /^(\s*)(- )?run:\s*(.*)$/.exec(line);
    if (!run) continue;
    if (/^[|>][-+]?\s*$/.test(run[3])) {
      blockIndent = run[1].length + (run[2] ? 2 : 0);
    } else {
      result.push(line);
    }
  }
  return result;
}
