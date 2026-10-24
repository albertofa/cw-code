export function sameDirectory(a: string, b: string): boolean {
  const norm = (s: string): string => s.replace(/\\/g, "/").replace(/\/+$/, "");
  if (process.platform === "win32") return norm(a).toLowerCase() === norm(b).toLowerCase();
  return norm(a) === norm(b);
}
