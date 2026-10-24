import { ptyTopic } from "@cw-code/shared/topics";
import type { ServerApp } from "../app/ServerApp.js";
import type { PtyKind } from "../pty/PtyPool.js";
import type { CallContext, Router } from "../transport/Router.js";
import { handle } from "./shared.js";

export function registerPtyHandlers(router: Router, app: ServerApp): void {
  const services = () => app.requireServices();
  const attached = (ctx: CallContext, ptyId: string): boolean => app.topics.isSubscribed(ctx.clientId, ptyTopic(ptyId));
  handle<{ sessionId: string; kind: PtyKind }>(router, "pty.open", (args, ctx) => {
    const { sessions, ptys } = services();
    return sessions
      .ensureWorktree(args.sessionId)
      .then(async (root) =>
        ptys.open(
          args.sessionId,
          root,
          args.kind,
          sessions.resumeCursorFor(args.sessionId),
          await sessions.terminalEnv(args.sessionId, root),
          (ptyId, data) => app.emit("pty.data", { ptyId, data }),
          () => sessions.terminalLaunch(args.sessionId, args.kind, root)
        )
      )
      .then((result) => {
        app.topics.subscribe(ctx.clientId, [ptyTopic(result.ptyId)]);
        return result;
      });
  });
  handle<{ ptyId: string; data: string }>(router, "pty.write", (args, ctx) => {
    if (attached(ctx, args.ptyId)) services().ptys.write(args.ptyId, ctx.clientId, args.data);
  });
  handle<{ ptyId: string; cols: number; rows: number }>(router, "pty.resize", (args, ctx) => {
    if (attached(ctx, args.ptyId)) services().ptys.resize(args.ptyId, ctx.clientId, args.cols, args.rows);
  });
  handle<{ ptyId: string }>(router, "pty.detach", (args, ctx) => app.topics.unsubscribe(ctx.clientId, [ptyTopic(args.ptyId)]));
  handle<{ ptyId: string }>(router, "pty.kill", (args) => services().ptys.kill(args.ptyId));
}
