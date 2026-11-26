import type { ApprovalDecision, CommandInvocation, DriverKind, PrRef } from "@cw-code/contracts";
import { isSkillMentionList } from "@cw-code/shared/skillMentions";
import { agentTurnPermissionMode, assertAgentMayDispatch, assertAgentModelId, assertAgentOmits, assertAgentSessionTarget, isSafeModelId } from "../agent/agentPolicy.js";
import type { ServerApp } from "../app/ServerApp.js";
import { assertPrRef } from "../github/PullRequestService.js";
import type { CallContext, Router } from "../transport/Router.js";
import { handle, knownSessionId, parseString, setComposer } from "./shared.js";

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
  const assertAgentTarget = (ctx: CallContext, sessionId: string): void => {
    if (ctx.auth.kind !== "agent") return;
    const findSession = (id: string) => sessions().findSession(id);
    assertAgentMayDispatch(ctx, findSession);
    assertAgentSessionTarget(findSession, sessionId, ctx.auth.sessionId);
  };
  handle<StartTurnArgs>(router, "turns.start", (args, ctx) => {
    if (ctx.auth.kind === "agent") {
      assertAgentTarget(ctx, args.sessionId);
      assertAgentOmits(args, AGENT_FORBIDDEN_TURN_FIELDS, "turns.start");
      assertAgentModelId(args.prefs?.model, "turns.start prefs.model");
      assertAgentModelId(args.prefs?.variant, "turns.start prefs.variant");
    }
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
  handle<{ sessionId: string; prompt: string; attachments?: string[]; skills?: string[] }>(router, "turns.send", (args) => {
    const sessionId = knownSessionId(sessions(), args.sessionId);
    const prompt = parseString(args.prompt, "prompt");
    if (args.attachments !== undefined && !(Array.isArray(args.attachments) && args.attachments.every((path) => typeof path === "string"))) {
      throw new Error("invalid attachments");
    }
    if (args.skills !== undefined && !isSkillMentionList(args.skills)) throw new Error("invalid skills");
    return turns().send(sessionId, prompt, {
      attachments: args.attachments,
      ...(args.skills?.length ? { skills: args.skills } : {})
    });
  });
  handle<{ sessionId: string; messageId: string }>(router, "turns.unqueue", (args) =>
    turns().unqueue(knownSessionId(sessions(), args.sessionId), parseString(args.messageId, "messageId"))
  );
  handle<{ sessionId: string }>(router, "turns.flushQueue", (args) => turns().flushQueue(knownSessionId(sessions(), args.sessionId)));
  handle<{ sessionId: string }>(router, "turns.stop", (args, ctx) => {
    const sessionId = knownSessionId(sessions(), args.sessionId);
    assertAgentTarget(ctx, sessionId);
    return turns().stop(sessionId);
  });
  handle<{ sessionId: string }>(router, "turns.cancelLimitResume", (args) =>
    app.requireServices().limitResume.cancel(knownSessionId(sessions(), args.sessionId))
  );
  handle<{ sessionId: string; model: string }>(router, "turns.continueWithModel", async (args) => {
    const sessionId = knownSessionId(sessions(), args.sessionId);
    const model = typeof args.model === "string" ? args.model.trim() : "";
    if (!isSafeModelId(model)) throw new Error("model is not a valid model id");
    const turnId = await app.requireServices().limitResume.continueNow(sessionId, model);
    // Persist the switch only once the turn started, so a refused continuation leaves the composer as it was.
    setComposer(app, sessionId, { ...sessions().getComposer(sessionId), model });
    return turnId;
  });
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
