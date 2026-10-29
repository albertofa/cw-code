import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

export const MENU_VIEWPORT_MARGIN = 8;

export interface MenuRect {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  margin?: number;
}

export interface MenuPlacement {
  left: number;
  top: number;
  maxHeight: number;
}

/**
 * Keeps a floating menu inside the viewport: clamps horizontally, flips above the
 * anchor when the space below is tighter, and caps the height so a long menu
 * scrolls instead of running off the bottom edge.
 */
export function clampMenuPosition({
  x,
  y,
  width,
  height,
  viewportWidth,
  viewportHeight,
  margin = MENU_VIEWPORT_MARGIN
}: MenuRect): MenuPlacement {
  const available = Math.max(0, viewportHeight - margin * 2);
  const left = Math.max(margin, Math.min(x, viewportWidth - width - margin));

  const spaceBelow = Math.max(0, viewportHeight - margin - y);
  const spaceAbove = Math.max(0, y - margin);

  if (height <= spaceBelow) return { left, top: y, maxHeight: available };
  if (height <= spaceAbove) return { left, top: y - height, maxHeight: available };

  // Taller than either side: use the roomier one and let the menu scroll inside it.
  if (spaceAbove > spaceBelow) return { left, top: margin, maxHeight: spaceAbove };
  return { left, top: Math.max(margin, Math.min(y, viewportHeight - margin - spaceBelow)), maxHeight: spaceBelow };
}

/**
 * Measures the menu element and returns the style that keeps it on screen.
 * Renders once hidden so the first paint the user sees is already positioned.
 */
export function useMenuPosition(
  x: number,
  y: number,
  margin = MENU_VIEWPORT_MARGIN
): { ref: RefObject<HTMLDivElement | null>; style: CSSProperties } {
  const ref = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => {
      const rect = el.getBoundingClientRect();
      setPlacement(
        clampMenuPosition({
          x,
          y,
          width: rect.width,
          height: el.scrollHeight || rect.height,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          margin
        })
      );
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [x, y, margin]);

  return {
    ref,
    style: placement
      ? { left: placement.left, top: placement.top, maxHeight: placement.maxHeight }
      : { left: x, top: y, visibility: "hidden" }
  };
}
