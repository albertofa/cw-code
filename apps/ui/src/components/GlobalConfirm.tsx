import { create } from "zustand";
import { ConfirmDialog, type ConfirmRequest } from "./ConfirmDialog.js";

interface PendingConfirm {
  request: ConfirmRequest;
  resolve: (ok: boolean) => void;
}

const useGlobalConfirm = create<{ pending: PendingConfirm | null }>(() => ({ pending: null }));

/** Asks for confirmation from code that has no component of its own (store actions, shared helpers). */
export function confirmGlobally(request: ConfirmRequest): Promise<boolean> {
  return new Promise((resolve) => {
    useGlobalConfirm.getState().pending?.resolve(false);
    useGlobalConfirm.setState({ pending: { request, resolve } });
  });
}

export function GlobalConfirmHost() {
  const pending = useGlobalConfirm((s) => s.pending);
  if (!pending) return null;
  return (
    <ConfirmDialog
      request={pending.request}
      onResolve={(ok) => {
        useGlobalConfirm.setState({ pending: null });
        pending.resolve(ok);
      }}
    />
  );
}
