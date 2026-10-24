import type { ServerApp } from "../app/ServerApp.js";
import type { Router } from "../transport/Router.js";
import { registerCliHandlers } from "./cli.js";
import { registerDebugHandlers } from "./debug.js";
import { registerFileHandlers } from "./files.js";
import { registerGitHandlers } from "./git.js";
import { registerGitHubHandlers } from "./github.js";
import { registerPrHandlers } from "./prs.js";
import { registerPtyHandlers } from "./pty.js";
import { registerServerHandlers } from "./server.js";
import { registerSessionHandlers } from "./sessions.js";
import { registerSettingsHandlers } from "./settings.js";
import { registerShutdownHandlers } from "./shutdown.js";
import { registerSkillHandlers } from "./skills.js";
import { registerStartupHandlers } from "./startup.js";
import { registerTopicHandlers } from "./topics.js";
import { registerTurnHandlers } from "./turns.js";
import { registerUsageHandlers } from "./usage.js";

export function registerHandlers(router: Router, app: ServerApp): void {
  registerSessionHandlers(router, app);
  registerTurnHandlers(router, app);
  registerGitHandlers(router, app);
  registerGitHubHandlers(router, app);
  registerPrHandlers(router, app);
  registerFileHandlers(router, app);
  registerPtyHandlers(router, app);
  registerSettingsHandlers(router, app);
  registerSkillHandlers(router, app);
  registerCliHandlers(router, app);
  registerUsageHandlers(router, app);
  registerShutdownHandlers(router, app);
  registerStartupHandlers(router, app);
  registerDebugHandlers(router);
  registerServerHandlers(router, app);
  registerTopicHandlers(router, app);
}
