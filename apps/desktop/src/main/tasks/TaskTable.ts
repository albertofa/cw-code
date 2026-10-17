import { isDeepStrictEqual } from "node:util";
import type { TaskEndReason, TaskKind, TaskSnapshot, TaskState, ToolUsage } from "@cw-code/contracts";

export type TaskOutputSource = "summary" | "result" | "report";

export interface TaskRef {
  originId?: string;
  toolUseId?: string;
  cliTaskId?: string;
  runId?: string;
}

export interface RosterEntry {
  cliTaskId: string;
  runId?: string;
}

export type TaskObservation =
  | { kind: "call"; toolUseId: string; taskKind: TaskKind; background?: boolean; at: number }
  | { kind: "started"; ref: TaskRef; taskKind?: TaskKind; background?: boolean; at: number }
  | { kind: "background"; ref: TaskRef; background: boolean }
  | {
      kind: "ended";
      ref: TaskRef;
      state: Exclude<TaskState, "running">;
      reason: TaskEndReason;
      output?: string;
      outputSource?: TaskOutputSource;
      usage?: ToolUsage;
      at: number;
    }
  | { kind: "roster"; tasks: RosterEntry[] };

type StartedObservation = Extract<TaskObservation, { kind: "started" }>;
type EndedObservation = Extract<TaskObservation, { kind: "ended" }>;

interface TaskRun {
  toolUseId?: string;
  runId?: string;
  state: TaskState;
  endReason?: TaskEndReason;
  startedAt?: number;
  endedAt?: number;
  output?: string;
  outputSource?: TaskOutputSource;
  usage?: ToolUsage;
}

interface TaskRecord {
  id: string;
  kind: TaskKind;
  background: boolean | undefined;
  cliTaskId?: string;
  runs: TaskRun[];
}

const STATE_RANK: Record<TaskState, number> = {
  running: 0,
  unknown: 1,
  interrupted: 2,
  completed: 3,
  failed: 3,
  stopped: 3
};

const OUTPUT_SOURCE_RANK: Record<TaskOutputSource, number> = { summary: 0, result: 1, report: 2 };

const CLI_TASK_STATUS: Record<string, TaskState> = {
  pending: "running",
  running: "running",
  in_progress: "running",
  paused: "running",
  completed: "completed",
  success: "completed",
  failed: "failed",
  error: "failed",
  killed: "stopped",
  stopped: "stopped",
  cancelled: "stopped",
  canceled: "stopped",
  aborted: "stopped"
};

export function stateRank(state: TaskState): number {
  return STATE_RANK[state];
}

export function mapCliTaskStatus(status: string | undefined): TaskState | undefined {
  if (status === undefined) return undefined;
  const key = status.trim().toLowerCase();
  return Object.hasOwn(CLI_TASK_STATUS, key) ? CLI_TASK_STATUS[key] : undefined;
}

function currentRun(record: TaskRecord): TaskRun {
  return record.runs[record.runs.length - 1];
}

function lastSeen(run: TaskRun): number {
  return Math.max(run.endedAt ?? Number.NEGATIVE_INFINITY, run.startedAt ?? Number.NEGATIVE_INFINITY);
}

function dropOutput(run: TaskRun): void {
  delete run.output;
  delete run.outputSource;
}

function lookup(index: Map<string, TaskRecord>, key: string | undefined): TaskRecord | undefined {
  return key === undefined ? undefined : index.get(key);
}

function isLive(record: TaskRecord): boolean {
  return currentRun(record).state === "running" && record.background !== false;
}

function differs(own: string | undefined, other: string | undefined): boolean {
  return own !== undefined && other !== undefined && own !== other;
}

function isOtherRun(run: TaskRun, ref: TaskRef): boolean {
  return differs(run.toolUseId, ref.toolUseId) || differs(run.runId, ref.runId);
}

function latestRun(record: TaskRecord, matches: (run: TaskRun) => boolean): TaskRun | undefined {
  for (let i = record.runs.length - 1; i >= 0; i--) {
    if (matches(record.runs[i])) return record.runs[i];
  }
  return undefined;
}

function targetRun(record: TaskRecord, ref: TaskRef): TaskRun | undefined {
  const byRunId = ref.runId !== undefined ? latestRun(record, (run) => run.runId === ref.runId) : undefined;
  if (byRunId) return byRunId;
  const byToolUseId =
    ref.toolUseId !== undefined
      ? latestRun(record, (run) => run.toolUseId === ref.toolUseId && !differs(run.runId, ref.runId))
      : undefined;
  if (byToolUseId) return byToolUseId;
  const run = currentRun(record);
  return isOtherRun(run, ref) ? undefined : run;
}

function endRun(run: TaskRun, state: TaskState, reason: TaskEndReason, at: number | undefined): void {
  if (stateRank(state) < stateRank(run.state)) return;
  run.state = state;
  run.endReason = reason;
  const endedAt = run.endedAt ?? at;
  if (endedAt !== undefined) run.endedAt = endedAt;
}

function mergeOutput(run: TaskRun, output: string | undefined, source: TaskOutputSource = "summary"): void {
  if (!output) return;
  if (run.output !== undefined && OUTPUT_SOURCE_RANK[source] < OUTPUT_SOURCE_RANK[run.outputSource ?? "summary"]) return;
  run.output = output;
  run.outputSource = source;
}

function mergeUsage(run: TaskRun, usage: ToolUsage | undefined): void {
  if (usage === undefined) return;
  const merged: ToolUsage = { ...run.usage };
  for (const key of Object.keys(usage) as (keyof ToolUsage)[]) {
    const value = usage[key];
    if (value !== undefined) merged[key] = value;
  }
  if (Object.keys(merged).length > 0) run.usage = merged;
}

function applyEnded(run: TaskRun, obs: EndedObservation): void {
  endRun(run, obs.state, obs.reason, obs.at);
  mergeOutput(run, obs.output, obs.outputSource);
  mergeUsage(run, obs.usage);
}

function toSnapshot(record: TaskRecord): TaskSnapshot {
  const run = currentRun(record);
  return {
    id: record.id,
    ...(record.cliTaskId !== undefined ? { cliTaskId: record.cliTaskId } : {}),
    kind: record.kind,
    background: record.background === true,
    state: run.state,
    ...(run.endReason !== undefined ? { endReason: run.endReason } : {}),
    runCount: record.runs.length,
    ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
    ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
    ...(run.output !== undefined ? { output: run.output } : {}),
    ...(run.usage !== undefined ? { usage: { ...run.usage } } : {})
  };
}

export class TaskTable {
  private readonly records = new Map<string, TaskRecord>();
  private readonly byToolUseId = new Map<string, TaskRecord>();
  private readonly byCliTaskId = new Map<string, TaskRecord>();
  private roster = new Map<string, string | undefined>();
  private readonly everRostered = new Set<string>();

  apply(obs: TaskObservation): TaskSnapshot[] {
    switch (obs.kind) {
      case "call":
        return this.applyCall(obs.toolUseId, obs.taskKind, obs.background, obs.at);
      case "started":
        return this.applyStarted(obs);
      case "background":
        return this.applyBackground(obs.ref, obs.background);
      case "ended":
        return this.applyEndedObservation(obs);
      case "roster":
        return this.applyRoster(obs.tasks);
    }
  }

  closeOpen(
    state: "interrupted" | "unknown",
    reason: TaskEndReason,
    at: number,
    filter?: (task: TaskSnapshot) => boolean
  ): TaskSnapshot[] {
    const changed: TaskSnapshot[] = [];
    for (const record of this.records.values()) {
      const run = currentRun(record);
      if (run.state !== "running") continue;
      if (filter && !filter(toSnapshot(record))) continue;
      changed.push(...this.change(record, () => endRun(run, state, reason, at)));
    }
    return changed;
  }

  get(id: string): TaskSnapshot | undefined {
    const record = this.records.get(id);
    return record ? toSnapshot(record) : undefined;
  }

  resolve(ref: TaskRef): TaskSnapshot | undefined {
    const record = this.find(ref);
    return record ? toSnapshot(record) : undefined;
  }

  snapshots(): TaskSnapshot[] {
    return [...this.records.values()].map(toSnapshot);
  }

  liveCount(): number {
    let count = 0;
    let unmapped = 0;
    for (const [cliTaskId, runId] of this.roster) {
      const record = this.byCliTaskId.get(cliTaskId);
      if (!record) {
        unmapped += 1;
        count += 1;
        continue;
      }
      const run = currentRun(record);
      if (run.state === "running" || differs(run.runId, runId)) count += 1;
    }
    let unlinked = 0;
    for (const record of this.records.values()) {
      if (!isLive(record)) continue;
      if (record.cliTaskId === undefined) unlinked += 1;
      if (record.cliTaskId === undefined || !this.roster.has(record.cliTaskId)) count += 1;
    }
    return count - Math.min(unmapped, unlinked);
  }

  latestOutput(since = Number.NEGATIVE_INFINITY): string {
    let latest: TaskRun | undefined;
    for (const record of this.records.values()) {
      const run = currentRun(record);
      if (run.output === undefined || lastSeen(run) < since) continue;
      if (!latest || (run.startedAt ?? Number.NEGATIVE_INFINITY) >= (latest.startedAt ?? Number.NEGATIVE_INFINITY)) latest = run;
    }
    return latest?.output ?? "";
  }

  compact(before: number): string[] {
    const compacted: string[] = [];
    for (const record of this.records.values()) {
      const current = currentRun(record);
      for (const run of record.runs) if (run !== current) dropOutput(run);
      if (current.state === "running" || lastSeen(current) >= before) continue;
      dropOutput(current);
      compacted.push(record.id);
    }
    return compacted;
  }

  private applyCall(toolUseId: string, kind: TaskKind, background: boolean | undefined, at: number): TaskSnapshot[] {
    const existing = this.byToolUseId.get(toolUseId);
    if (existing) {
      return this.change(existing, () => {
        if (existing.background === undefined && background !== undefined) existing.background = background;
      });
    }
    return this.create(toolUseId, kind, background, { toolUseId, state: "running", startedAt: at });
  }

  private applyStarted(obs: StartedObservation): TaskSnapshot[] {
    const record = this.find(obs.ref);
    if (!record) {
      return this.createOrphan(obs.ref, obs.taskKind, obs.background, (run) => {
        run.startedAt = obs.at;
      });
    }
    return this.change(record, () => {
      this.link(record, obs.ref);
      const known = targetRun(record, obs.ref);
      if (known) {
        this.linkRun(record, known, obs.ref);
      } else {
        const toolUseId = obs.ref.toolUseId ?? currentRun(record).toolUseId;
        record.runs.push({
          ...(toolUseId !== undefined ? { toolUseId } : {}),
          ...(obs.ref.runId !== undefined ? { runId: obs.ref.runId } : {}),
          state: "running",
          startedAt: obs.at
        });
        if (toolUseId !== undefined) this.byToolUseId.set(toolUseId, record);
      }
      if (obs.taskKind !== undefined) record.kind = obs.taskKind;
      if (obs.background !== undefined) record.background = obs.background;
    });
  }

  private applyBackground(ref: TaskRef, background: boolean): TaskSnapshot[] {
    const record = this.find(ref);
    if (!record) return [];
    return this.change(record, () => {
      this.link(record, ref);
      record.background = background;
    });
  }

  private applyEndedObservation(obs: EndedObservation): TaskSnapshot[] {
    const record = this.find(obs.ref);
    if (!record) return this.createOrphan(obs.ref, undefined, undefined, (run) => applyEnded(run, obs));
    const run = targetRun(record, obs.ref);
    if (!run) return [];
    return this.change(record, () => {
      this.link(record, obs.ref);
      this.linkRun(record, run, obs.ref);
      applyEnded(run, obs);
    });
  }

  private applyRoster(tasks: RosterEntry[]): TaskSnapshot[] {
    this.roster = new Map(tasks.map((task) => [task.cliTaskId, task.runId]));
    const changed: TaskSnapshot[] = [];
    for (const record of this.records.values()) {
      const cliTaskId = record.cliTaskId;
      if (cliTaskId === undefined) continue;
      if (this.roster.has(cliTaskId)) {
        if (record.background !== true) changed.push(...this.change(record, () => (record.background = true)));
        continue;
      }
      const run = currentRun(record);
      if (run.state !== "running" || record.background !== true || !this.everRostered.has(cliTaskId)) continue;
      changed.push(...this.change(record, () => endRun(run, "unknown", "roster", undefined)));
    }
    for (const cliTaskId of this.roster.keys()) this.everRostered.add(cliTaskId);
    return changed;
  }

  private find(ref: TaskRef): TaskRecord | undefined {
    return lookup(this.records, ref.originId) ?? lookup(this.byToolUseId, ref.toolUseId) ?? lookup(this.byCliTaskId, ref.cliTaskId);
  }

  private link(record: TaskRecord, ref: TaskRef): void {
    if (record.cliTaskId !== undefined || ref.cliTaskId === undefined) return;
    record.cliTaskId = ref.cliTaskId;
    this.byCliTaskId.set(ref.cliTaskId, record);
  }

  private linkRun(record: TaskRecord, run: TaskRun, ref: TaskRef): void {
    if (run.toolUseId === undefined && ref.toolUseId !== undefined && !this.byToolUseId.has(ref.toolUseId)) {
      run.toolUseId = ref.toolUseId;
      this.byToolUseId.set(ref.toolUseId, record);
    }
    if (run.runId === undefined && ref.runId !== undefined) run.runId = ref.runId;
  }

  private createOrphan(
    ref: TaskRef,
    kind: TaskKind | undefined,
    background: boolean | undefined,
    observe: (run: TaskRun) => void
  ): TaskSnapshot[] {
    const id = ref.toolUseId ?? ref.cliTaskId;
    if (id === undefined || this.records.has(id)) return [];
    const run: TaskRun = {
      ...(ref.toolUseId !== undefined ? { toolUseId: ref.toolUseId } : {}),
      ...(ref.runId !== undefined ? { runId: ref.runId } : {}),
      state: "running"
    };
    observe(run);
    return this.create(id, kind ?? "agent", background, run, ref.cliTaskId);
  }

  private create(id: string, kind: TaskKind, background: boolean | undefined, run: TaskRun, cliTaskId?: string): TaskSnapshot[] {
    const record: TaskRecord = { id, kind, background, ...(cliTaskId !== undefined ? { cliTaskId } : {}), runs: [run] };
    this.records.set(id, record);
    if (run.toolUseId !== undefined) this.byToolUseId.set(run.toolUseId, record);
    if (cliTaskId !== undefined) this.byCliTaskId.set(cliTaskId, record);
    return [toSnapshot(record)];
  }

  private change(record: TaskRecord, mutate: () => void): TaskSnapshot[] {
    const before = toSnapshot(record);
    mutate();
    const after = toSnapshot(record);
    return isDeepStrictEqual(before, after) ? [] : [after];
  }
}
