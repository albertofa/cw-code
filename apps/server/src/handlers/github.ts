import { randomUUID } from "node:crypto";
import { GITHUB_META_TOPIC, parseGithubViewTopic } from "@cw-code/shared/topics";
import type { ServerApp } from "../app/ServerApp.js";
import { addSavedView, assertGitHubKind, deleteSavedView, renameSavedView } from "../github/savedViews.js";
import type { Router } from "../transport/Router.js";
import { commitSettings } from "./settings.js";
import { handle, parseArgs, parseOptionalBoolean } from "./shared.js";

function parseGitHubTopic(topic: unknown): string {
  if (typeof topic === "string" && (topic === GITHUB_META_TOPIC || parseGithubViewTopic(topic) !== null)) return topic;
  throw Object.assign(new Error("topic must be github/meta or a github/view topic"), { code: "invalid-topic" });
}

export function registerGitHubHandlers(router: Router, app: ServerApp): void {
  const services = () => app.requireServices();
  handle(router, "github.refresh", (args) => {
    const { topic, force } = parseArgs(args, "github.refresh");
    return services().githubViews.refresh(parseGitHubTopic(topic), parseOptionalBoolean(force, "force") === true);
  });
  handle(router, "github.viewCounts", (args) => {
    const { kind } = parseArgs(args, "github.viewCounts");
    assertGitHubKind(kind);
    return services().githubViews.viewCounts(kind);
  });
  handle(router, "github.saveView", (args) => {
    const params = parseArgs(args, "github.saveView");
    const { views, view } = addSavedView(services().sessions.getSettings().githubSavedViews, params, randomUUID());
    commitSettings(app, { githubSavedViews: views });
    return view;
  });
  handle(router, "github.renameView", (args) => {
    const { id, name } = parseArgs(args, "github.renameView");
    commitSettings(app, { githubSavedViews: renameSavedView(services().sessions.getSettings().githubSavedViews, id, name) });
  });
  handle(router, "github.deleteView", (args) => {
    const { id } = parseArgs(args, "github.deleteView");
    commitSettings(app, { githubSavedViews: deleteSavedView(services().sessions.getSettings().githubSavedViews, id) });
  });
}
