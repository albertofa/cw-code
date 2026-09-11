import { assertInside } from "../../fs/FileService.js";

export function opencodeFileArgs(cwd: string, attachments: string[] | undefined): string[] {
  const files: string[] = [];
  for (const rel of attachments ?? []) {
    try {
      assertInside(cwd, rel);
      files.push(rel);
    } catch {
      console.warn(`attachment escapes project root, skipped: ${rel}`);
    }
  }
  return files.flatMap((rel) => ["-f", rel]);
}
