import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Bot, ChartColumn, ChevronDown, Gauge, GitBranch, ListChecks, RefreshCw, Sparkles } from "lucide-react";
import type { DriverName, GitPullRequest, TodoItem } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { usePrStore } from "../stores/prStore.js";
import { useSkillsStore } from "../stores/skillsStore.js";
import { useUsageStore } from "../stores/usageStore.js";
import { DriverIcon } from "./DriverIcon.js";
import { PrChipBadge } from "./PrChipBadge.js";
import { UsageBalanceRow } from "./UsageBalanceRow.js";
import { UsageMeter } from "./UsageMeter.js";
import { unavailableTitle } from "./UsagePlanCard.js";
import { prChip } from "./prChip.js";
import { formatRelativeAge } from "./prInboxModel.js";
import { displayChip } from "./sessionPrLinks.js";
import { collectSubagents, formatTokensShort } from "./subagents.js";
import { formatDuration } from "./toolSummaries.js";
import { harnessLabel } from "./toolTabs.js";
import { findSession, useLinkedPrs } from "./useLinkedPr.js";
import { formatCostUsd, useNow } from "./usageFormat.js";
import { totals } from "./usageModel.js";
import "./sessionOverview.css";

const EMPTY_TODOS: TodoItem[] = [];

function Section({
  icon,
  title,
  summary,
  defaultOpen = true,
  children
}: {
  icon: ReactNode;
  title: string;
  summary?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`ov-sec${open ? "" : " closed"}`} aria-label={title}>
      <div className="ov-h">
        <button type="button" className="ov-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          {icon}
          <b>{title}</b>
          <span className="ov-chev" aria-hidden="true">
            <ChevronDown size={12} />
          </span>
        </button>
        {summary !== undefined && <span className="ov-r">{summary}</span>}
      </div>
      {open && <div className="ov-body">{children}</div>}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ov-kv">
      <span>{label}</span>
      <b>{children}</b>
    </div>
  );
}

function Note({ children, tone }: { children: ReactNode; tone?: "error" }) {
  return <div className={`ov-note${tone === "error" ? " error" : ""}`}>{children}</div>;
}

function ContextSection({ sessionId }: { sessionId: string }) {
  const context = useAppStore((s) => s.turnUsageBySession[sessionId]?.context);
  const percent = context ? Math.min(1, context.usedTokens / Math.max(1, context.windowTokens)) : null;
  const severity = percent === null ? "" : percent >= 0.95 ? " danger" : percent >= 0.8 ? " warn" : "";
  return (
    <Section icon={<Gauge size={14} aria-hidden="true" />} title="Context" summary={percent === null ? undefined : <span className="mono">{Math.round(percent * 100)}%</span>}>
      {context && percent !== null ? (
        <>
          <div className={`ov-track${severity}`}>
            <i style={{ width: `${Math.round(percent * 100)}%` }} />
          </div>
          <Row label="Window">
            <span className="mono">
              {formatTokensShort(context.usedTokens)} / {formatTokensShort(context.windowTokens)}
            </span>
          </Row>
        </>
      ) : (
        <Note>No context data yet.</Note>
      )}
    </Section>
  );
}

function ChangesSummary({ dirtyCount, addedLines, deletedLines }: { dirtyCount: number; addedLines: number; deletedLines: number }) {
  if (dirtyCount === 0) return <>No changes</>;
  return (
    <>
      {dirtyCount} {dirtyCount === 1 ? "file" : "files"} · <span className="add">+{addedLines}</span>{" "}
      <span className="del">{"−"}{deletedLines}</span>
    </>
  );
}

function PullRequestRow({ sessionId, gitPr }: { sessionId: string; gitPr: GitPullRequest | null }) {
  const { items, summaryByKey } = useLinkedPrs(sessionId);
  const openPr = usePrStore((s) => s.openPr);
  if (items.length > 0) {
    return (
      <>
        {items.map((item) => {
          const chip = displayChip(item.link, summaryByKey, gitPr);
          return (
            <Row key={item.key} label="Pull request">
              <button type="button" className="ov-pr" onClick={() => openPr(item.link.ref)} title={`Open ${chip.title}`}>
                <PrChipBadge chip={chip} />
                <span className="ov-pr-reason">{chip.reason}</span>
              </button>
            </Row>
          );
        })}
      </>
    );
  }
  const chip = prChip({ pr: null, git: gitPr });
  return (
    <Row label="Pull request">
      {chip ? (
        <>
          <PrChipBadge chip={chip} />
          <span className="ov-pr-reason">{chip.reason}</span>
        </>
      ) : (
        <span className="ov-faint">None</span>
      )}
    </Row>
  );
}

function WorkspaceSection({ sessionId }: { sessionId: string }) {
  const status = useAppStore((s) => s.gitStatusBySession[sessionId]);
  const summary = status?.available ? (status.isWorktree ? "worktree" : "checkout") : undefined;
  return (
    <Section icon={<GitBranch size={14} aria-hidden="true" />} title="Workspace" summary={summary}>
      {status?.available ? (
        <>
          <Row label="Branch">
            <span className="mono">{status.branch || "detached"}</span>
          </Row>
          <Row label={status.isWorktree ? "Worktree" : "Checkout"}>
            <span className="mono">{status.isWorktree ? status.worktreeName : "Project folder"}</span>
          </Row>
          <Row label="Changes">
            <ChangesSummary dirtyCount={status.dirtyCount} addedLines={status.addedLines} deletedLines={status.deletedLines} />
          </Row>
          <PullRequestRow sessionId={sessionId} gitPr={status.pullRequest} />
        </>
      ) : status ? (
        <Note>Not a git repository.</Note>
      ) : (
        <Note>Git status not loaded yet.</Note>
      )}
    </Section>
  );
}

function SessionUsageSection({ sessionId }: { sessionId: string }) {
  const rows = useUsageStore((s) => s.sessionRowsById[sessionId]);
  const loading = useUsageStore((s) => !!s.sessionLoading[sessionId]);
  const error = useUsageStore((s) => s.sessionError[sessionId]);
  const ensureSessionRows = useUsageStore((s) => s.ensureSessionRows);
  const lastTurn = useAppStore((s) => s.turnUsageBySession[sessionId]?.lastTurn);
  const sessionTotals = useMemo(() => totals(rows ?? []), [rows]);

  useEffect(() => {
    void ensureSessionRows(sessionId);
    return window.cw.onTurnEvent((msg) => {
      if (msg.event.type !== "turn.done" || msg.sessionId !== sessionId) return;
      void ensureSessionRows(sessionId);
    });
  }, [sessionId, ensureSessionRows]);

  const lastTurnTokens = lastTurn
    ? lastTurn.inputTokens + lastTurn.cacheReadTokens + lastTurn.cacheWriteTokens + lastTurn.outputTokens
    : 0;

  const refresh = (
    <button
      type="button"
      className="ov-icon-btn"
      onClick={() => void ensureSessionRows(sessionId)}
      disabled={loading}
      title="Refresh session usage"
      aria-label="Refresh session usage"
    >
      <RefreshCw size={12} className={loading ? "ov-spin" : undefined} aria-hidden="true" />
    </button>
  );

  return (
    <Section icon={<ChartColumn size={14} aria-hidden="true" />} title="This session" summary={refresh}>
      {!rows && loading ? (
        <Note>Loading…</Note>
      ) : !rows && error ? (
        <Note tone="error">Couldn&apos;t load session usage: {error}</Note>
      ) : rows && rows.length === 0 ? (
        <Note>No usage recorded yet.</Note>
      ) : (
        <>
          <Row label="Turns">{sessionTotals.turns}</Row>
          <Row label="Input">
            <span className="mono">{formatTokensShort(sessionTotals.inputTokens)}</span>
          </Row>
          <Row label="Cache read">
            <span className="mono">{formatTokensShort(sessionTotals.cacheReadTokens)}</span>
          </Row>
          <Row label="Output">
            <span className="mono">{formatTokensShort(sessionTotals.outputTokens)}</span>
          </Row>
          <Row label="Last turn">
            <span className="mono">
              {lastTurn
                ? `${formatTokensShort(lastTurnTokens)} tok${lastTurn.durationMs !== undefined ? ` · ${formatDuration(lastTurn.durationMs)}` : ""}`
                : "—"}
            </span>
          </Row>
          <Row label="API-equivalent cost">
            <span className="mono">{formatCostUsd(sessionTotals.costUsd)}</span>
          </Row>
        </>
      )}
    </Section>
  );
}

function PlanSection({ driver }: { driver: DriverName }) {
  const snapshot = useUsageStore((s) => s.accountByDriver[driver]);
  const loading = useUsageStore((s) => !!s.accountLoading[driver]);
  const error = useUsageStore((s) => s.accountError[driver]);
  const refreshAccount = useUsageStore((s) => s.refreshAccount);
  const openUsage = usePrStore((s) => s.openUsage);
  const now = useNow();

  useEffect(() => {
    void refreshAccount([driver], false);
  }, [driver, refreshAccount]);

  const state = snapshot?.state;
  const plan = state?.status === "ok" ? state.plan : undefined;
  const title = plan ? `Plan · ${plan}` : "Plan";

  return (
    <Section
      icon={<DriverIcon driver={driver} size={14} />}
      title={title}
      summary={snapshot ? <span className="ov-faint">Updated {formatRelativeAge(snapshot.fetchedAt, now)} ago</span> : undefined}
    >
      <div className={`ov-plan ${driver}`}>
        {state?.status === "ok" ? (
          state.windows.length === 0 && state.balances.length === 0 ? (
            <Note>No plan limits reported for {harnessLabel(driver)}.</Note>
          ) : (
            <>
              <div className="usage-meters">
                {state.windows.map((w) => (
                  <UsageMeter key={w.id} window={w} />
                ))}
              </div>
              {state.balances.map((b) => (
                <UsageBalanceRow key={b.id} balance={b} />
              ))}
            </>
          )
        ) : state?.status === "unavailable" ? (
          <Note>
            <b>{unavailableTitle(state.reason)}</b> {state.message}
          </Note>
        ) : state?.status === "error" ? (
          <Note tone="error">
            <b>Couldn&apos;t load plan limits</b> {state.message}
          </Note>
        ) : error ? (
          <Note tone="error">Couldn&apos;t load plan limits: {error}</Note>
        ) : loading ? (
          <Note>Loading plan limits…</Note>
        ) : (
          <Note>Plan limits not loaded yet.</Note>
        )}
        <button type="button" className="ov-link" onClick={openUsage}>
          Open usage →
        </button>
      </div>
    </Section>
  );
}

function TodosSection({ sessionId }: { sessionId: string }) {
  const todos = useAppStore((s) => s.todosBySession[sessionId] ?? EMPTY_TODOS);
  const total = todos.length;
  const done = todos.filter((t) => t.status === "completed").length;
  const current = todos.find((t) => t.status === "in_progress") ?? todos.find((t) => t.status === "pending");
  return (
    <Section icon={<ListChecks size={14} aria-hidden="true" />} title="Todos" summary={total > 0 ? `${done}/${total}` : undefined}>
      {total === 0 ? (
        <Note>No todos yet.</Note>
      ) : current ? (
        <div className="ov-todo">
          <span className={`todo-state ${current.status}`}>
            {current.status === "in_progress" && <span className="pulse" aria-hidden="true" />}
          </span>
          <span className="ov-todo-text" title={current.content}>
            {current.content}
          </span>
        </div>
      ) : (
        <Note>All todos done.</Note>
      )}
    </Section>
  );
}

function subagentStatusLabel(status: "running" | "completed" | "error", durationMs: number | undefined): string {
  if (status === "running") return "Running";
  if (status === "error") return "Failed";
  return durationMs !== undefined ? `Done · ${formatDuration(durationMs)}` : "Done";
}

function SubagentsSection({ sessionId }: { sessionId: string }) {
  const messages = useAppStore((s) => s.messagesBySession[sessionId]);
  const agents = useMemo(() => collectSubagents(messages ?? []), [messages]);
  return (
    <Section icon={<Bot size={14} aria-hidden="true" />} title="Subagents" summary={agents.length > 0 ? agents.length : undefined}>
      {agents.length === 0 ? (
        <Note>No subagents in this session.</Note>
      ) : (
        agents.map((agent) => (
          <div className="ov-kv" key={agent.id}>
            <span title={agent.name}>{agent.name}</span>
            <b className={`ov-agent ${agent.status}`}>{subagentStatusLabel(agent.status, agent.durationMs)}</b>
          </div>
        ))
      )}
    </Section>
  );
}

function SkillsSection({ driver }: { driver: DriverName }) {
  const items = useSkillsStore((s) => s.items);
  const status = useSkillsStore((s) => s.status);
  const load = useSkillsStore((s) => s.load);

  useEffect(() => {
    if (status === "idle") void load();
  }, [status, load]);

  const enabled = items.filter((item) => item.enabled[driver]).length;
  const ready = status === "ready" || items.length > 0;
  return (
    <Section
      icon={<Sparkles size={14} aria-hidden="true" />}
      title="Skills"
      summary={ready ? `${enabled} enabled` : undefined}
      defaultOpen={false}
    >
      {ready ? (
        items.length === 0 ? (
          <Note>No skills found.</Note>
        ) : (
          <Note>
            {enabled} of {items.length} skills enabled for {harnessLabel(driver)}.
          </Note>
        )
      ) : status === "error" ? (
        <Note tone="error">Couldn&apos;t load skills.</Note>
      ) : (
        <Note>Loading skills…</Note>
      )}
    </Section>
  );
}

export function SessionOverview({ sessionId }: { sessionId: string }) {
  const driver = useAppStore((s) => findSession(s.sessionsByProject, sessionId)?.driver);
  return (
    <div className="session-overview" role="region" aria-label="Session overview">
      <ContextSection sessionId={sessionId} />
      <WorkspaceSection sessionId={sessionId} />
      <SessionUsageSection sessionId={sessionId} />
      {driver && <PlanSection driver={driver} />}
      <TodosSection sessionId={sessionId} />
      <SubagentsSection sessionId={sessionId} />
      {driver && <SkillsSection driver={driver} />}
    </div>
  );
}
