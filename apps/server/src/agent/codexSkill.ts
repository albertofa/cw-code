import { join } from "node:path";
import { cwSkills } from "./cwSkill.js";
import { writeFileIfChanged } from "./writeFileIfChanged.js";

export async function writeCodexSkills(skillsRoot: string): Promise<void> {
  for (const skill of cwSkills("codex")) await writeFileIfChanged(join(skillsRoot, skill.name, "SKILL.md"), skill.markdown);
}
