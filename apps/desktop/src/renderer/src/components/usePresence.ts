import { useEffect, useState } from "react";
import { useAppStore } from "../stores/appStore.js";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export function usePanelAnimationMs(): number {
  const configured = useAppStore((s) => s.appearance.panelAnimationMs);
  const [reduced, setReduced] = useState(() => window.matchMedia?.(REDUCED_MOTION_QUERY).matches ?? false);

  useEffect(() => {
    const query = window.matchMedia?.(REDUCED_MOTION_QUERY);
    if (!query) return;
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return reduced ? 0 : configured;
}

export function usePresence(open: boolean, durationMs: number): { mounted: boolean; entered: boolean } {
  const animated = durationMs > 0;
  const [mounted, setMounted] = useState(open);
  const [entered, setEntered] = useState(open);

  useEffect(() => {
    if (!animated) return;
    if (open) {
      setMounted(true);
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setEntered(true));
      });
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
      };
    }
    setEntered(false);
    const timer = window.setTimeout(() => setMounted(false), durationMs);
    return () => window.clearTimeout(timer);
  }, [open, animated, durationMs]);

  if (!animated) return { mounted: open, entered: open };
  return { mounted: mounted || open, entered: entered && open };
}
