import { useLayoutEffect, useState, type DependencyList, type RefObject } from "react";

export const POPOVER_GAP = 6;
export const POPOVER_MARGIN = 12;

export interface PopoverFitInput {
  anchorTop: number;
  anchorBottom: number;
  viewportHeight: number;
  /** Height the popover would take with no cap. */
  natural: number;
  preferUp: boolean;
  gap?: number;
  margin?: number;
}

export interface PopoverFit {
  up: boolean;
  /** Room on the chosen side; cap the popover to it so it scrolls inside instead of running off-window. */
  maxHeight: number;
}

/**
 * Keeps the preferred side while the popover fits there; otherwise opens on the roomier side.
 * Either way the height is capped to the room on the chosen side.
 */
export function fitPopover({ anchorTop, anchorBottom, viewportHeight, natural, preferUp, gap = POPOVER_GAP, margin = POPOVER_MARGIN }: PopoverFitInput): PopoverFit {
  const above = Math.max(0, Math.floor(anchorTop - gap - margin));
  const below = Math.max(0, Math.floor(viewportHeight - anchorBottom - gap - margin));
  const preferred = preferUp ? above : below;
  const other = preferUp ? below : above;
  const up = natural <= preferred || preferred >= other ? preferUp : !preferUp;
  return { up, maxHeight: up ? above : below };
}

/**
 * Measures an anchored popover after it renders and on window resize. `natural` reads the popover's
 * uncapped height (defaults to its scrollHeight). Returns null while closed or before the first measure.
 */
export function usePopoverFit(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  popRef: RefObject<HTMLElement | null>,
  preferUp: boolean,
  deps: DependencyList,
  natural: (pop: HTMLElement) => number = (pop) => pop.scrollHeight
): PopoverFit | null {
  const [fit, setFit] = useState<PopoverFit | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setFit(null);
      return;
    }
    const measure = () => {
      const anchor = anchorRef.current;
      const pop = popRef.current;
      if (!anchor || !pop) return;
      const rect = anchor.getBoundingClientRect();
      const next = fitPopover({
        anchorTop: rect.top,
        anchorBottom: rect.bottom,
        viewportHeight: window.innerHeight,
        natural: natural(pop),
        preferUp
      });
      setFit((prev) => (prev && prev.up === next.up && prev.maxHeight === next.maxHeight ? prev : next));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, preferUp, ...deps]);

  return fit;
}
