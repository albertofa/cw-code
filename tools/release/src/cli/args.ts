export interface ParsedArgs {
  command: string;
  options: Map<string, string>;
}

const BOOLEAN_FLAGS = new Set(["force", "require-production"]);

export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const options = new Map<string, string>();
  let i = 0;
  while (i < rest.length) {
    const token = rest[i];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument "${token}"`);
    }
    const key = token.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      options.set(key, "true");
      i += 1;
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--${key} requires a value`);
    }
    options.set(key, value);
    i += 2;
  }
  return { command: command ?? "", options };
}
