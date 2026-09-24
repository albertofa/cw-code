import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { RefreshCw } from "lucide-react";
import type { DriverName, Project, Session } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { useUsageStore } from "../stores/usageStore.js";
import { DriverIcon } from "./DriverIcon.js";
import { UsagePlanCard } from "./UsagePlanCard.js";
import { MenuSelect } from "./MenuSelect.js";
import { useNow, formatCostUsd } from "./usageFormat.js";
import { formatRelativeAge } from "./prInboxModel.js";
import { formatTokensShort } from "./subagents.js";
import { harnessLabel } from "./toolTabs.js";
import {
  byModel,
  dailyByDriver,
  localDayString,
  topSessions,
  totals,
  type DailyDriverPoint,
  type ModelUsageRow,
  type SessionUsageRow,
  type UsageMetric
} from "./usageModel.js";

const DRIVERS: DriverName[] = ["claude", "codex", "opencode"];
const STACK_ORDER: DriverName[] = ["codex", "claude", "opencode"];
const RANGE_OPTIONS = [7, 30, 90];
const POLL_MS = 5 * 60 * 1000;
const LEDGER_DEBOUNCE_MS = 2000;

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(v)));
  return Math.ceil(v / e / 2) * 2 * e;
}

function sinceDayFor(days: number, today: Date): string {
  const since = new Date(today);
  since.setDate(since.getDate() - (days - 1));
  return localDayString(since);
}

function DailyChart({ points, visibleDrivers, days }: { points: DailyDriverPoint[]; visibleDrivers: DriverName[]; days: number }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(900);
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(Math.max(320, w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const H = 200;
  const padL = 44;
  const padB = 20;
  const padT = 6;
  const plotH = H - padB - padT;
  const totalsPerDay = points.map((p) => visibleDrivers.reduce((sum, d) => sum + p.byDriver[d], 0));
  const yMax = niceMax(Math.max(1, ...totalsPerDay));
  const y = (v: number) => padT + plotH - (v / yMax) * plotH;
  const bw = points.length > 0 ? (width - padL) / points.length : width - padL;
  const barW = Math.max(3, Math.min(22, bw - (days > 60 ? 1.5 : 4)));

  const gridLines = [0, 0.5, 1].map((f) => {
    const yy = y(yMax * f);
    return (
      <g key={f}>
        <line className="usage-grid" x1={padL} x2={width} y1={yy} y2={yy} />
        <text className="usage-axis" x={padL - 8} y={yy + 3} textAnchor="end">
          {formatTokensShort(Math.round(yMax * f))}
        </text>
      </g>
    );
  });

  const bars = points.map((p, i) => {
    const x = padL + i * bw + (bw - barW) / 2;
    let acc = 0;
    const present = STACK_ORDER.filter((d) => visibleDrivers.includes(d) && p.byDriver[d] > 0);
    const segs = present.map((d, j) => {
      const v = p.byDriver[d];
      const top = y(acc + v);
      const bottom = y(acc) - (j > 0 ? 2 : 0);
      const height = Math.max(0, bottom - top);
      const last = j === present.length - 1;
      acc += v;
      if (last) {
        const r = Math.min(3, height);
        const path = `M${x},${bottom} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${bottom} Z`;
        return <path key={d} className={`usage-barseg usage-barseg-${d}`} d={path} />;
      }
      return <rect key={d} className={`usage-barseg usage-barseg-${d}`} x={x} y={top} width={barW} height={height} />;
    });
    return (
      <g
        key={p.day}
        className="usage-col"
        onMouseMove={(e: ReactMouseEvent) => setHover({ index: i, x: e.clientX, y: e.clientY })}
        onMouseLeave={() => setHover((h) => (h?.index === i ? null : h))}
      >
        <rect x={padL + i * bw} y={padT} width={bw} height={plotH} fill="transparent" />
        {segs}
      </g>
    );
  });

  const tickIdx =
    days <= 7
      ? points.map((_, i) => i)
      : [0, Math.floor((points.length - 1) / 4), Math.floor((points.length - 1) / 2), Math.floor((3 * (points.length - 1)) / 4), points.length - 1];
  const uniqueTicks = [...new Set(tickIdx)];
  const ticks = uniqueTicks.map((i, n) => {
    const x = padL + i * bw + bw / 2;
    const anchor = n === uniqueTicks.length - 1 && days > 7 ? "end" : "middle";
    const day = points[i]?.day;
    if (!day) return null;
    const label = new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return (
      <text key={i} className="usage-axis" x={anchor === "end" ? width - 2 : x} y={H - 4} textAnchor={anchor}>
        {label}
      </text>
    );
  });

  const hoverPoint = hover ? points[hover.index] : null;
  const hasData = totalsPerDay.some((t) => t > 0);

  if (!hasData) {
    return (
      <div className="usage-plot" ref={hostRef}>
        <div className="usage-empty-chart">No turns recorded in the last {days} days.</div>
      </div>
    );
  }

  return (
    <div className="usage-plot" ref={hostRef}>
      <svg width={width} height={H} viewBox={`0 0 ${width} ${H}`}>
        {gridLines}
        {ticks}
        {bars}
      </svg>
      {hoverPoint && hover && (
        <div className="usage-tip" style={{ left: Math.min(window.innerWidth - 220, hover.x + 14), top: hover.y + 14 }}>
          <b>{new Date(`${hoverPoint.day}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</b>
          {[...STACK_ORDER]
            .reverse()
            .filter((d) => visibleDrivers.includes(d))
            .map((d) => (
              <div className="usage-tip-row" key={d}>
                <span>
                  <i className={`usage-sw usage-sw-${d}`} />
                  {harnessLabel(d)}
                </span>
                <span>{formatTokensShort(hoverPoint.byDriver[d])}</span>
              </div>
            ))}
          <div className="usage-tip-row usage-tip-total">
            <span>Total · {hoverPoint.turns} turns</span>
            <span>{formatTokensShort(visibleDrivers.reduce((sum, d) => sum + hoverPoint.byDriver[d], 0))}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function ModelBars({ rows }: { rows: ModelUsageRow[] }) {
  const [hoverId, setHoverId] = useState<string | null>(null);
  const max = Math.max(1, ...rows.map((r) => r.value));

  return (
    <div className="usage-hbars">
      {rows.map((r) => (
        <div
          key={r.id}
          className={`usage-hb${r.driver ? "" : " usage-hb-other"}`}
          onMouseEnter={() => setHoverId(r.id)}
          onMouseLeave={() => setHoverId((id) => (id === r.id ? null : id))}
        >
          <div className="usage-hb-nm">
            {r.driver ? <DriverIcon driver={r.driver} size={14} /> : <span className="usage-hb-dot">…</span>}
            <span>{r.id}</span>
          </div>
          <div className="usage-hb-tr">
            <i style={{ width: `${(r.value / max) * 100}%`, background: r.driver ? `var(--${r.driver})` : "var(--muted)" }} />
          </div>
          <div className="usage-hb-v">{formatTokensShort(r.value)}</div>
          {hoverId === r.id && (
            <div className="usage-tip usage-tip-anchored">
              <b>{r.id}</b>
              <div className="usage-tip-row">
                <span>Input + cache write + output</span>
                <span>{formatTokensShort(r.freshTokens)}</span>
              </div>
              <div className="usage-tip-row">
                <span>Cache read</span>
                <span>{formatTokensShort(r.cacheReadTokens)}</span>
              </div>
              <div className="usage-tip-row">
                <span>Turns</span>
                <span>{r.turns}</span>
              </div>
              <div className="usage-tip-row">
                <span>API-eq. cost</span>
                <span>{formatCostUsd(r.costUsd)}</span>
              </div>
            </div>
          )}
        </div>
      ))}
      {rows.length === 0 && <div className="usage-empty-line">No token activity in range.</div>}
    </div>
  );
}

function SessionsTable({
  rows,
  sessionById,
  projectById
}: {
  rows: SessionUsageRow[];
  sessionById: Map<string, Session>;
  projectById: Map<string, Project>;
}) {
  return (
    <div className="usage-tbl">
      <h3>Top sessions</h3>
      <table>
        <thead>
          <tr>
            <th>Session</th>
            <th className="num">Turns</th>
            <th className="num">Tokens</th>
            <th className="num">API-eq. cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const session = sessionById.get(r.sessionId);
            const project = projectById.get(session?.projectId ?? r.projectId);
            return (
              <tr key={r.sessionId}>
                <td>
                  <div className="usage-cell">
                    <DriverIcon driver={r.driver} size={14} />
                    <div>
                      <div className="usage-cell-title">{session?.title ?? "Deleted session"}</div>
                      {project && <div className="usage-cell-sub">{project.name}</div>}
                    </div>
                  </div>
                </td>
                <td className="num">{r.turns}</td>
                <td className="num">{formatTokensShort(r.tokens)}</td>
                <td className="num">{formatCostUsd(r.costUsd)}</td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="usage-empty-line">
                No sessions in range.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function UsageView({ onOpenSettings }: { onOpenSettings?: (harness: DriverName) => void }) {
  const projects = useAppStore((s) => s.projects);
  const sessionsByProject = useAppStore((s) => s.sessionsByProject);
  const accountByDriver = useUsageStore((s) => s.accountByDriver);
  const accountLoading = useUsageStore((s) => s.accountLoading);
  const accountError = useUsageStore((s) => s.accountError);
  const accountFetchedAt = useUsageStore((s) => s.accountFetchedAt);
  const ledgerRows = useUsageStore((s) => s.ledgerRows);
  const ledgerError = useUsageStore((s) => s.ledgerError);
  const refreshAccount = useUsageStore((s) => s.refreshAccount);
  const loadLedger = useUsageStore((s) => s.loadLedger);
  const now = useNow();

  const [days, setDays] = useState(30);
  const [metric, setMetric] = useState<UsageMetric>("all");
  const [driverFilter, setDriverFilter] = useState<DriverName | "all">("all");
  const [projectFilter, setProjectFilter] = useState<string>("all");

  const daysRef = useRef(days);
  daysRef.current = days;
  const debounceRef = useRef<number | null>(null);

  useEffect(() => {
    void refreshAccount(DRIVERS, false);
    const interval = window.setInterval(() => void refreshAccount(DRIVERS, false), POLL_MS);
    return () => window.clearInterval(interval);
  }, [refreshAccount]);

  useEffect(() => {
    void loadLedger({ sinceDay: sinceDayFor(days, new Date()) });
  }, [days, loadLedger]);

  useEffect(() => {
    const off = window.cw.onTurnEvent((msg) => {
      if (msg.event.type !== "turn.done") return;
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = null;
        void loadLedger({ sinceDay: sinceDayFor(daysRef.current, new Date()) });
      }, LEDGER_DEBOUNCE_MS);
    });
    return () => {
      off();
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    };
  }, [loadLedger]);

  const sessionById = useMemo(() => {
    const map = new Map<string, Session>();
    for (const list of Object.values(sessionsByProject)) for (const s of list) map.set(s.id, s);
    return map;
  }, [sessionsByProject]);
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);

  const filteredRows = useMemo(
    () =>
      ledgerRows.filter(
        (r) => (driverFilter === "all" || r.driver === driverFilter) && (projectFilter === "all" || r.projectId === projectFilter)
      ),
    [ledgerRows, driverFilter, projectFilter]
  );

  const visibleDrivers = driverFilter === "all" ? DRIVERS : [driverFilter];
  const dailyPoints = useMemo(() => dailyByDriver(filteredRows, days, metric, new Date()), [filteredRows, days, metric]);
  const modelRows = useMemo(() => byModel(filteredRows, metric, 6), [filteredRows, metric]);
  const sessionRows = useMemo(() => topSessions(filteredRows, 5), [filteredRows]);
  const totalsRow = useMemo(() => totals(filteredRows), [filteredRows]);

  const refreshAll = () => {
    void refreshAccount(DRIVERS, true);
    void loadLedger({ sinceDay: sinceDayFor(days, new Date()) });
  };

  const chartTotal = dailyPoints.reduce((sum, p) => sum + visibleDrivers.reduce((s, d) => s + p.byDriver[d], 0), 0);
  const modelsTotal = modelRows.reduce((sum, r) => sum + r.value, 0);

  return (
    <div className="thread-col usage-view">
      <div className="usage-head">
        <div>
          <h1>Usage</h1>
          <p>Plan limits come from each CLI&apos;s own account data. Token totals are counted by cw-code from the turns it ran on this device.</p>
        </div>
        <div className="usage-head-right">
          <span>{accountFetchedAt ? `Updated ${formatRelativeAge(accountFetchedAt, now)} ago` : "Not refreshed yet"}</span>
          <button className="icon-btn" title="Refresh all" aria-label="Refresh all" onClick={refreshAll}>
            <RefreshCw size={16} />
          </button>
        </div>
      </div>
      <div className="usage-scroll">
        <div>
          <div className="usage-sec-h">
            <h2>Plan limits</h2>
            <span>Account-wide, includes usage from other devices and apps</span>
          </div>
          <div className="usage-cards">
            {DRIVERS.map((d) => (
              <UsagePlanCard
                key={d}
                driver={d}
                snapshot={accountByDriver[d]}
                loading={!!accountLoading[d]}
                error={accountError[d]}
                onOpenSettings={onOpenSettings}
              />
            ))}
          </div>
        </div>

        <div>
          <div className="usage-sec-h">
            <h2>Token consumption</h2>
            <span>Tracked by cw-code · this device only</span>
          </div>
          <div className="usage-filters">
            <div className="usage-seg">
              {RANGE_OPTIONS.map((d) => (
                <button key={d} className={days === d ? "on" : ""} onClick={() => setDays(d)}>
                  {d} days
                </button>
              ))}
            </div>
            <div className="usage-seg">
              <button className={metric === "all" ? "on" : ""} onClick={() => setMetric("all")}>
                All tokens
              </button>
              <button className={metric === "fresh" ? "on" : ""} onClick={() => setMetric("fresh")}>
                Excluding cache reads
              </button>
            </div>
            <button className={`usage-chip${driverFilter === "all" ? " on" : ""}`} onClick={() => setDriverFilter("all")}>
              All harnesses
            </button>
            {DRIVERS.map((d) => (
              <button key={d} className={`usage-chip${driverFilter === d ? " on" : ""}`} onClick={() => setDriverFilter(d)}>
                <DriverIcon driver={d} size={13} />
                {harnessLabel(d)}
              </button>
            ))}
            <div className="usage-select">
              <MenuSelect
                label="Project"
                value={projectFilter}
                display={projectFilter === "all" ? "All projects" : (projectById.get(projectFilter)?.name ?? "All projects")}
                options={[{ id: "all", label: "All projects" }, ...projects.map((p) => ({ id: p.id, label: p.name }))]}
                onPick={setProjectFilter}
              />
            </div>
          </div>

          {ledgerError ? (
            <div className="usage-empty-block">
              <div className="usage-empty">
                <span className="usage-empty-ic" aria-hidden="true">
                  !
                </span>
                <div>
                  <b>Couldn&apos;t load token usage</b>
                  {ledgerError}
                </div>
              </div>
              <button className="usage-btn" onClick={() => void loadLedger({ sinceDay: sinceDayFor(days, new Date()) })}>
                Retry
              </button>
            </div>
          ) : (
            <>
              <div className="usage-tiles">
                <div className="usage-tile">
                  <div className="usage-tile-k">Total tokens</div>
                  <div className="usage-tile-n">{formatTokensShort(totalsRow.totalTokens)}</div>
                  <div className="usage-tile-s">
                    {totalsRow.turns} turns · {totalsRow.sessions} sessions
                  </div>
                </div>
                <div className="usage-tile">
                  <div className="usage-tile-k">Input</div>
                  <div className="usage-tile-n">{formatTokensShort(totalsRow.inputTokens)}</div>
                  <div className="usage-tile-s">new, uncached</div>
                </div>
                <div className="usage-tile">
                  <div className="usage-tile-k">Cache read</div>
                  <div className="usage-tile-n">{formatTokensShort(totalsRow.cacheReadTokens)}</div>
                  <div className="usage-tile-s">reused context</div>
                </div>
                <div className="usage-tile">
                  <div className="usage-tile-k">Output</div>
                  <div className="usage-tile-n">{formatTokensShort(totalsRow.outputTokens)}</div>
                  <div className="usage-tile-s">incl. reasoning</div>
                </div>
                <div className="usage-tile">
                  <div className="usage-tile-k">API-equivalent cost</div>
                  <div className="usage-tile-n">{formatCostUsd(totalsRow.costUsd)}</div>
                  <div className="usage-tile-s">
                    {totalsRow.unpricedTurns > 0
                      ? `excludes ${totalsRow.unpricedTurns} unpriced turn${totalsRow.unpricedTurns === 1 ? "" : "s"}`
                      : "list prices · not billed on a plan"}
                  </div>
                </div>
              </div>

              <div className="usage-chart usage-chart-wide">
                <div className="usage-chart-head">
                  Tokens per day
                  <span className="usage-legend-inline">
                    {DRIVERS.map((d) => (
                      <span key={d} className={visibleDrivers.includes(d) ? "" : "off"}>
                        <i className={`usage-sw usage-sw-${d}`} />
                        {harnessLabel(d)}
                      </span>
                    ))}
                  </span>
                  <span className="usage-chart-tot">{formatTokensShort(chartTotal)}</span>
                </div>
                <div className="usage-chart-sub">
                  {driverFilter === "all" ? "All harnesses" : harnessLabel(driverFilter)} ·{" "}
                  {metric === "all" ? "input + cache + output" : "input + output, cache reads excluded"} · last {days} days
                </div>
                <DailyChart points={dailyPoints} visibleDrivers={visibleDrivers} days={days} />
              </div>

              <div className="usage-tables">
                <SessionsTable rows={sessionRows} sessionById={sessionById} projectById={projectById} />
                <div className="usage-chart">
                  <div className="usage-chart-head">
                    Tokens by model
                    <span className="usage-chart-tot">{formatTokensShort(modelsTotal)}</span>
                  </div>
                  <div className="usage-chart-sub">
                    {driverFilter === "all" ? "All harnesses" : harnessLabel(driverFilter)} · ranked · top 6, the rest folded into Other
                  </div>
                  <ModelBars rows={modelRows} />
                </div>
              </div>
            </>
          )}

          <div className="usage-foot-note">
            API-equivalent cost is what the same tokens would cost at API list prices. Subscription plans aren&apos;t billed this way, so treat it
            as a rough guide to relative weight.
          </div>
        </div>
      </div>
    </div>
  );
}
