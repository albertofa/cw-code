import type { ServerApp } from "../app/ServerApp.js";
import type { PtyKind } from "../pty/PtyPool.js";
import type { Router } from "../transport/Router.js";
import { handle } from "./shared.js";

export function registerPtyHandlers(router: Router, app: ServerApp): void {
  const services = () => app.requireServices();
  handle<{ sessionId: string; kind: PtyKind }>(router, "pty.open", (args) => {
    const { sessions, ptys } = services();
    return sessions.ensureWorktree(args.sessionId).then(async (root) =>
      ptys.open(
        args.sessionId,
        root,
        args.kind,
        sessions.resumeCursorFor(args.sessionId),
        await sessions.terminalEnv(args.sessionId, root),
        (ptyId, data) => app.emit("pty.data", { ptyId, data }),
        () => sessions.terminalLaunch(args.sessionId, args.kind, root)
      )
    );
  });
  handle<{ ptyId: string; data: string }>(router, "pty.write", (args) => services().ptys.write(args.ptyId, args.data));
  handle<{ ptyId: string; cols: number; rows: number }>(router, "pty.resize", (args) => services().ptys.resize(args.ptyId, args.cols, args.rows));
  handle<{ ptyId: string; token: string }>(router, "pty.detach", (args) => services().ptys.detach(args.ptyId, args.token));
  handle<{ ptyId: string }>(router, "pty.kill", (args) => services().ptys.kill(args.ptyId));
}
