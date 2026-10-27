import type { ImportableSession } from "../cw.js";

function searchText(session: ImportableSession): string {
  return [session.title, session.projectName, session.cwd, session.repository, session.gitBranch, session.resumeCursor]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

export function filterImportable(sessions: ImportableSession[], query: string): ImportableSession[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return sessions;
  return sessions.filter((session) => {
    const text = searchText(session);
    return terms.every((term) => text.includes(term));
  });
}
