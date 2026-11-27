import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { clampWidth } from "./gitGlassLayout.js";
import { startWidthDrag } from "./usePersistedState.js";

const STEP = 16;
const BIG_STEP = 64;

export function ResizeHandle({
  className,
  label,
  value,
  min,
  max,
  direction,
  onChange,
  onReset
}: {
  className: string;
  label: string;
  value: number;
  min: number;
  max: number;
  direction: 1 | -1;
  onChange: (width: number, commit: boolean) => void;
  onReset: () => void;
}) {
  const begin = (event: ReactPointerEvent<HTMLElement>): void =>
    startWidthDrag(
      event,
      value,
      direction,
      (next) => onChange(next, false),
      (next) => onChange(next, true)
    );

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const step = event.shiftKey ? BIG_STEP : STEP;
    let next: number | null = null;
    if (event.key === "ArrowRight") next = value + step * direction;
    else if (event.key === "ArrowLeft") next = value - step * direction;
    else if (event.key === "Home") next = direction === 1 ? min : max;
    else if (event.key === "End") next = direction === 1 ? max : min;
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    const clamped = clampWidth(next, min, max);
    if (clamped !== value) onChange(clamped, true);
  };

  return (
    <span
      className={className}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      title="Drag or use the arrow keys to resize (double-click resets)"
      onPointerDown={begin}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}
