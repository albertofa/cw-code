import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/** Shows the full text of a quoted excerpt or pasted block; closes on Escape, the X or a click outside. */
export function QuoteDialog({ text, onClose, title = "Quote" }: { text: string; onClose: () => void; title?: string }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [onClose, opener]);

  return createPortal(
    <div className="confirm-backdrop" onClick={onClose}>
      <div className="confirm-card quote-dialog" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="quote-dialog-head">
          <div className="confirm-title">{title}</div>
          <button ref={closeRef} type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="quote-dialog-body">{text}</div>
      </div>
    </div>,
    document.body
  );
}
