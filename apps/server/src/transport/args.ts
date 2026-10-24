export interface ServerArgs {
  host: string;
  port: number;
  parentPid: number | null;
  legacyUserData: string[];
}

const VALUE_FLAGS = new Set(["--host", "--port", "--parent-pid", "--legacy-user-data"]);
const MAX_PORT = 65535;

function parseInteger(flag: string, value: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || parsed < min || parsed > max) {
    throw new Error(`invalid value for ${flag}: '${value}' (expected an integer from ${min} to ${max})`);
  }
  return parsed;
}

function splitFlag(arg: string): { flag: string; inline: string | null } {
  const separator = arg.indexOf("=");
  return separator === -1 ? { flag: arg, inline: null } : { flag: arg.slice(0, separator), inline: arg.slice(separator + 1) };
}

export function parseServerArgs(argv: string[]): ServerArgs {
  const args: ServerArgs = { host: "127.0.0.1", port: 0, parentPid: null, legacyUserData: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const { flag, inline } = splitFlag(argv[index]!);
    if (!VALUE_FLAGS.has(flag)) throw new Error(`unknown flag: ${argv[index]}`);
    const value = inline ?? argv[++index];
    if (value === undefined || value === "") throw new Error(`missing value for ${flag}`);
    if (flag === "--host") args.host = value;
    else if (flag === "--port") args.port = parseInteger(flag, value, 0, MAX_PORT);
    else if (flag === "--parent-pid") args.parentPid = parseInteger(flag, value, 1, Number.MAX_SAFE_INTEGER);
    else args.legacyUserData.push(value);
  }
  return args;
}
