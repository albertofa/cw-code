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
