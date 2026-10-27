import type { ShutdownAssessment, ShutdownPrepareResult, ShutdownReason, ShutdownScope } from "../cw.js";
import { ipcErrorMessage } from "../components/ipcError.js";
import { useNotifs } from "../components/Notifications.js";
import { useAppStore, type ShutdownUiState } from "./appStore.js";
import { useEditorBuffers, type DirtyBuffer } from "./editorBuffers.js";

export const SHUTDOWN_PREPARE_TIMEOUT_MS = 10_000;

const NOTHING_TO_STOP: ShutdownAssessment = { activeTurns: [], backgroundTasks: 0, terminals: [] };

type FlowOutcome = { scope: "server"; token: string } | { scope: "window" };

interface ActiveFlow {
  reason: ShutdownReason;
  scope: ShutdownScope;
  token: string | null;
  promise: Promise<FlowOutcome | null>;
  serverResult: Promise<{ token: string } | null>;
  resolve: (result: FlowOutcome | null) => void;
  preparing: boolean;
}

let active: ActiveFlow | null = null;

export function hasShutdownBlockers(assessment: ShutdownAssessment, dirty: DirtyBuffer[]): boolean {
  return assessment.activeTurns.length > 0 || assessment.terminals.length > 0 || dirty.length > 0;
}

function actionLabel(reason: ShutdownReason): string {
  return reason === "update" ? "Restart" : "Quit";
}

function ui(): ShutdownUiState | null {
  return useAppStore.getState().shutdown;
}

function patchUi(patch: Partial<ShutdownUiState>): void {
  const current = ui();
  if (current) useAppStore.setState({ shutdown: { ...current, ...patch } });
}

function showUi(state: ShutdownUiState): void {
  useAppStore.setState({ shutdown: state });
}

function finish(result: FlowOutcome | null, error?: { title: string; message: string }): void {
  const flow = active;
  if (!flow) return;
  active = null;
  useAppStore.setState({ shutdown: null });
  if (error) useNotifs.getState().push({ kind: "error", title: error.title, message: error.message, sticky: true });
  flow.resolve(result);
}

export function isShutdownFlowActive(): boolean {
  return active !== null;
}

function startFlow(reason: ShutdownReason, scope: ShutdownScope): ActiveFlow {
  if (active) return active;
  let resolve: (result: FlowOutcome | null) => void = () => {};
  const promise = new Promise<FlowOutcome | null>((settle) => {
    resolve = settle;
  });
  const serverResult = promise.then((outcome) => (outcome?.scope === "server" ? { token: outcome.token } : null));
  const flow: ActiveFlow = { reason, scope, token: null, promise, serverResult, resolve, preparing: false };
  active = flow;
  void (scope === "window" ? beginWindow(flow) : begin(flow));
  return flow;
}

export function runShutdownFlow(reason: ShutdownReason): Promise<{ token: string } | null> {
  return startFlow(reason, "server").serverResult;
}

function beginWindow(flow: ActiveFlow): void {
  window.cw.shutdown.acknowledge();
  const dirty = useEditorBuffers.getState().dirty();
  if (dirty.length === 0) {
    finish({ scope: "window" });
    return;
  }
  showUi({ reason: flow.reason, assessment: NOTHING_TO_STOP, dirty, phase: "review", error: null, pending: [] });
}

async function begin(flow: ActiveFlow): Promise<void> {
  let assessment: ShutdownAssessment;
  try {
    assessment = await window.cw.shutdown.assess();
  } catch (err) {
    finish(null, { title: `${actionLabel(flow.reason)} cancelled`, message: ipcErrorMessage(err) });
    return;
  }
  if (active !== flow) return;
  const dirty = useEditorBuffers.getState().dirty();
  if (!hasShutdownBlockers(assessment, dirty)) {
    await prepare(flow, assessment, false);
    return;
  }
  showUi({ reason: flow.reason, assessment, dirty, phase: "review", error: null, pending: [] });
}

async function prepare(flow: ActiveFlow, assessment: ShutdownAssessment, stopActiveTurns: boolean): Promise<void> {
  if (flow.scope === "window") {
    finish({ scope: "window" });
    return;
  }
  if (flow.preparing) return;
  flow.preparing = true;
  try {
    await prepareOnce(flow, assessment, stopActiveTurns);
  } finally {
    flow.preparing = false;
  }
}

async function prepareOnce(flow: ActiveFlow, assessment: ShutdownAssessment, stopActiveTurns: boolean): Promise<void> {
  patchUi({ phase: "preparing", error: null });
  let result: ShutdownPrepareResult;
  try {
    result = await window.cw.shutdown.prepare({
      reason: flow.reason,
      stopActiveTurns,
      approvedTurnIds: stopActiveTurns ? assessment.activeTurns.map((turn) => turn.turnId) : [],
      timeoutMs: SHUTDOWN_PREPARE_TIMEOUT_MS
    });
  } catch (err) {
    if (active !== flow) return;
    showUi({
      reason: flow.reason,
      assessment,
      dirty: useEditorBuffers.getState().dirty(),
      phase: "review",
      error: `Could not prepare to ${actionLabel(flow.reason).toLowerCase()}: ${ipcErrorMessage(err)}`,
      pending: []
    });
    return;
  }
  if (active !== flow) {
    if (result.ok || result.code === "timeout") void window.cw.shutdown.cancel(result.token).catch(() => {});
    return;
  }
  if (result.ok) {
    finish({ scope: "server", token: result.token });
    return;
  }
  if (result.code === "blocked") {
    showUi({
      reason: flow.reason,
      assessment: result.assessment,
      dirty: useEditorBuffers.getState().dirty(),
      phase: "review",
      error: "New work started in the meantime and was not stopped. Review it before continuing.",
      pending: []
    });
    return;
  }
  if (result.code === "timeout") {
    flow.token = result.token;
    showUi({
      reason: flow.reason,
      assessment: ui()?.assessment ?? assessment,
      dirty: [],
      phase: "timeout",
      error: null,
      pending: result.pending
    });
    return;
  }
  finish(null, { title: `${actionLabel(flow.reason)} cancelled`, message: "Another quit or restart is already in progress." });
}

export async function applyShutdownAssessment(assessment: ShutdownAssessment): Promise<void> {
  const flow = active;
  const current = ui();
  if (!flow || flow.scope === "window" || !current || (current.phase !== "review" && current.phase !== "waiting")) return;
  const dirty = useEditorBuffers.getState().dirty();
  patchUi({ assessment, dirty });
  if (current.phase !== "waiting" || assessment.activeTurns.length > 0 || flow.preparing) return;
  if (dirty.length === 0) await prepare(flow, assessment, false);
  else patchUi({ phase: "review" });
}

export async function refreshShutdownAssessment(): Promise<void> {
  try {
    await applyShutdownAssessment(await window.cw.shutdown.assess());
  } catch {
    return;
  }
}

export function shutdownWait(): void {
  if (ui()?.phase !== "review") return;
  patchUi({ phase: "waiting", error: null });
}

export function shutdownStopWaiting(): void {
  if (ui()?.phase !== "waiting") return;
  patchUi({ phase: "review" });
}

export async function shutdownProceed(): Promise<void> {
  const flow = active;
  const current = ui();
  if (!flow || !current || current.phase !== "review" || current.dirty.length > 0) return;
  await prepare(flow, current.assessment, current.assessment.activeTurns.length > 0);
}

async function saveBuffer(buffer: DirtyBuffer): Promise<void> {
  const current = useEditorBuffers.getState().buffers[buffer.key];
  if (current?.conflict) throw new Error(`${buffer.path} changed on disk; reload it or keep your edits in the Files tab first`);
  const stat = await window.cw.writeFileGuarded(buffer.sessionId, buffer.path, buffer.content, current?.mtimeMs);
  useEditorBuffers.getState().markSaved(buffer.key, buffer.content, stat.mtimeMs);
}

async function saveBuffers(buffers: DirtyBuffer[]): Promise<void> {
  const flow = active;
  if (!flow || ui()?.phase !== "review") return;
  patchUi({ phase: "saving", error: null });
  for (const buffer of buffers) {
    try {
      await saveBuffer(buffer);
    } catch (err) {
      if (active !== flow) return;
      finish(null, {
        title: `${actionLabel(flow.reason)} cancelled`,
        message: `Could not save ${buffer.path}: ${ipcErrorMessage(err)}. Nothing was stopped.`
      });
      return;
    }
  }
  if (active !== flow) return;
  patchUi({ phase: "review", dirty: useEditorBuffers.getState().dirty() });
}

export function shutdownSaveAll(): Promise<void> {
  return saveBuffers(ui()?.dirty ?? []);
}

export function shutdownSaveFile(key: string): Promise<void> {
  return saveBuffers((ui()?.dirty ?? []).filter((buffer) => buffer.key === key));
}

function discardBuffers(keys: string[]): void {
  if (ui()?.phase !== "review") return;
  const buffers = useEditorBuffers.getState();
  for (const key of keys) buffers.discard(key);
  patchUi({ dirty: useEditorBuffers.getState().dirty() });
}

export function shutdownDiscardAll(): void {
  discardBuffers((ui()?.dirty ?? []).map((buffer) => buffer.key));
}

export function shutdownDiscardFile(key: string): void {
  discardBuffers([key]);
}

export async function shutdownForce(): Promise<void> {
  const flow = active;
  if (!flow || !flow.token || ui()?.phase !== "timeout") return;
  patchUi({ phase: "preparing", error: null });
  try {
    const result = await window.cw.shutdown.force(flow.token);
    if (active !== flow) return;
    if (result.ok) finish({ scope: "server", token: result.token });
    else patchUi({ phase: "timeout", error: "Some processes could not be stopped." });
  } catch (err) {
    if (active !== flow) return;
    finish(null, { title: `${actionLabel(flow.reason)} cancelled`, message: ipcErrorMessage(err) });
  }
}

export async function shutdownCancel(): Promise<void> {
  const flow = active;
  if (!flow) return;
  const token = flow.token;
  finish(null);
  if (!token) return;
  try {
    await window.cw.shutdown.cancel(token);
  } catch (err) {
    useNotifs.getState().push({ kind: "error", title: "Could not restore cw-code services", message: ipcErrorMessage(err), sticky: true });
  }
}

export function handleShutdownExpired(): void {
  const flow = active;
  if (!flow || !flow.token) return;
  flow.token = null;
  finish(null, {
    title: `${actionLabel(flow.reason)} cancelled`,
    message: "cw-code waited too long for a decision and restored normal use. Start again when you are ready."
  });
}

export async function handleQuitRequest(scope: ShutdownScope = "server"): Promise<void> {
  if (active) {
    await refreshShutdownAssessment();
    return;
  }
  const outcome = await startFlow("quit", scope).promise;
  if (!outcome) return;
  if (outcome.scope === "window") {
    window.cw.shutdown.quitWindow();
    return;
  }
  const committed = await window.cw.shutdown.quit(outcome.token);
  if (!committed.ok) useNotifs.getState().push({ kind: "error", title: "cw-code did not quit", message: committed.message, sticky: true });
}
