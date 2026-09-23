import { useCallback, useEffect, useRef, useState } from "react";
import type { AppSettings, PrDetail, PrSummary, Session, SessionPrLink } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { usePrStore } from "../stores/prStore.js";
import { prKey } from "./prInbox.js";
import { hasUnseen } from "./prUpdates.js";
import { errorMessage } from "./errorMessage.js";

export interface LinkedPr {
  session: Session | undefined;
  link: SessionPrLink | undefined;
  summary: PrSummary | undefined;
  detail: PrDetail | undefined;
  loading: boolean;
  error: string | undefined;
  unseen: boolean;
}

function findSession(sessionsByProject: Record<string, Session[]>, sessionId: string): Session | undefined {
  for (const list of Object.values(sessionsByProject)) {
    const found = list.find((item) => item.id === sessionId);
    if (found) return found;
  }
  return undefined;
}

function useLinkedSummary(link: SessionPrLink | undefined): PrSummary | undefined {
  const key = link ? prKey(link.ref) : null;
  return usePrStore((s) => (key ? s.inbox?.items.find((item) => prKey(item.ref) === key) : undefined));
}

export function useLinkedPr(sessionId: string): LinkedPr {
  const session = useAppStore((s) => findSession(s.sessionsByProject, sessionId));
  const link = session?.pr;
  const key = link ? prKey(link.ref) : null;
  const summary = useLinkedSummary(link);
  const detail = usePrStore((s) => (key ? s.detailByKey[key] : undefined));
  const loading = usePrStore((s) => (key ? (s.detailLoadingByKey[key] ?? false) : false));
  const error = usePrStore((s) => (key ? s.detailErrorByKey[key] : undefined));
  const basis = summary ?? detail;
  const unseen = link !== undefined && basis !== undefined && hasUnseen(basis, link);
  return { session, link, summary, detail, loading, error, unseen };
}

export function useLinkedPrLoader(sessionId: string | undefined): void {
  const link = useAppStore((s) => (sessionId ? findSession(s.sessionsByProject, sessionId)?.pr : undefined));
  const key = link ? prKey(link.ref) : null;
  const summary = useLinkedSummary(link);
  const inboxUnseen = link !== undefined && summary !== undefined && hasUnseen(summary, link);
  const lastUnseenRef = useRef(inboxUnseen);

  useEffect(() => {
    lastUnseenRef.current = inboxUnseen;
    if (!link || !key) return;
    const store = usePrStore.getState();
    if (store.detailErrorByKey[key] !== undefined) return;
    void store.loadDetail(link.ref);
  }, [sessionId, key]);

  useEffect(() => {
    const wasUnseen = lastUnseenRef.current;
    lastUnseenRef.current = inboxUnseen;
    if (!link || !inboxUnseen || wasUnseen) return;
    void usePrStore.getState().loadDetail(link.ref);
  }, [inboxUnseen]);
}

export function usePrSettings(): { settings: AppSettings | null; error: string | null; reload: () => void } {
  const settingsVersion = useAppStore((s) => s.settingsVersion);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  useEffect(() => {
    let active = true;
    window.cw
      .getSettings()
      .then((next) => {
        if (!active) return;
        setSettings(next);
        setError(null);
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err));
      });
    return () => {
      active = false;
    };
  }, [settingsVersion, reloadToken]);

  return { settings, error, reload };
}
