import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LIFETIME_MS = 10 * 60_000;
const logPath = join(dirname(fileURLToPath(import.meta.url)), "fake-claude.jsonl");
const args = process.argv.slice(2);

function record(event, data = {}) {
  appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), event, pid: process.pid, ...data })}\n`);
}

if (args.includes("--version")) {
  process.stdout.write("2.1.999 (Claude Code)\n");
  process.exit(0);
}

if (!args.includes("--input-format")) {
  record("probe", { argCount: args.length });
  process.exit(0);
}

record("turn-start", { argCount: args.length });
let lines = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  lines += chunk.split("\n").filter((line) => line.trim() !== "").length;
  record("stdin", { lines });
});
process.stdin.on("end", () => {
  record("stdin-closed", { lines });
  process.exit(0);
});
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    record("signal", { signal });
    process.exit(0);
  });
}
setTimeout(() => {
  record("lifetime-exceeded");
  process.exit(3);
}, LIFETIME_MS).unref();
