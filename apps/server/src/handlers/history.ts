import type { ServerApp } from "../app/ServerApp.js";
import { parseAvatarAuthors } from "../history/HistoryAvatars.js";
import { isFullSha, parseHistoryLimit } from "../history/historyParsers.js";
import type { Router } from "../transport/Router.js";
import { handle, knownSessionId, parseArgs } from "./shared.js";

export function registerHistoryHandlers(router: Router, app: ServerApp): void {
  const services = () => app.requireServices();
  const rootOf = async (sessionId: unknown): Promise<string> => {
    const { sessions } = services();
    const id = knownSessionId(sessions, sessionId);
    return (await sessions.sessionStatusContext(id)).root;
  };
  handle(router, "history.log", async (raw) => {
    const args = parseArgs(raw, "history.log");
    const limit = parseHistoryLimit(args.limit);
    return services().history.log(await rootOf(args.sessionId), limit);
  });
  handle(router, "history.commit", async (raw) => {
    const args = parseArgs(raw, "history.commit");
    if (!isFullSha(args.sha)) throw new Error("sha must be a full 40-character commit id");
    return services().history.commit(await rootOf(args.sessionId), args.sha);
  });
  handle(router, "history.avatars", async (raw) => {
    const args = parseArgs(raw, "history.avatars");
    const authors = parseAvatarAuthors(args.authors);
    return services().historyAvatars.resolve(await rootOf(args.sessionId), authors);
  });
}
