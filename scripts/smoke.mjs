import { execFileSync, spawnSync } from "node:child_process";

function check(binary, args) {
  try {
    const out = execFileSync(binary, args, { encoding: "utf8", timeout: 20000 });
    const match = out.match(/(\d+\.\d+\.\d+)/);
    console.log(`${binary}: ${match ? match[1] : out.trim().slice(0, 40)}`);
  } catch (err) {
    console.log(`${binary}: MISSING (${err.message.split("\n")[0]})`);
    process.exitCode = 1;
  }
}

check("claude", ["--version"]);
check("opencode", ["--version"]);

const tsc = spawnSync("pnpm", ["--filter", "@cw-code/desktop", "exec", "tsc", "--noEmit", "-p", "tsconfig.json"], {
  encoding: "utf8",
  timeout: 180000,
  shell: true
});
console.log(`typecheck: ${tsc.status === 0 ? "ok" : "FAILED"}`);
if (tsc.status !== 0) {
  console.log(tsc.stdout);
  process.exitCode = 1;
}

const test = spawnSync("pnpm", ["--filter", "@cw-code/desktop", "test"], {
  encoding: "utf8",
  timeout: 300000,
  shell: true
});
const summary = test.stdout.match(/Tests\s+.*/)?.[0] ?? "no summary";
console.log(`tests: ${summary}`);
if (test.status !== 0) process.exitCode = 1;
