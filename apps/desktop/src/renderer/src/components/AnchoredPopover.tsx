import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export interface AnchorRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function anchorRectOf(el: HTMLElement): AnchorRect {
  const r = el.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
}

export function AnchoredPopover({
  anchor,
  align = "left",
  label,
  onClose,
  className,
  children
}: {
  anchor: AnchorRect;
  align?: "left" | "right";
  label: string;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState(() => ({ left: anchor.left, top: anchor.bottom + 4 }));

  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const rawLeft = align === "right" ? anchor.right - rect.width : anchor.left;
    const left = Math.max(8, Math.min(rawLeft, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(anchor.bottom + 4, window.innerHeight - rect.height - 8));
    setPos({ left, top });
  }, [anchor, align]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="menu-backdrop" onClick={onClose} />
      <div
        ref={panelRef}
        className={`pr-inbox-popover${className ? ` ${className}` : ""}`}
        style={{ left: pos.left, top: pos.top }}
        aria-label={label}
      >
        {children}
      </div>
    </>
  );
}
