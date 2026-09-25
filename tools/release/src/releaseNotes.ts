export interface CommitGroups {
  feat: string[];
  fix: string[];
  perf: string[];
  other: string[];
}

const CONVENTIONAL_PATTERN = /^(feat|fix|perf|docs|chore)(\([^)]*\))?!?:\s*(.+)$/;

function skipSubject(type: string, scope: string | undefined): boolean {
  if (type === "docs") return true;
  if (type === "chore" && scope === "release") return true;
  return false;
}

export function groupCommitSubjects(subjects: string[]): CommitGroups {
  const groups: CommitGroups = { feat: [], fix: [], perf: [], other: [] };
  for (const subject of subjects) {
    const match = CONVENTIONAL_PATTERN.exec(subject);
    if (!match) {
      groups.other.push(subject);
      continue;
    }
    const [, type, scopeWithParens] = match;
    const scope = scopeWithParens ? scopeWithParens.slice(1, -1) : undefined;
    if (skipSubject(type, scope)) continue;
    if (type === "feat" || type === "fix" || type === "perf") {
      groups[type].push(subject);
    } else {
      groups.other.push(subject);
    }
  }
  return groups;
}

const SECTION_TITLES: Record<keyof CommitGroups, string> = {
  feat: "Features",
  fix: "Fixes",
  perf: "Performance",
  other: "Other"
};

export function renderReleaseNotes(groups: CommitGroups): string {
  const sections: string[] = [];
  for (const key of ["feat", "fix", "perf", "other"] as const) {
    const entries = groups[key];
    if (entries.length === 0) continue;
    const lines = entries.map((entry) => `- ${entry}`).join("\n");
    sections.push(`## ${SECTION_TITLES[key]}\n\n${lines}`);
  }
  if (sections.length === 0) return "_No changes._";
  return sections.join("\n\n");
}

export function buildReleaseNotes(subjects: string[]): string {
  return renderReleaseNotes(groupCommitSubjects(subjects));
}
