import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Bot, ChartColumn, ChevronDown, Gauge, GitBranch, ListChecks, Sparkles } from "lucide-react";
import type { SessionPrItem } from "@cw-code/contracts";
import type { AccountUsageOk, DriverName, TodoItem } from "../cw.js";
import { useAppStore, type ChatMessage } from "../stores/appStore.js";
import { usePrStore } from "../stores/prStore.js";
import { useSkillsStore } from "../stores/skillsStore.js";
import { DriverIcon } from "./DriverIcon.js";
import { PrChipBadge } from "./PrChipBadge.js";
import { PlanMeters } from "./PlanMeters.js";
import { unavailableTitle } from "./UsagePlanCard.js";
import { formatRelativeAge } from "./prInboxModel.js";
import { collectSubagents, formatTokensShort, isSubagentMessage, subagentStateLabel } from "./subagents.js";
import { formatDuration } from "./toolSummaries.js";
import { harnessLabel } from "./toolTabs.js";
import { formatCostUsd, useNow } from "./usageFormat.js";
import { useGitStatus } from "./useGit.js";
import { useThreadEntry, useThreadItemsSelect } from "./useThread.js";
import { useAccountUsage } from "./useUsage.js";
import { findSession, sameItems } from "../server/sidebarData.js";
import "./sessionOverview.css";

const EMPTY_TODOS: TodoItem[] = [];
const EMPTY_PR_ITEMS: SessionPrItem[] = [];

function subagentItems(items: ChatMessage[]): ChatMessage[] {
  return items.filter(isSubagentMessage);
}

function Section({
  icon,
  title,
  summary,
  defaultOpen = true,
  open: controlledOpen,
  onOpenChange,
  children
}: {
  icon: ReactNode;
  title: string;
  summary?: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const open = controlledOpen ?? localOpen;
  const setOpen = (next: boolean) => {
    setLocalOpen(next);
    onOpenChange?.(next);
  };
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
  const usage = useThreadEntry(sessionId, "usage");
  const context = usage?.context ?? null;
  const meter = usage?.meter ?? null;
  const percentLabel = meter ? Math.round(meter.percent * 100) : null;
  return (
    <Section icon={<Gauge size={14} aria-hidden="true" />} title="Context" summary={percentLabel === null ? undefined : <span className="mono">{percentLabel}%</span>}>
      {context && meter ? (
        <>
          <div className={`ov-ctx${meter.severity ? ` ${meter.severity}` : ""}`}>
            <div className="usage-track thin">
              <i style={{ width: `${percentLabel}%` }} />
            </div>
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

function PullRequestRow({ sessionId, githubError }: { sessionId: string; githubError: string | null }) {
  const items = useThreadEntry(sessionId, "prItems") ?? EMPTY_PR_ITEMS;
  const openPr = usePrStore((s) => s.openPr);
  if (items.length > 0) {
    return (
      <>
        {items.map((item) => (
          <Row key={item.key} label={item.source === "linked" ? "Linked PR" : "Branch PR"}>
            <button type="button" className="ov-pr" onClick={() => openPr(item.ref)} title={`Open ${item.chip.title}`}>
              <PrChipBadge chip={item.chip} />
              <span className="ov-pr-reason">{item.chip.reason}</span>
            </button>
          </Row>
        ))}
      </>
    );
  }
  return (
    <Row label="Pull request">
      {githubError ? (
        <span className="ov-error" title={githubError}>
          GitHub unavailable
        </span>
      ) : (
        <span className="ov-faint">None</span>
      )}
    </Row>
  );
}

function WorkspaceSection({ sessionId }: { sessionId: string }) {
  const status = useGitStatus(sessionId);
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
          <PullRequestRow sessionId={sessionId} githubError={status.githubError} />
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
  const sessionTotals = useThreadEntry(sessionId, "usageTotals");
  const totalsError = useThreadEntry(sessionId, "usageTotalsError");
  const lastTurn = useThreadEntry(sessionId, "usage")?.lastTurn ?? null;

  return (
    <Section icon={<ChartColumn size={14} aria-hidden="true" />} title="This session">
      {totalsError ? (
        <Note tone="error">Couldn&apos;t load usage: {totalsError}</Note>
      ) : sessionTotals === undefined ? (
        <Note>Loading…</Note>
      ) : sessionTotals === null ? (
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
                ? `${formatTokensShort(lastTurn.tokens)} tok${lastTurn.durationMs !== null ? ` · ${formatDuration(lastTurn.durationMs)}` : ""}`
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

function PlanLimits({ driver, state, stale }: { driver: DriverName; state: AccountUsageOk; stale: boolean }) {
  if (state.windows.length === 0 && state.balances.length === 0) {
    return <Note>No plan limits reported for {harnessLabel(driver)}.</Note>;
  }
  return (
    <div className={stale ? "usage-stale" : undefined}>
      <PlanMeters state={state} />
    </div>
  );
}

function PlanSection({ driver }: { driver: DriverName }) {
  const [open, setOpen] = useState(true);
  const { snapshot: account, loading, error } = useAccountUsage(driver, open);
  const snapshot = account ?? undefined;
  const openUsage = usePrStore((s) => s.openUsage);
  const now = useNow();

  const state = snapshot?.state;
  const shownState = state?.status === "ok" ? state : state?.status === "error" ? snapshot?.lastGood?.state : undefined;
  const fetchedAt = state?.status === "error" ? snapshot?.lastGood?.fetchedAt : snapshot?.fetchedAt;
  const title = shownState?.plan ? `Plan · ${shownState.plan}` : "Plan";

  return (
    <Section
      icon={<DriverIcon driver={driver} size={14} />}
      title={title}
      open={open}
      onOpenChange={setOpen}
      summary={fetchedAt !== undefined ? <span className="ov-faint">Updated {formatRelativeAge(fetchedAt, now)} ago</span> : undefined}
    >
      <div className={`ov-plan ${driver}`}>
        {shownState && <PlanLimits driver={driver} state={shownState} stale={state?.status === "error"} />}
        {state?.status === "unavailable" ? (
          <Note>
            <b>{unavailableTitle(state.reason)}</b> {state.message}
          </Note>
        ) : state?.status === "error" ? (
          <Note tone="error">
            <b>
              {snapshot?.lastGood
                ? `Couldn't refresh · showing data from ${formatRelativeAge(snapshot.lastGood.fetchedAt, now)} ago`
                : "Couldn't load plan limits"}
            </b>{" "}
            {state.message}
          </Note>
        ) : snapshot ? (
          error && <Note tone="error">Couldn&apos;t refresh plan limits: {error}</Note>
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
  const todos = useThreadEntry(sessionId, "todos") ?? EMPTY_TODOS;
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

function SubagentsSection({ sessionId }: { sessionId: string }) {
  const subagentMessages = useThreadItemsSelect(sessionId, subagentItems, sameItems);
  const agents = useMemo(() => collectSubagents(subagentMessages), [subagentMessages]);
  return (
    <Section icon={<Bot size={14} aria-hidden="true" />} title="Subagents" summary={agents.length > 0 ? agents.length : undefined}>
      {agents.length === 0 ? (
        <Note>No subagents in this session.</Note>
      ) : (
        agents.map((agent) => {
          const duration = agent.durationMs === undefined ? undefined : formatDuration(agent.durationMs);
          return (
            <div className="ov-kv" key={agent.id}>
              <span title={agent.name}>{agent.name}</span>
              <b className={`ov-agent ${agent.status}`} title={subagentStateLabel(agent.status)}>
                <span className={`suba-dot ${agent.status}`} aria-hidden="true" />
                {subagentStateLabel(agent.status, duration, "compact")}
              </b>
            </div>
          );
        })
      )}
    </Section>
  );
}

function SkillsSection({ driver }: { driver: DriverName }) {
  const items = useSkillsStore((s) => s.items);
  const status = useSkillsStore((s) => s.status);
  const error = useSkillsStore((s) => s.error);
  const load = useSkillsStore((s) => s.load);

  useEffect(() => {
    if (status === "idle") void load();
  }, [status, load]);

  const enabled = items.filter((item) => item.enabled[driver]).length;
  const hasData = status === "ready" || items.length > 0;
  const failed = status === "error";
  return (
    <Section
      icon={<Sparkles size={14} aria-hidden="true" />}
      title="Skills"
      summary={hasData ? `${enabled} enabled` : undefined}
      defaultOpen={false}
    >
      {hasData ? (
        items.length === 0 ? (
          <Note>No skills found.</Note>
        ) : (
          <Note>
            {enabled} of {items.length} skills enabled for {harnessLabel(driver)}.
          </Note>
        )
      ) : (
        !failed && <Note>Loading skills…</Note>
      )}
      {failed && (
        <>
          <Note tone="error">Couldn&apos;t load skills{error ? `: ${error}` : "."}</Note>
          <button type="button" className="usage-btn" onClick={() => void load()}>
            Retry
          </button>
        </>
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
