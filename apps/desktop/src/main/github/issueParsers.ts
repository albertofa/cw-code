import type { IssueComment, IssueDetail, IssueLinkedPr, IssueRef, IssueSummary } from "@cw-code/contracts";
import { actorLoginOf, asBool, avatarUrlsOf, asEpochMs, asNodes, asNumber, asRecord, asString, parseJsonObject, parseSearchPage } from "./prParsers.js";

const ISSUE_URL_RE = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/issues\/(\d+)/i;
const STATE_REASONS = new Set(["COMPLETED", "NOT_PLANNED", "REOPENED"]);
const GHOST_LOGIN = "ghost";

export function issueRefFromUrl(url: string): IssueRef | null {
  const match = ISSUE_URL_RE.exec(url.trim());
  if (!match) return null;
  const number = Number.parseInt(match[4], 10);
  if (!Number.isFinite(number) || number <= 0) return null;
  return { host: match[1].toLowerCase(), owner: match[2], repo: match[3], number };
}

function parseStateReason(value: unknown): IssueSummary["stateReason"] {
  const reason = asString(value);
  return STATE_REASONS.has(reason) ? (reason as IssueSummary["stateReason"]) : null;
}

function parseLinkedPrs(value: unknown): IssueLinkedPr[] {
  const linked: IssueLinkedPr[] = [];
  for (const node of asNodes(value)) {
    const number = asNumber(node.number);
    if (number <= 0) continue;
    const state = asString(node.state);
    linked.push({
      number,
      url: asString(node.url),
      state: state === "CLOSED" || state === "MERGED" ? state : "OPEN",
      isDraft: asBool(node.isDraft)
    });
  }
  return linked;
}

function parseIssueNode(node: Record<string, unknown>): IssueSummary | null {
  const url = asString(node.url);
  const ref = issueRefFromUrl(url);
  const number = asNumber(node.number);
  if (!ref || number <= 0) return null;
  const author = actorLoginOf(node.author);
  const milestone = asString(asRecord(node.milestone).title);
  return {
    ref,
    url,
    title: asString(node.title, `Issue #${number}`),
    state: asString(node.state) === "CLOSED" ? "CLOSED" : "OPEN",
    stateReason: parseStateReason(node.stateReason),
    author: { login: author.login || GHOST_LOGIN, isBot: author.isBot },
    assignees: asNodes(node.assignees).map((assignee) => asString(assignee.login)).filter(Boolean),
    labels: asNodes(node.labels).map((label) => asString(label.name)).filter(Boolean),
    milestone: milestone || null,
    commentsCount: asNumber(asRecord(node.commentCount).totalCount),
    linkedPrs: parseLinkedPrs(node.closedByPullRequestsReferences),
    avatarUrls: avatarUrlsOf([node.author, ...asNodes(node.assignees)]),
    createdAt: asEpochMs(node.createdAt),
    updatedAt: asEpochMs(node.updatedAt)
  };
}

export function parseIssueSearch(json: string): {
  viewer: string | null;
  items: IssueSummary[];
  openCount: number | null;
  closedCount: number | null;
  truncated: boolean;
} {
  const { nodes, ...page } = parseSearchPage(json);
  const items: IssueSummary[] = [];
  for (const node of nodes) {
    const summary = parseIssueNode(node);
    if (summary) items.push(summary);
  }
  return { ...page, items };
}

export function parseCounts(json: string, n: number): Array<number | null> {
  const data = asRecord(parseJsonObject(json)?.data);
  return Array.from({ length: n }, (_, index) => {
    const count = asRecord(data[`c${index}`]).issueCount;
    return typeof count === "number" && Number.isFinite(count) ? count : null;
  });
}

function parseComments(value: unknown): IssueComment[] {
  return asNodes(value).map((comment) => ({
    author: asString(asRecord(comment.author).login) || GHOST_LOGIN,
    body: asString(comment.body),
    createdAt: asEpochMs(comment.createdAt)
  }));
}

export function parseIssueDetail(json: string, viewer: string): IssueDetail | null {
  const root = parseJsonObject(json);
  if (!root) return null;
  const issue = asRecord(asRecord(asRecord(root.data).repository).issue);
  if (Object.keys(issue).length === 0) return null;
  const summary = parseIssueNode(issue);
  if (!summary) return null;
  return { ...summary, body: asString(issue.body), comments: parseComments(issue.comments), viewerLogin: viewer };
}
