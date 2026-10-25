import type { ApprovalDecision, CommandInvocation, DriverKind, PrRef } from "@cw-code/contracts";
import { isSkillMentionList } from "@cw-code/shared/skillMentions";
import type { ServerApp } from "../app/ServerApp.js";
import { assertPrRef } from "../github/PullRequestService.js";
import type { Router } from "../transport/Router.js";
import { handle, knownSessionId } from "./shared.js";

interface TurnPrefs {
  model?: string;
  effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  variant?: string;
  permissionMode?: "auto" | "acceptEdits" | "bypassPermissions" | "manual";
}

interface StartTurnArgs {
  sessionId: string;
  prompt: string;
  prefs?: TurnPrefs;
  attachments?: string[];
  command?: CommandInvocation;
  skills?: string[];
  prRefs?: PrRef[];
  finalReview?: { ref: PrRef; sha: string };
  acceptFolderHead?: string;
  auto?: boolean;
}

interface DriverTarget {
  projectId: string;
  driver: DriverKind;
}

export function registerTurnHandlers(router: Router, app: ServerApp): void {
  const sessions = () => app.requireServices().sessions;
  const turns = () => app.requireServices().turns;
  handle<StartTurnArgs>(router, "turns.start", (args) => {
    if (args.skills !== undefined && !isSkillMentionList(args.skills)) throw new Error("invalid skills");
    if (args.prRefs !== undefined && !Array.isArray(args.prRefs)) throw new Error("invalid prRefs");
    if (args.acceptFolderHead !== undefined && typeof args.acceptFolderHead !== "string") throw new Error("invalid acceptFolderHead");
    if (args.auto !== undefined && typeof args.auto !== "boolean") throw new Error("invalid auto");
    for (const ref of args.prRefs ?? []) assertPrRef(ref);
    if (args.finalReview !== undefined) {
      assertPrRef(args.finalReview.ref);
      if (typeof args.finalReview.sha !== "string" || args.finalReview.sha === "") throw new Error("invalid finalReview sha");
    }
    return turns().start(args.sessionId, args.prompt, {
      prefs: args.prefs,
      attachments: args.attachments,
      ...(args.command ? { command: args.command } : {}),
      ...(args.skills?.length ? { skills: args.skills } : {}),
      prRefs: args.prRefs,
      ...(args.finalReview ? { finalReview: args.finalReview } : {}),
      ...(args.acceptFolderHead !== undefined ? { acceptFolderHead: args.acceptFolderHead } : {}),
      ...(args.auto ? { auto: true } : {})
    });
  });
  handle<{ turnId: string }>(router, "turns.interrupt", (args) => sessions().interrupt(args.turnId));
  handle<{ sessionId: string }>(router, "turns.stop", (args) => turns().stop(knownSessionId(sessions(), args.sessionId)));
  handle<{ sessionId: string; requestId: string; decision: ApprovalDecision }>(router, "approvals.respond", (args) =>
    sessions().respondApproval(args.requestId, args.decision)
  );
  handle<{ sessionId: string; requestId: string; answers: Record<string, string> }>(router, "questions.respond", (args) =>
    sessions().respondQuestion(args.requestId, args.answers)
  );
  handle<{ sessionId: string }>(router, "commands.list", (args) => sessions().listCommands(args.sessionId));
  handle<DriverTarget>(router, "commands.listFor", (args) => sessions().listCommandsFor(args.projectId, args.driver));
  handle<{ sessionId: string }>(router, "models.list", (args) => sessions().listModels(args.sessionId));
  handle<DriverTarget>(router, "models.listFor", (args) => sessions().listModelsFor(args.projectId, args.driver));
  handle<{ driver: DriverKind }>(router, "models.listForHarness", (args) => sessions().listModelsForHarness(args.driver));
  handle<{ sessionId: string }>(router, "permissions.list", (args) => sessions().listPermissionModes(args.sessionId));
  handle<DriverTarget>(router, "permissions.listFor", (args) => sessions().listPermissionModesFor(args.projectId, args.driver));
  handle<{ driver: DriverKind }>(router, "permissions.listForHarness", (args) => sessions().listPermissionModesForHarness(args.driver));
  handle<{ sessionId: string }>(router, "composer.get", (args) => sessions().getComposer(args.sessionId));
  handle<{ sessionId: string; prefs: TurnPrefs }>(router, "composer.set", (args) => {
    const prefs = sessions().setComposer(args.sessionId, args.prefs);
    app.emit("composer.changed", { sessionId: args.sessionId, prefs });
    return prefs;
  });
}
