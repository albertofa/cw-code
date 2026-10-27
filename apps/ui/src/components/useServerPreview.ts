import { useEffect, useRef, useState } from "react";
import { useConnectionEpoch } from "../server/topics.js";
import { ipcErrorMessage } from "./ipcError.js";

const MAX_PENDING_REQUESTS = 5;

interface PreviewState<T> {
  key: string | null;
  value: T | null;
  error: string | null;
  loading: boolean;
}

export interface ServerPreview<T> {
  value: T | null;
  current: boolean;
  loading: boolean;
  error: string | null;
  retry(): void;
  refresh(): void;
}

export function useServerPreview<T>(
  key: string | null,
  load: (retry: boolean) => Promise<T>,
  isPending: (value: T) => boolean,
  triggers: readonly unknown[],
  debounceMs = 0
): ServerPreview<T> {
  const epoch = useConnectionEpoch();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PreviewState<T>>({ key: null, value: null, error: null, loading: false });
  const loadRef = useRef(load);
  const pendingRef = useRef(isPending);
  const pendingCount = useRef({ key: null as string | null, count: 0 });
  const retryRef = useRef(false);
  loadRef.current = load;
  pendingRef.current = isPending;

  useEffect(() => {
    if (key === null) return;
    let active = true;
    setState((prev) => ({ ...prev, loading: true }));
    const send = () => {
      const retry = retryRef.current;
      retryRef.current = false;
      loadRef.current(retry).then(
        (value) => {
          if (!active) return;
          setState({ key, value, error: null, loading: false });
          if (pendingCount.current.key !== key) pendingCount.current = { key, count: 0 };
          const counter = pendingCount.current;
          if (!pendingRef.current(value)) {
            counter.count = 0;
          } else if (counter.count < MAX_PENDING_REQUESTS) {
            counter.count += 1;
            setAttempt((n) => n + 1);
          }
        },
        (err: unknown) => {
          if (!active) return;
          const message = ipcErrorMessage(err);
          console.warn(`[preview] request failed: ${message}`);
          setState((prev) => ({ ...prev, error: message, loading: false }));
        }
      );
    };
    const timer = debounceMs > 0 ? window.setTimeout(send, debounceMs) : null;
    if (timer === null) send();
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [key, attempt, epoch, ...triggers]);

  return {
    value: state.value,
    current: state.value !== null && state.key === key,
    loading: state.loading,
    error: state.error,
    retry: () => {
      retryRef.current = true;
      setAttempt((n) => n + 1);
    },
    refresh: () => setAttempt((n) => n + 1)
  };
}
