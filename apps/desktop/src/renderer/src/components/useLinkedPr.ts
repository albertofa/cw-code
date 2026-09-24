import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppSettings, PrDetail, PrInboxResult, PrSummary, Session, SessionPrLink } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { usePrStore } from "../stores/prStore.js";
import { prKey } from "./prInbox.js";
import { hasUnseen } from "./prUpdates.js";
import { errorMessage } from "./errorMessage.js";
import { sessionLinks, type PrSummaryLookup } from "./sessionPrLinks.js";

export interface LinkedPr {
  key: string;
  link: SessionPrLink;
  summary: PrSummary | undefined;
  detail: PrDetail | undefined;
  loading: boolean;
  error: string | undefined;
  unseen: boolean;
}

export interface LinkedPrs {
  session: Session | undefined;
  items: LinkedPr[];
  summaryByKey: PrSummaryLookup;
}

function findSession(sessionsByProject: Record<string, Session[]>, sessionId: string): Session | undefined {
  for (const list of Object.values(sessionsByProject)) {
    const found = list.find((item) => item.id === sessionId);
    if (found) return found;
  }
  return undefined;
}

function inboxSummaryByKey(inbox: PrInboxResult | null, links: SessionPrLink[]): Map<string, PrSummary> {
  const wanted = new Set(links.map((link) => prKey(link.ref)));
  const byKey = new Map<string, PrSummary>();
  for (const item of inbox?.items ?? []) {
    const key = prKey(item.ref);
    if (wanted.has(key)) byKey.set(key, item);
  }
  return byKey;
}

export function useLinkedPrs(sessionId: string): LinkedPrs {
  const session = useAppStore((s) => findSession(s.sessionsByProject, sessionId));
  const links = sessionLinks(session);
  const inbox = usePrStore((s) => s.inbox);
  const detailByKey = usePrStore((s) => s.detailByKey);
  const loadingByKey = usePrStore((s) => s.detailLoadingByKey);
  const errorByKey = usePrStore((s) => s.detailErrorByKey);

  return useMemo(() => {
    const inboxByKey = inboxSummaryByKey(inbox, links);
    const summaryByKey = new Map<string, PrSummary>();
    const items = links.map((link): LinkedPr => {
      const key = prKey(link.ref);
      const summary = inboxByKey.get(key);
      const detail = detailByKey[key];
      const basis = summary ?? detail;
      if (basis) summaryByKey.set(key, basis);
      return {
        key,
        link,
        summary,
        detail,
        loading: loadingByKey[key] ?? false,
        error: errorByKey[key],
        unseen: basis !== undefined && hasUnseen(basis, link)
      };
    });
    return { session, items, summaryByKey };
  }, [session, links, inbox, detailByKey, loadingByKey, errorByKey]);
}

function unseenKeys(links: SessionPrLink[], inboxByKey: Map<string, PrSummary>): string[] {
  return links
    .filter((link) => {
      const summary = inboxByKey.get(prKey(link.ref));
      return summary !== undefined && hasUnseen(summary, link);
    })
    .map((link) => prKey(link.ref));
}

function isFinishedAndCached(detail: PrDetail | undefined): boolean {
  return detail !== undefined && detail.state !== "OPEN";
}

export function useLinkedPrLoader(sessionId: string | undefined): void {
  const session = useAppStore((s) => (sessionId ? findSession(s.sessionsByProject, sessionId) : undefined));
  const links = sessionLinks(session);
  const inbox = usePrStore((s) => s.inbox);
  const keySignature = links.map((link) => prKey(link.ref)).join(" ");
  const unseen = unseenKeys(links, inboxSummaryByKey(inbox, links));
  const unseenSignature = unseen.join(" ");
  const lastUnseenRef = useRef(new Set(unseen));

  useEffect(() => {
    lastUnseenRef.current = new Set(unseen);
    const store = usePrStore.getState();
    for (const link of links) {
      const key = prKey(link.ref);
      if (store.detailErrorByKey[key] !== undefined || isFinishedAndCached(store.detailByKey[key])) continue;
      void store.loadDetail(link.ref);
    }
  }, [sessionId, keySignature]);

  useEffect(() => {
    const previous = lastUnseenRef.current;
    lastUnseenRef.current = new Set(unseen);
    const store = usePrStore.getState();
    for (const link of links) {
      const key = prKey(link.ref);
      if (!unseen.includes(key) || previous.has(key) || isFinishedAndCached(store.detailByKey[key])) continue;
      void store.loadDetail(link.ref);
    }
  }, [unseenSignature]);
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
