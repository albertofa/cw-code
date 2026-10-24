const CLAUDE_ANSI_RE = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const CLAUDE_EXIT_BOILERPLATE_RE =
  /sandbox disabled|sandbox is (not active|enabled)|without sandboxing|restrictions will not be enforced/i;

export function describeClaudeExit(stderr: string, code: number | null, context = "completing the turn"): string {
  const cleaned = stderr
    .replace(CLAUDE_ANSI_RE, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !CLAUDE_EXIT_BOILERPLATE_RE.test(line))
    .join("\n");
  if (cleaned) return cleaned.slice(0, 2000);
  return `claude exited before ${context} (code ${code})`;
}
