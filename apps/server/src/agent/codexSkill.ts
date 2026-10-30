import { join } from "node:path";
import { cwSkillMarkdown } from "./cwSkill.js";
import { writeFileIfChanged } from "./writeFileIfChanged.js";

export async function writeCodexSkill(skillsRoot: string): Promise<void> {
  await writeFileIfChanged(join(skillsRoot, "cw-code", "SKILL.md"), cwSkillMarkdown("codex"));
}
