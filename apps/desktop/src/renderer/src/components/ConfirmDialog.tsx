import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export interface ConfirmRequest {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}

interface PendingConfirm extends ConfirmRequest {
  resolve: (ok: boolean) => void;
}

export function ConfirmDialog({ request, onResolve }: { request: ConfirmRequest; onResolve: (ok: boolean) => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onResolve(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onResolve]);

  return (
    <div className="confirm-backdrop" onClick={() => onResolve(false)}>
      <div
        className="confirm-card"
        role="alertdialog"
        aria-modal="true"
        aria-label={request.title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="confirm-title">{request.title}</div>
        {request.message !== undefined && <div className="confirm-message">{request.message}</div>}
        <div className="confirm-actions">
          <button type="button" className="btn" onClick={() => onResolve(false)} autoFocus>
            Cancel
          </button>
          <button
            type="button"
            className={request.danger ? "btn btn-danger-solid" : "btn btn-primary"}
            onClick={() => onResolve(true)}
          >
            {request.confirmLabel ?? "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function useConfirm(): {
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  confirmOpen: boolean;
  dialog: ReactNode;
} {
  const [pending, setPending] = useState<ConfirmRequest | null>(null);
  const resolveRef = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback(
    (request: ConfirmRequest) =>
      new Promise<boolean>((resolve) => {
        resolveRef.current = resolve;
        setPending(request);
      }),
    []
  );

  const resolve = useCallback((ok: boolean) => {
    const pendingResolve = resolveRef.current;
    resolveRef.current = null;
    setPending(null);
    pendingResolve?.(ok);
  }, []);

  return {
    confirm,
    confirmOpen: pending !== null,
    dialog: pending ? <ConfirmDialog request={pending} onResolve={resolve} /> : null
  };
}
