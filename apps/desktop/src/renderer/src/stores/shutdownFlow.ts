import type { ShutdownAssessment, ShutdownPrepareResult, ShutdownReason } from "../cw.js";
import { ipcErrorMessage } from "../components/ipcError.js";
import { useNotifs } from "../components/Notifications.js";
import { useAppStore, type ShutdownUiState } from "./appStore.js";
import { useEditorBuffers, type DirtyBuffer } from "./editorBuffers.js";

export const SHUTDOWN_PREPARE_TIMEOUT_MS = 10_000;
const WAIT_POLL_MS = 2_000;

interface ActiveFlow {
  reason: ShutdownReason;
  token: string | null;
  promise: Promise<{ token: string } | null>;
  resolve: (result: { token: string } | null) => void;
  stopWaiting: (() => void) | null;
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

function stopWaiting(): void {
  active?.stopWaiting?.();
  if (active) active.stopWaiting = null;
}

function finish(result: { token: string } | null, error?: { title: string; message: string }): void {
  const flow = active;
  if (!flow) return;
  stopWaiting();
  active = null;
  useAppStore.setState({ shutdown: null });
  if (error) useNotifs.getState().push({ kind: "error", title: error.title, message: error.message, sticky: true });
  flow.resolve(result);
}

export function isShutdownFlowActive(): boolean {
  return active !== null;
}

export function runShutdownFlow(reason: ShutdownReason): Promise<{ token: string } | null> {
  if (active) return active.promise;
  let resolve: (result: { token: string } | null) => void = () => {};
  const promise = new Promise<{ token: string } | null>((settle) => {
    resolve = settle;
  });
  active = { reason, token: null, promise, resolve, stopWaiting: null };
  void begin(active);
  return promise;
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
  if (stopActiveTurns && (result.ok || result.code === "timeout")) {
    useAppStore.getState().markTurnsInterrupted(assessment.activeTurns.map((turn) => turn.sessionId));
  }
  if (active !== flow) {
    if (result.ok || result.code === "timeout") void window.cw.shutdown.cancel(result.token).catch(() => {});
    return;
  }
  if (result.ok) {
    finish({ token: result.token });
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

export async function refreshShutdownAssessment(): Promise<void> {
  const flow = active;
  let assessment: ShutdownAssessment;
  try {
    assessment = await window.cw.shutdown.assess();
  } catch {
    return;
  }
  const current = ui();
  if (active !== flow || !flow || !current || (current.phase !== "review" && current.phase !== "waiting")) return;
  const dirty = useEditorBuffers.getState().dirty();
  patchUi({ assessment, dirty });
  if (current.phase === "waiting" && assessment.activeTurns.length === 0) {
    stopWaiting();
    if (dirty.length === 0) await prepare(flow, assessment, false);
    else patchUi({ phase: "review" });
  }
}

export function shutdownWait(): void {
  const flow = active;
  if (!flow || ui()?.phase !== "review") return;
  patchUi({ phase: "waiting", error: null });
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (state.busyTurns !== previous.busyTurns) void refreshShutdownAssessment();
  });
  const timer = window.setInterval(() => void refreshShutdownAssessment(), WAIT_POLL_MS);
  flow.stopWaiting = () => {
    unsubscribe();
    window.clearInterval(timer);
  };
  void refreshShutdownAssessment();
}

export function shutdownStopWaiting(): void {
  if (ui()?.phase !== "waiting") return;
  stopWaiting();
  patchUi({ phase: "review" });
}

export async function shutdownProceed(): Promise<void> {
  const flow = active;
  const current = ui();
  if (!flow || !current || current.phase !== "review" || current.dirty.length > 0) return;
  await prepare(flow, current.assessment, current.assessment.activeTurns.length > 0);
}

async function saveBuffer(buffer: DirtyBuffer): Promise<void> {
  await window.cw.saveFile(buffer.sessionId, buffer.path, buffer.content);
  useEditorBuffers.getState().markSaved(buffer.key, buffer.content);
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
    if (result.ok) finish({ token: result.token });
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

export async function handleQuitRequest(): Promise<void> {
  if (active) {
    await refreshShutdownAssessment();
    return;
  }
  const result = await runShutdownFlow("quit");
  if (!result) return;
  const committed = await window.cw.shutdown.quit(result.token);
  if (!committed.ok) useNotifs.getState().push({ kind: "error", title: "cw-code did not quit", message: committed.message, sticky: true });
}
