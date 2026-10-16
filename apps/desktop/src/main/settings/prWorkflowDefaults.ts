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
      target: "pr",
      suggestWhen: ["conflicts"],
      workspace: "worktree",
      harness: { driver: null, model: "", effort: null, permissionMode: null },
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
      target: "pr",
      suggestWhen: ["checks-failing"],
      workspace: "linked",
      harness: { driver: null, model: "", effort: null, permissionMode: null },
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
      target: "pr",
      suggestWhen: ["changes-requested"],
      workspace: "linked",
      harness: { driver: null, model: "", effort: null, permissionMode: null },
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
      target: "pr",
      suggestWhen: ["review-requested"],
      workspace: "checkout",
      harness: { driver: null, model: "", effort: null, permissionMode: null },
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
      target: "pr",
      suggestWhen: ["author"],
      workspace: "linked",
      harness: { driver: null, model: "", effort: null, permissionMode: null },
      startPrompt: `You own PR #{{pr.number}} on {{pr.head}}. Take it to mergeable:
- failing checks: read logs (\`gh run view --log-failed\`), fix, commit
- review comments: apply or explain, one commit per thread
Push after each green local run. Never force-push without asking.
{{attribution}}`,
      updatePrompt: `PR #{{pr.number}} update since your last turn:
{{pr.delta}}

Handle it with the same rules as before.`
    },
    {
      id: "implement",
      label: "Implement",
      description: "Plan, implement on a branch, test, and open a pull request.",
      icon: "sparkle",
      builtIn: true,
      enabled: true,
      target: "issue",
      suggestWhen: ["issue-assigned"],
      workspace: "worktree",
      harness: { driver: null, model: "", effort: null, permissionMode: null },
      startPrompt: `Implement {{issue.repo}}#{{issue.number}} "{{issue.title}}".

{{issue.body}}

Recent discussion:
{{issue.comments}}

Plan first, then implement on this branch, run typecheck and tests, and open a pull request that references #{{issue.number}}.
{{attribution}}`,
      updatePrompt: `Issue #{{issue.number}} has new activity since your last turn:
{{issue.delta}}`
    },
    {
      id: "investigate",
      label: "Investigate",
      description: "Find the root cause and report it with evidence.",
      icon: "eye",
      builtIn: true,
      enabled: true,
      target: "issue",
      suggestWhen: ["issue-bug"],
      workspace: "checkout",
      harness: { driver: null, model: "", effort: null, permissionMode: null },
      startPrompt: `Investigate {{issue.repo}}#{{issue.number}} "{{issue.title}}".

{{issue.body}}

{{issue.comments}}

Find the root cause and report it with file:line evidence. Do not change code unless asked.`,
      updatePrompt: `Issue #{{issue.number}} changed:
{{issue.delta}}`
    },
    {
      id: "triage",
      label: "Triage",
      description: "Suggest labels, severity, duplicates and the next step.",
      icon: "message",
      builtIn: true,
      enabled: true,
      target: "issue",
      suggestWhen: [],
      workspace: "checkout",
      harness: { driver: null, model: "", effort: null, permissionMode: null },
      startPrompt: `Triage {{issue.repo}}#{{issue.number}} "{{issue.title}}" (labels: {{issue.labels}}).

{{issue.body}}

Suggest labels, severity, likely duplicates and the next step. Report in chat only.`,
      updatePrompt: `Issue #{{issue.number}} changed:
{{issue.delta}}`
    },
    {
      id: "investigate-run",
      label: "Investigate run",
      description: "Read the failed jobs, reproduce locally and propose a fix.",
      icon: "wrench",
      builtIn: true,
      enabled: true,
      target: "run",
      suggestWhen: ["run-failed"],
      workspace: "worktree",
      harness: { driver: null, model: "", effort: null, permissionMode: null },
      startPrompt: `{{run.workflow}} #{{run.number}} failed on {{run.branch}} at {{run.sha}} ({{run.event}}).
Failed jobs: {{run.failedJobs}}
{{run.failedLogs}}

Reproduce locally, find the root cause and propose a fix.`,
      updatePrompt: `{{run.workflow}} #{{run.number}} changed: {{run.failedJobs}}`
    }
  ];
}
