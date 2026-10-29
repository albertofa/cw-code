import type { ApprovalDecision, CommandInvocation, DriverKind, PrRef } from "@cw-code/contracts";
import { isSkillMentionList } from "@cw-code/shared/skillMentions";
import { agentTurnPermissionMode, assertAgentOmits } from "../agent/agentPolicy.js";
import type { ServerApp } from "../app/ServerApp.js";
import { assertPrRef } from "../github/PullRequestService.js";
import type { Router } from "../transport/Router.js";
import { handle, knownSessionId, setComposer } from "./shared.js";

const AGENT_FORBIDDEN_TURN_FIELDS = ["command", "attachments", "acceptFolderHead", "prRefs"] as const;

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
  acceptFolderHead?: string;
}

interface DriverTarget {
  projectId: string;
  driver: DriverKind;
}

export function registerTurnHandlers(router: Router, app: ServerApp): void {
  const sessions = () => app.requireServices().sessions;
  const turns = () => app.requireServices().turns;
  handle<StartTurnArgs>(router, "turns.start", (args, ctx) => {
    if (ctx.auth.kind === "agent") assertAgentOmits(args, AGENT_FORBIDDEN_TURN_FIELDS, "turns.start");
    if (args.skills !== undefined && !isSkillMentionList(args.skills)) throw new Error("invalid skills");
    if (args.prRefs !== undefined && !Array.isArray(args.prRefs)) throw new Error("invalid prRefs");
    if (args.acceptFolderHead !== undefined && typeof args.acceptFolderHead !== "string") throw new Error("invalid acceptFolderHead");
    for (const ref of args.prRefs ?? []) assertPrRef(ref);
    const prefs =
      ctx.auth.kind === "agent"
        ? { ...args.prefs, permissionMode: agentTurnPermissionMode(sessions(), args.sessionId, ctx.auth.sessionId, args.prefs?.permissionMode) }
        : args.prefs;
    return turns().start(args.sessionId, args.prompt, {
      prefs,
      attachments: args.attachments,
      ...(args.command ? { command: args.command } : {}),
      ...(args.skills?.length ? { skills: args.skills } : {}),
      prRefs: args.prRefs,
      ...(args.acceptFolderHead !== undefined ? { acceptFolderHead: args.acceptFolderHead } : {})
    });
  });
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
  handle<{ sessionId: string; prefs: TurnPrefs }>(router, "composer.set", (args) => setComposer(app, args.sessionId, args.prefs));
}
