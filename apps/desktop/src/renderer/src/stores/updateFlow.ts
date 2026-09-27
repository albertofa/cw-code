import type { UpdateActionResult, UpdateState } from "../cw.js";
import { ipcErrorMessage } from "../components/ipcError.js";
import { useNotifs } from "../components/Notifications.js";
import { installTarget, matchesInstallTarget } from "../components/updateModel.js";
import { useAppStore } from "./appStore.js";
import { isShutdownFlowActive, runShutdownFlow } from "./shutdownFlow.js";

const INSTALL_FAILURE_TITLE = "cw-code could not install the update";

function notifyInstallFailure(message: string): void {
  useNotifs.getState().push({ id: `update-install:${message}`, kind: "error", title: INSTALL_FAILURE_TITLE, message, sticky: true });
}

async function releaseRestart(token: string): Promise<void> {
  try {
    await window.cw.shutdown.cancel(token);
  } catch (err) {
    useNotifs.getState().push({ kind: "error", title: "Could not restore cw-code services", message: ipcErrorMessage(err), sticky: true });
  }
}

async function freshUpdateState(): Promise<UpdateState> {
  const state = await window.cw.updates.getState();
  useAppStore.getState().applyUpdateState(state);
  return state;
}

function notifyUpdateChanged(): void {
  useNotifs.getState().push({
    kind: "info",
    title: "The update changed",
    message: "The downloaded update changed while cw-code was getting ready, so nothing was installed. cw-code is back to normal use."
  });
}

export async function restartToUpdate(): Promise<void> {
  const store = useAppStore.getState();
  if (store.updateRestartPending) return;
  if (isShutdownFlowActive()) {
    useNotifs.getState().push({ kind: "info", title: "Already closing", message: "A quit or restart is already in progress. Finish or cancel it first." });
    return;
  }
  const target = installTarget(store.updates);
  if (!target) return;
  useAppStore.setState({ updateRestartPending: true });
  try {
    try {
      if (!matchesInstallTarget(await freshUpdateState(), target)) {
        notifyUpdateChanged();
        return;
      }
    } catch (err) {
      notifyInstallFailure(ipcErrorMessage(err));
      return;
    }
    const flow = await runShutdownFlow("update");
    if (!flow) return;
    let fresh: UpdateState;
    try {
      fresh = await freshUpdateState();
    } catch (err) {
      await releaseRestart(flow.token);
      notifyInstallFailure(ipcErrorMessage(err));
      return;
    }
    if (!matchesInstallTarget(fresh, target)) {
      await releaseRestart(flow.token);
      notifyUpdateChanged();
      return;
    }
    let result: UpdateActionResult;
    try {
      result = await window.cw.updates.install({ ...target, token: flow.token });
    } catch (err) {
      await releaseRestart(flow.token);
      notifyInstallFailure(ipcErrorMessage(err));
      return;
    }
    useAppStore.getState().applyUpdateState(result.state);
    if (result.ok) return;
    if (result.code === "failed") notifyInstallFailure(result.message);
    else useNotifs.getState().push({ kind: "info", title: "The update was not installed", message: result.message });
  } finally {
    useAppStore.setState({ updateRestartPending: false });
  }
}

export async function runUpdateAction(action: () => Promise<UpdateActionResult>, title: string): Promise<void> {
  try {
    const result = await action();
    if (!result.ok && result.code !== "failed" && result.code !== "busy") {
      useNotifs.getState().push({ kind: "info", title, message: result.message });
    }
  } catch (err) {
    useNotifs.getState().push({ kind: "error", title, message: ipcErrorMessage(err) });
  }
}
