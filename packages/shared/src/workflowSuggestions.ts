import type { PrSuggestCondition, PrSummary, PrWorkflow } from "@cw-code/contracts";

export function matchesCondition(pr: PrSummary, c: PrSuggestCondition): boolean {
  switch (c) {
    case "review-requested":
      return !pr.viewerIsAuthor && pr.reviewRequestedFromViewer;
    case "author":
      return pr.viewerIsAuthor;
    case "checks-failing":
      return pr.ci === "failing";
    case "changes-requested":
      return pr.review === "changes_requested";
    case "conflicts":
      return pr.mergeable === "CONFLICTING";
    case "bot-author":
      return pr.author.isBot;
    case "draft":
      return pr.isDraft;
    default:
      return false;
  }
}

export function suggestedWorkflow(pr: PrSummary, workflows: PrWorkflow[]): PrWorkflow | null {
  return workflows.find((w) => w.enabled && w.suggestWhen.some((c) => matchesCondition(pr, c))) ?? null;
}
