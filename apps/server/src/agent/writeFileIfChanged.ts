import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function writeFileIfChanged(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const existing = await readFile(file, "utf8").catch(() => undefined);
  if (existing !== content) await writeFile(file, content, "utf8");
}
