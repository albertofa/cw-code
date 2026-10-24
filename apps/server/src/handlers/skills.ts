import type { HarnessId, SkillSaveInput, SkillsListResult } from "@cw-code/contracts";
import type { ServerApp } from "../app/ServerApp.js";
import type { Router } from "../transport/Router.js";
import { handle } from "./shared.js";

export function registerSkillHandlers(router: Router, app: ServerApp): void {
  const skills = () => app.requireServices().skills;
  handle(router, "skills.list", () => skills().listSkills());
  handle<string>(router, "skills.get", (name) => skills().getSkill(name));
  const announce = (result: SkillsListResult): SkillsListResult => {
    app.emit("skills.changed", result);
    return result;
  };
  const announceCurrent = async <T>(result: T): Promise<T> => {
    app.emit("skills.changed", await skills().listSkills());
    return result;
  };
  handle<SkillSaveInput>(router, "skills.save", async (input) => announceCurrent(await skills().saveSkill(input)));
  handle<string>(router, "skills.remove", async (name) => announce(await skills().removeSkill(name)));
  handle<{ name: string; harness: HarnessId; on: boolean }>(router, "skills.setEnabled", async (args) =>
    announceCurrent(await skills().setSkillEnabled(args.name, args.harness, args.on))
  );
  handle(router, "skills.importAll", async () => announce(await skills().importSkills()));
}
