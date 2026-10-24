import type { HarnessId, SkillSaveInput } from "@cw-code/contracts";
import type { ServerApp } from "../app/ServerApp.js";
import type { Router } from "../transport/Router.js";
import { handle } from "./shared.js";

export function registerSkillHandlers(router: Router, app: ServerApp): void {
  const skills = () => app.requireServices().skills;
  handle(router, "skills.list", () => skills().listSkills());
  handle<string>(router, "skills.get", (name) => skills().getSkill(name));
  handle<SkillSaveInput>(router, "skills.save", (input) => skills().saveSkill(input));
  handle<string>(router, "skills.remove", (name) => skills().removeSkill(name));
  handle<{ name: string; harness: HarnessId; on: boolean }>(router, "skills.setEnabled", (args) =>
    skills().setSkillEnabled(args.name, args.harness, args.on)
  );
  handle(router, "skills.importAll", () => skills().importSkills());
}
