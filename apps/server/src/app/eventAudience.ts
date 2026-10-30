import type { CallContext } from "../transport/Router.js";

const SHELL_CHANNELS = new Set(["settings.changed", "shutdown.changed", "startup.changed", "app.notice"]);

const notMcp = (ctx: CallContext): boolean => ctx.client !== "mcp";
const notShell = (ctx: CallContext): boolean => ctx.client !== "desktop-shell" && notMcp(ctx);

export function eventAudience(channel: string): ((ctx: CallContext) => boolean) | undefined {
  return SHELL_CHANNELS.has(channel) ? notMcp : notShell;
}
