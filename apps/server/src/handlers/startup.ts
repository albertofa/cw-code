import type { MetadataIssue, StartupState } from "@cw-code/contracts";
import type { ServerApp } from "../app/ServerApp.js";
import { metadataSchemaFor } from "../storage/metadataStores.js";
import { restoreBackup, startFresh } from "../storage/recovery.js";
import type { Router } from "../transport/Router.js";
import { handle } from "./shared.js";

function recoveryIssueFor(startupState: StartupState, args: { file?: unknown } | undefined): MetadataIssue {
  if (startupState.mode !== "recovery") throw new Error("cw-code is not in recovery mode");
  if (!args || typeof args.file !== "string") throw new Error("a recovery action requires { file }");
  const file = args.file;
  const issue = startupState.issues.find((candidate) => candidate.file === file);
  if (!issue) throw new Error(`${file} is not a file that needs recovery`);
  return issue;
}

export function registerStartupHandlers(router: Router, app: ServerApp): void {
  handle(router, "startup.state", (): StartupState => app.startupState);
  handle<{ file: string; backupPath: string } | undefined>(router, "recovery.restore", (args) => {
    if (!args || typeof args.backupPath !== "string") throw new Error("recovery.restore requires { file, backupPath }");
    const issue = recoveryIssueFor(app.startupState, args);
    const result = restoreBackup(issue.file, args.backupPath, metadataSchemaFor(issue.store));
    console.warn(
      `restored ${result.file} from ${result.restoredFrom}${result.brokenPath ? `; previous file kept at ${result.brokenPath}` : ""}${result.archivedLastGood ? `; last good backup kept at ${result.archivedLastGood}` : ""}`
    );
    return app.reboot();
  });
  handle<{ file: string } | undefined>(router, "recovery.startFresh", (args) => {
    const issue = recoveryIssueFor(app.startupState, args);
    if (issue.kind === "io") throw new Error(`${issue.file} may be intact behind a lock; retry instead of starting fresh`);
    const result = startFresh(issue.file, metadataSchemaFor(issue.store));
    console.warn(
      `started ${result.file} fresh${result.brokenPath ? `; previous file kept at ${result.brokenPath}` : ""}${result.archivedLastGood ? `; last good backup kept at ${result.archivedLastGood}` : ""}`
    );
    return app.reboot();
  });
  handle(router, "recovery.retry", () => {
    if (app.startupState.mode !== "recovery") throw new Error("cw-code is not in recovery mode");
    return app.reboot();
  });
}
