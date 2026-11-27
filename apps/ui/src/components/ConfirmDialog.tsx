import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";

export interface ConfirmRequest {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}

interface PendingConfirm extends ConfirmRequest {
  resolve: (ok: boolean) => void;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function trapDialogTab(e: ReactKeyboardEvent<HTMLElement>, card: HTMLElement | null): void {
  if (e.key !== "Tab" || !card) return;
  const items = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE));
  const first = items[0];
  const last = items[items.length - 1];
  if (!first || !last) {
    e.preventDefault();
    return;
  }
  const active = document.activeElement;
  const inside = active instanceof Node && card.contains(active);
  if (e.shiftKey && (active === first || !inside)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !inside)) {
    e.preventDefault();
    first.focus();
  }
}

export function useModalFocus(cardRef: RefObject<HTMLElement | null>, initialRef: RefObject<HTMLElement | null>, onEscape: () => void): void {
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onEscape();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onEscape]);

  useEffect(() => {
    initialRef.current?.focus();
    const onFocusIn = (e: FocusEvent) => {
      const card = cardRef.current;
      if (card && e.target instanceof Node && !card.contains(e.target)) initialRef.current?.focus();
    };
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      if (opener?.isConnected) opener.focus();
    };
  }, [opener, cardRef, initialRef]);
}

export function ConfirmDialog({ request, onResolve }: { request: ConfirmRequest; onResolve: (ok: boolean) => void }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const cancel = useCallback(() => onResolve(false), [onResolve]);
  useModalFocus(cardRef, cancelRef, cancel);

  const trapTab = (e: ReactKeyboardEvent<HTMLDivElement>) => trapDialogTab(e, cardRef.current);

  return (
    <div className="confirm-backdrop" onClick={() => onResolve(false)}>
      <div
        ref={cardRef}
        className="confirm-card"
        role="alertdialog"
        aria-modal="true"
        aria-label={request.title}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={trapTab}
      >
        <div className="confirm-title">{request.title}</div>
        {request.message !== undefined && <div className="confirm-message">{request.message}</div>}
        <div className="confirm-actions">
          <button ref={cancelRef} type="button" className="btn" onClick={() => onResolve(false)}>
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
