import { homedir } from "node:os";

export interface PathExpansionContext {
  env?: Readonly<Record<string, string | undefined>>;
  homeDir?: string;
  platform?: NodeJS.Platform;
}

const NAME = "[A-Za-z_][A-Za-z0-9_]*";
const LEADING_TOKEN = new RegExp(
  `^(?:%(${NAME}(?:\\(${NAME}\\))?)%|\\$env:(${NAME})|\\$\\{(${NAME})(?::-([^}]*))?\\}|\\$(${NAME})|(~))(?=$|[\\\\/])`
);

function lookup(name: string, env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

export function expandLeadingPathVariable(input: string, context: PathExpansionContext = {}): string {
  const match = LEADING_TOKEN.exec(input);
  if (!match) return input;
  const [token, percent, powershell, braced, fallback, bare, tilde] = match;
  const env = context.env ?? process.env;
  const platform = context.platform ?? process.platform;
  const value = tilde ? (context.homeDir ?? homedir()) : lookup(percent ?? powershell ?? braced ?? bare, env, platform) || fallback;
  if (!value) return input;
  return value + input.slice(token.length);
}
