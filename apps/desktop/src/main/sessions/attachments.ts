import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function resolveAttachments(projectRoot: string, cwd: string, attachments: string[]): string[] {
  const kept: string[] = [];
  for (const rel of attachments) {
    if (isAbsolute(rel)) {
      if (existsSync(rel)) {
        kept.push(rel);
        continue;
      }
      console.warn(`attachment not found, skipped: ${rel}`);
      continue;
    }
    const abs = resolve(join(projectRoot, rel));
    const relToRoot = relative(resolve(projectRoot), abs);
    if (relToRoot === ".." || relToRoot.startsWith(`..${sep}`) || isAbsolute(relToRoot)) {
      console.warn(`attachment not found, skipped: ${rel}`);
      continue;
    }
    if (existsSync(join(cwd, rel))) {
      kept.push(rel);
      continue;
    }
    const source = join(projectRoot, rel);
    if (existsSync(source)) {
      const target = join(cwd, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(source));
      kept.push(rel);
      continue;
    }
    console.warn(`attachment not found, skipped: ${rel}`);
  }
  return kept;
}
