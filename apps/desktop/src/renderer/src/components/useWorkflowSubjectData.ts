import { useEffect, useMemo, useState } from "react";
import type { PrUpdate } from "@cw-code/contracts";
import type {
  AppSettings,
  IssueDetail,
  PrDetail,
  PrRef,
  PrSummary,
  RunRef,
  Session,
  WorkflowRunSummary,
  WorkflowSubject
} from "../cw.js";
import { prKey } from "./prInbox.js";
import { linkFor } from "./sessionPrLinks.js";
import { useThreadEntry } from "./useThread.js";
import {
  attributionText,
  issueTemplateVars,
  loadFailedLogs,
  loadRunFailedLogs,
  needsFailedLogs,
  needsRunFailedLogs,
  runRefTemplateVars,
  runTemplateVars,
  templateVars
} from "./prWorkflows.js";
import { requestPrDetail, usePrDetail, usePrSummary } from "./usePrs.js";
import { errorMessage } from "./errorMessage.js";
import { issueKey, runKey } from "./workflowSubject.js";

export interface WorkflowSubjectData {
  pr: PrSummary | undefined;
  prDetail: PrDetail | undefined;
  issue: IssueDetail | undefined;
  run: WorkflowRunSummary | undefined;
  loaded: boolean;
  error: string | null;
  retry: () => void;
  revision: string;
  logsNeeded: boolean;
  logsReady: boolean;
  logsError: string | null;
  vars: Record<string, string> | null;
}

const NO_UPDATES: PrUpdate[] = [];

interface IssueLoad {
  key: string;
  detail?: IssueDetail;
  error?: string;
}

export function useWorkflowSubjectData(input: {
  subject: WorkflowSubject;
  cachedRun: WorkflowRunSummary | undefined;
  template: string;
  continueSession: Session | undefined;
  settings: AppSettings | null;
  hasWorkflow: boolean;
  harness: string;
}): WorkflowSubjectData {
  const { subject, cachedRun, template, continueSession, settings, hasWorkflow, harness } = input;
  const prRef = subject.kind === "pr" ? subject.ref : null;
  const issueRef = subject.kind === "issue" ? subject.ref : null;
  const runRef = subject.kind === "run" ? subject.ref : null;
  const prKeyValue = prRef ? prKey(prRef) : "";
  const issueKeyValue = issueRef ? issueKey(issueRef) : "";

  const prEntry = usePrDetail(prKeyValue || null);
  const prDetail: PrDetail | undefined = prEntry?.detail ?? undefined;
  const prError = prEntry?.error ?? undefined;
  const prSummary = usePrSummary(prKeyValue || null);
  const dock = useThreadEntry(prRef ? continueSession?.id : null, "prDock");
  const prUpdates = useMemo(() => dock?.find((entry) => entry.key === prKeyValue)?.updates ?? NO_UPDATES, [dock, prKeyValue]);

  const [issueLoad, setIssueLoad] = useState<IssueLoad | null>(null);
  const [issueAttempt, setIssueAttempt] = useState(0);
  const [logs, setLogs] = useState<{ id: string; text: string } | null>(null);
  const [logsError, setLogsError] = useState<string | null>(null);

  useEffect(() => {
    if (prRef) void requestPrDetail(prRef);
  }, [prKeyValue]);

  useEffect(() => {
    if (!issueRef) return;
    let active = true;
    setIssueLoad(null);
    window.cw
      .getIssueDetail(issueRef)
      .then((detail) => {
        if (active) setIssueLoad({ key: issueKeyValue, detail });
      })
      .catch((err: unknown) => {
        if (!active) return;
        const message = errorMessage(err);
        console.warn(`[github] issue detail load failed for ${issueKeyValue}: ${message}`);
        setIssueLoad({ key: issueKeyValue, error: message });
      });
    return () => {
      active = false;
    };
  }, [issueKeyValue, issueAttempt]);

  const issue = issueLoad?.key === issueKeyValue ? issueLoad.detail : undefined;
  const issueError = issueLoad?.key === issueKeyValue ? (issueLoad.error ?? null) : null;

  const logsNeeded = subject.kind === "pr" ? needsFailedLogs(template) : subject.kind === "run" ? needsRunFailedLogs(template) : false;
  const logsId = !logsNeeded
    ? null
    : prRef && prDetail
      ? prDetail.headRefOid
      : runRef
        ? `${runKey(runRef)}:${cachedRun?.status ?? ""}:${cachedRun?.conclusion ?? ""}`
        : null;
  const logsReady = !logsNeeded || (logsId !== null && logs?.id === logsId);

  useEffect(() => {
    if (!logsNeeded || logsId === null || logs?.id === logsId) return;
    const source = prRef && prDetail ? loadFailedLogs(prDetail) : runRef ? loadRunFailedLogs(runRef) : null;
    if (!source) return;
    let active = true;
    setLogsError(null);
    source
      .then((text) => {
        if (active) setLogs({ id: logsId, text });
      })
      .catch((err: unknown) => {
        if (!active) return;
        setLogsError(errorMessage(err));
        setLogs({ id: logsId, text: "" });
      });
    return () => {
      active = false;
    };
  }, [logsNeeded, logsId]);

  const failedLogs = logsNeeded ? logs?.text : undefined;

  const vars = useMemo(() => {
    if (!hasWorkflow || !settings || !logsReady) return null;
    const attribution = attributionText(settings, harness);
    switch (subject.kind) {
      case "pr": {
        if (!prDetail) return null;
        const link = continueSession ? linkFor(continueSession, subject.ref) : undefined;
        return templateVars(prDetail, {
          link,
          updates: continueSession && link ? prUpdates : undefined,
          failedLogs,
          attribution,
          harness
        });
      }
      case "issue": {
        if (!issue) return null;
        const link = continueSession?.issues?.find((item) => issueKey(item.ref) === issueKeyValue);
        return issueTemplateVars(issue, { link, attribution, harness });
      }
      case "run":
        return cachedRun
          ? runTemplateVars(cachedRun, { failedLogs, attribution, harness })
          : runRefTemplateVars(subject.ref, { failedLogs, attribution, harness });
    }
  }, [subject, prDetail, prUpdates, issue, cachedRun, hasWorkflow, settings, logsReady, continueSession, failedLogs, harness, issueKeyValue]);

  const loaded = subject.kind === "pr" ? prDetail !== undefined : subject.kind === "issue" ? issue !== undefined : true;
  const revision =
    subject.kind === "pr"
      ? (prDetail?.headRefOid ?? "")
      : subject.kind === "issue"
        ? String(issue?.updatedAt ?? "")
        : String(cachedRun?.updatedAt ?? "");

  return {
    pr: prDetail ?? prSummary,
    prDetail,
    issue,
    run: cachedRun,
    loaded,
    error: subject.kind === "pr" ? (prError ?? null) : issueError,
    retry: () => {
      if (prRef) void requestPrDetail(prRef);
      if (issueRef) setIssueAttempt((n) => n + 1);
    },
    revision,
    logsNeeded,
    logsReady,
    logsError,
    vars
  };
}
