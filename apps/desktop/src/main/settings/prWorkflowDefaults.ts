import type { PrWorkflow } from "@cw-code/contracts";

export function defaultPrWorkflows(): PrWorkflow[] {
  return [
    {
      id: "resolve-conflicts",
      label: "Resolve conflicts",
      description: "Merge base into head, resolve, re-run checks.",
      icon: "merge",
      builtIn: true,
      enabled: true,
      suggestWhen: ["conflicts"],
      workspace: "worktree",
      startPrompt: `#{{pr.number}} ({{pr.head}}) conflicts with {{pr.base}}.
Merge {{pr.base}} into the head branch, keep both intents, run typecheck and tests, summarize each conflict.`,
      updatePrompt: `{{pr.base}} moved again. Re-check conflicts on #{{pr.number}}.`
    },
    {
      id: "fix-ci",
      label: "Fix CI",
      description: "Pull failing logs, reproduce, fix the root cause.",
      icon: "wrench",
      builtIn: true,
      enabled: true,
      suggestWhen: ["checks-failing"],
      workspace: "linked",
      startPrompt: `Checks failing on #{{pr.number}} at {{pr.sha}}: {{checks.summary}}
{{checks.failedLogs}}

Reproduce locally, fix the root cause, commit on {{pr.head}}.`,
      updatePrompt: `Checks changed on #{{pr.number}}:
{{checks.summary}}`
    },
    {
      id: "address-feedback",
      label: "Address feedback",
      description: "Work through unresolved threads, one commit per thread.",
      icon: "message",
      builtIn: true,
      enabled: true,
      suggestWhen: ["changes-requested"],
      workspace: "linked",
      startPrompt: `PR #{{pr.number}} has unresolved threads:
{{pr.unresolvedThreads}}

Apply each change or explain why not. One commit per thread on {{pr.head}}.`,
      updatePrompt: `New review activity on #{{pr.number}}:
{{pr.delta}}`
    },
    {
      id: "review",
      label: "Review",
      description: "Read the diff, run what matters, report findings in chat.",
      icon: "eye",
      builtIn: true,
      enabled: true,
      suggestWhen: ["review-requested"],
      workspace: "checkout",
      startPrompt: `Review pull request #{{pr.number}} "{{pr.title}}" in {{pr.repo}}.
Base {{pr.base}} ← head {{pr.head}} @ {{pr.sha}}

{{pr.body}}
{{pr.threads}}

Read the diff with \`gh pr diff {{pr.number}}\`. Report findings as Critical / Important / Minor with file:line.
{{attribution}}`,
      updatePrompt: `PR #{{pr.number}} changed since your last look at {{session.lastSeenSha}}:
{{pr.delta}}

Re-review only \`git diff {{session.lastSeenSha}}..{{pr.sha}}\` and say whether your earlier findings are resolved.`
    },
    {
      id: "babysit",
      label: "Babysit",
      description: "Own the PR until merge: fix CI, handle comments, commit and push.",
      icon: "activity",
      builtIn: true,
      enabled: true,
      suggestWhen: ["author"],
      workspace: "linked",
      startPrompt: `You own PR #{{pr.number}} on {{pr.head}}. Take it to mergeable:
- failing checks: read logs (\`gh run view --log-failed\`), fix, commit
- review comments: apply or explain, one commit per thread
Push after each green local run. Never force-push without asking.
{{attribution}}`,
      updatePrompt: `PR #{{pr.number}} update since your last turn:
{{pr.delta}}

Handle it with the same rules as before.`
    }
  ];
}
