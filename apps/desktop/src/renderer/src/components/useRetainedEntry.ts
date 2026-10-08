import { useEffect, useMemo, useRef } from "react";
import type { Loadable } from "../stores/githubStore.js";

export function useRetainedEntry<T>(own: Loadable<T> | undefined): Loadable<T> | undefined {
  const lastShown = useRef<Loadable<T> | undefined>(undefined);
  useEffect(() => {
    if (own) lastShown.current = own;
  }, [own]);
  return useMemo(() => {
    if (own) return own;
    const previous = lastShown.current;
    return previous ? { ...previous, loading: true, error: null, stale: true } : undefined;
  }, [own]);
}
