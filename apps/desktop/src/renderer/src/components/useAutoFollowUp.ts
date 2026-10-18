import { useEffect, useMemo, useRef } from "react";
import type { AppSettings, PrWorkflow, Session } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { usePrStore } from "../stores/prStore.js";
import { shouldRequestDetail, type DetailAttempt } from "./needsYou.js";
import { useNotifs } from "./Notifications.js";
import { prKey } from "./prInbox.js";
import { autoFollowUpRefs, autoFollowUps, finalReviewPrompt, followUpPrompt, needsFailedLogs, type AutoFollowUp } from "./prSessionModel.js";
import { detailNeedsRefresh, detailRefreshKey, seenThrough } from "./prUpdates.js";
import { loadFailedLogs } from "./prWorkflows.js";
import { prRefLabel, prSummaryLookup } from "./sessionPrLinks.js";
import { harnessLabel } from "./toolTabs.js";
import { usePrSettings } from "./useLinkedPr.js";
import { errorMessage } from "./errorMessage.js";
import { ipcErrorMessage } from "./ipcError.js";

const NO_WORKFLOWS: PrWorkflow[] = [];

function isBusy(sessionId: string): boolean {
  return useAppStore.getState().busyTurns[sessionId] !== undefined;
}

async function sendAutoFollowUp(followUp: AutoFollowUp, settings: AppSettings, harness: string): Promise<boolean> {
  const { sessionId, link, workflow, detail, updates, finalReview } = followUp;
  if (isBusy(sessionId)) return false;
  try {
    const failedLogs = !finalReview && needsFailedLogs(workflow.updatePrompt) ? await loadFailedLogs(detail) : undefined;
    if (isBusy(sessionId)) return false;
    const prompt = finalReview ? finalReviewPrompt(detail) : followUpPrompt(detail, link, workflow, updates, settings, harness, failedLogs);
    await useAppStore.getState().sendPromptTo(sessionId, prompt, undefined, {
      prRefs: [link.ref],
      auto: true,
      ...(finalReview ? { finalReview: { ref: link.ref, sha: detail.headRefOid } } : {})
    });
  } catch (err) {
    useAppStore.getState().pauseAutoFollowUp(sessionId, "error");
    useNotifs.getState().push({
      kind: "error",
      title: `${workflow.label} could not send the ${prRefLabel(link.ref)} ${finalReview ? "final review" : "update"}`,
      message: `${ipcErrorMessage(err)}. Resume ${workflow.label} in the session's dock to retry.`
    });
    return true;
  }
  try {
    const session = await window.cw.markSessionPrSeen(sessionId, link.ref, detail.headRefOid, seenThrough(detail, updates));
    useAppStore.getState().applySession(session);
  } catch (err) {
    console.warn(`[pr] auto follow-up sent but ${prRefLabel(link.ref)} could not be marked seen: ${errorMessage(err)}`);
  }
  return true;
}

export function useAutoFollowUp(): void {
  const sessionsByProject = useAppStore((s) => s.sessionsByProject);
  const busyTurns = useAppStore((s) => s.busyTurns);
  const pendingApprovals = useAppStore((s) => s.pendingApprovals);
  const pendingQuestions = useAppStore((s) => s.pendingQuestions);
  const autoTurns = useAppStore((s) => s.autoFollowUpTurns);
  const autoPaused = useAppStore((s) => s.autoFollowUpPaused);
  const prRefreshIntervalSeconds = useAppStore((s) => s.prRefreshIntervalSeconds);
  const inbox = usePrStore((s) => s.inbox);
  const detailByKey = usePrStore((s) => s.detailByKey);
  const loadingByKey = usePrStore((s) => s.detailLoadingByKey);
  const { settings } = usePrSettings();
  const attempts = useRef(new Map<string, DetailAttempt>());
  const started = useRef(new Set<string>());
  const inFlight = useRef(new Set<string>());

  const workflows = settings?.prWorkflows ?? NO_WORKFLOWS;
  const sessions = useMemo(() => Object.values(sessionsByProject).flat(), [sessionsByProject]);
  const summaryByKey = useMemo(() => prSummaryLookup(inbox?.items ?? [], detailByKey), [inbox, detailByKey]);
  const refs = useMemo(() => autoFollowUpRefs(sessions, summaryByKey, workflows), [sessions, summaryByKey, workflows]);
  const fetchedAt = inbox?.fetchedAt ?? 0;
  const refSignature = refs.map((ref) => `${prKey(ref)}@${detailRefreshKey(prKey(ref), summaryByKey.get(prKey(ref)))}`).join(" ");
  const loadingSignature = refs.filter((ref) => loadingByKey[prKey(ref)]).map((ref) => prKey(ref)).join(" ");

  useEffect(() => {
    const store = usePrStore.getState();
    for (const ref of refs) {
      const key = prKey(ref);
      const detail = store.detailByKey[key];
      const summary = summaryByKey.get(key);
      if (detail && !detailNeedsRefresh(detail, summary)) continue;
      const version = detailRefreshKey(key, summary);
      if (!shouldRequestDetail(attempts.current.get(key), version, fetchedAt, Boolean(store.detailLoadingByKey[key]))) continue;
      attempts.current.set(key, { version, fetchedAt });
      void store.loadDetail(ref);
    }
  }, [refSignature, loadingSignature, fetchedAt]);

  const watching = refs.length > 0;
  useEffect(() => {
    if (!watching) return;
    const timer = window.setInterval(() => {
      if (document.hidden) void usePrStore.getState().refreshInbox();
    }, Math.max(30, prRefreshIntervalSeconds || 120) * 1000);
    return () => window.clearInterval(timer);
  }, [watching, prRefreshIntervalSeconds]);

  const followUps = useMemo(
    () =>
      autoFollowUps(
        sessions.map((session) => ({
          session,
          busy: busyTurns[session.id] !== undefined,
          waitingOnUser: (pendingApprovals[session.id]?.length ?? 0) > 0 || (pendingQuestions[session.id]?.length ?? 0) > 0,
          paused: autoPaused[session.id] !== undefined,
          autoTurns: autoTurns[session.id] ?? 0
        })),
        summaryByKey,
        detailByKey,
        workflows
      ),
    [sessions, busyTurns, pendingApprovals, pendingQuestions, autoPaused, autoTurns, summaryByKey, detailByKey, workflows]
  );
  const followUpSignature = followUps.map((followUp) => followUp.signature).join(" ");

  const pausedBefore = useRef(autoPaused);
  useEffect(() => {
    for (const sessionId of Object.keys(pausedBefore.current)) {
      if (autoPaused[sessionId] !== undefined) continue;
      for (const signature of started.current) {
        if (signature.startsWith(`${sessionId}:`) && !inFlight.current.has(signature)) started.current.delete(signature);
      }
    }
    pausedBefore.current = autoPaused;
  }, [autoPaused]);

  useEffect(() => {
    if (!settings) return;
    for (const followUp of followUps) {
      if (started.current.has(followUp.signature)) continue;
      const session: Session | undefined = sessions.find((item) => item.id === followUp.sessionId);
      if (!session) continue;
      started.current.add(followUp.signature);
      inFlight.current.add(followUp.signature);
      void sendAutoFollowUp(followUp, settings, harnessLabel(session.driver))
        .then((handled) => {
          if (!handled) started.current.delete(followUp.signature);
        })
        .finally(() => inFlight.current.delete(followUp.signature));
    }
  }, [followUpSignature, settings]);
}
