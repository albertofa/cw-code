import type { DriverKind } from "./session.js";

export type HarnessId = DriverKind;

export type SkillSource = HarnessId | "created";

export interface SkillMeta {
  name: string;
  description: string;
  enabled: Record<HarnessId, boolean>;
  sourceHarness: SkillSource | null;
  hasBody: boolean;
  updatedAt: number;
}

export interface SkillDetail extends SkillMeta {
  body: string;
  frontmatter: Record<string, string>;
}

export interface SkillsListResult {
  skills: SkillMeta[];
}

export interface SkillSaveInput {
  name: string;
  description: string;
  body: string;
  enabled: Record<HarnessId, boolean>;
}
