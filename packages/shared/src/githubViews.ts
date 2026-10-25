import type { GitHubKind, GitHubViewDef, SavedGitHubView } from "@cw-code/contracts";

export const ORG_PLACEHOLDER = "{org}";

export type BuiltinView = Omit<GitHubViewDef, "saved">;

export const BUILTIN_VIEWS: BuiltinView[] = [
  { id: "pr:inbox", kind: "pr", name: "Inbox", icon: "Inbox", query: "is:pr involves:@me state:open", group: "triage" },
  { id: "pr:authored", kind: "pr", name: "Authored by me", icon: "Pencil", query: "is:pr author:@me state:open archived:false sort:updated-desc", group: "none" },
  { id: "pr:review", kind: "pr", name: "Review requests", icon: "Eye", query: "is:pr review-requested:@me state:open", group: "none" },
  { id: "pr:assigned", kind: "pr", name: "Assigned to me", icon: "UserCheck", query: "is:pr assignee:@me state:open", group: "none" },
  { id: "pr:mentions", kind: "pr", name: "Mentions", icon: "AtSign", query: "is:pr mentions:@me state:open", group: "none" },
  { id: "pr:org", kind: "pr", name: `${ORG_PLACEHOLDER} · all open`, icon: "Building2", query: `is:pr org:${ORG_PLACEHOLDER} state:open`, group: "repo" },
  { id: "issue:inbox", kind: "issue", name: "Inbox", icon: "Inbox", query: "is:issue involves:@me state:open", group: "triage" },
  { id: "issue:assigned", kind: "issue", name: "Assigned to me", icon: "UserCheck", query: "is:issue assignee:@me state:open", group: "none" },
  { id: "issue:created", kind: "issue", name: "Created by me", icon: "Pencil", query: "is:issue author:@me state:open", group: "none" },
  { id: "issue:mentions", kind: "issue", name: "Mentions", icon: "AtSign", query: "is:issue mentions:@me state:open", group: "none" },
  { id: "issue:org", kind: "issue", name: `${ORG_PLACEHOLDER} · all open`, icon: "Building2", query: `is:issue org:${ORG_PLACEHOLDER} state:open`, group: "repo" },
  { id: "run:watching", kind: "run", name: "Watching", icon: "Inbox", query: "is:run involves:@me", group: "triage" },
  { id: "run:mine", kind: "run", name: "Triggered by me", icon: "User", query: "is:run actor:@me", group: "none" },
  { id: "run:failing", kind: "run", name: "Failing", icon: "CircleX", query: "is:run involves:@me status:failure", group: "none" },
  { id: "run:org", kind: "run", name: `${ORG_PLACEHOLDER} · all runs`, icon: "Building2", query: `is:run org:${ORG_PLACEHOLDER}`, group: "repo" }
];

export const SAVED_VIEW_ICON = "Bookmark";
export const MAX_SAVED_VIEWS = 50;
export const MAX_VIEW_NAME_LENGTH = 80;
export const MAX_QUERY_LENGTH = 512;

export function resolveViews(kind: GitHubKind, org: string | null, savedViews: SavedGitHubView[]): GitHubViewDef[] {
  const builtin = BUILTIN_VIEWS.filter((view) => view.kind === kind).flatMap((view): GitHubViewDef[] => {
    const needsOrg = view.query.includes(ORG_PLACEHOLDER);
    if (needsOrg && !org) return [];
    return [
      {
        ...view,
        name: view.name.split(ORG_PLACEHOLDER).join(org ?? ""),
        query: view.query.split(ORG_PLACEHOLDER).join(org ?? ""),
        saved: false
      }
    ];
  });
  const saved = savedViews.filter((view) => view.kind === kind).map((view): GitHubViewDef => ({ ...view, icon: SAVED_VIEW_ICON, saved: true }));
  return [...builtin, ...saved];
}
