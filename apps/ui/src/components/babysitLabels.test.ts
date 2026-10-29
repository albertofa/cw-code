import { describe, expect, it } from "bun:test";
import type { PrWorkflow, SessionPrLink } from "@cw-code/contracts";
import { AUTO_FOLLOW_UP_LIMIT } from "@cw-code/shared/autoFollowUp";
import { babysitPhaseLabel, babysitStatusText, whyLinkedText } from "./babysitLabels.js";

function link(overrides: Partial<SessionPrLink> = {}): SessionPrLink {
  return {
    ref: { host: "github.com", owner: "acme", repo: "widgets", number: 42 },
    origin: "opened",
    lastSeenSha: "sha",
    lastSeenAt: 1_000,
    ...overrides
  };
}

const WORKFLOWS = [{ id: "review", label: "Review" }] as PrWorkflow[];

describe("whyLinkedText", () => {
  it("explains an opened link with and without the PR head", () => {
    expect(whyLinkedText(link(), { headRefName: "feature/widget" }, WORKFLOWS)).toBe("Branch feature/widget is the head of #42");
    expect(whyLinkedText(link(), null, WORKFLOWS)).toBe("This session's branch is the head of #42");
  });

  it("names the workflow that started the session, falling back to its id or a generic line", () => {
    expect(whyLinkedText(link({ origin: "workflow", workflowId: "review" }), null, WORKFLOWS)).toBe("Started from the Review workflow");
    expect(whyLinkedText(link({ origin: "workflow", workflowId: "gone" }), null, WORKFLOWS)).toBe("Started from the gone workflow");
    expect(whyLinkedText(link({ origin: "workflow" }), null, WORKFLOWS)).toBe("Started from a workflow on #42");
  });

  it("explains a manual link", () => {
    expect(whyLinkedText(link({ origin: "linked" }), null, WORKFLOWS)).toBe("Linked manually");
  });
});

describe("babysit labels", () => {
  it("labels each phase", () => {
    expect(babysitPhaseLabel("working")).toBe("Babysitting");
    expect(babysitPhaseLabel("paused")).toBe("Paused");
  });

  it("explains why babysitting is paused", () => {
    expect(babysitStatusText({ phase: { kind: "paused", reason: "limit" } })).toBe(`Paused after ${AUTO_FOLLOW_UP_LIMIT} automatic turns in a row`);
    expect(babysitStatusText({ phase: { kind: "paused", reason: "interrupted" } })).toBe("Paused because the turn was stopped");
  });
});
