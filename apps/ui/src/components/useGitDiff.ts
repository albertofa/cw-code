import { useCallback, useEffect, useMemo, useState } from "react";
import type { GitBranchInfo, GitDiffMode, GitDiffResult, GitStatus, TurnSnapshot } from "../cw.js";
import { parseUnifiedDiff, type DiffFile } from "./diffParser.js";
import { useAppStore } from "../stores/appStore.js";
import { usePanelStore } from "../stores/panelStore.js";
import { findSession } from "../server/sidebarData.js";
import { useConnectionEpoch } from "../server/topics.js";
import { snapshotKey } from "./turnChanges.js";
import { refreshGit, useGitStatus } from "./useGit.js";

const PREFERRED_BASES = ["main", "master", "origin/main", "origin/master"];

export const DIFF_MODE_LABEL: Record<GitDiffMode, string> = {
  working: "Changes",
  staged: "Staged",
  branch: "Branch",
  turn: "Last turn"
};

export const DIFF_MODES: GitDiffMode[] = ["working", "staged", "branch", "turn"];

function statusSignature(status: GitStatus | null): string {
  if (!status) return "";
  return [
    status.available,
    status.branch,
    status.dirtyCount,
    status.addedLines,
    status.deletedLines,
    status.stagedCount,
    status.ahead,
    status.behind,
    status.baseAhead,
    status.baseBehind
  ].join("|");
}

function sameDiff(a: GitDiffResult, b: GitDiffResult): boolean {
  return a.patch === b.patch && a.baseRef === b.baseRef && a.headRef === b.headRef && a.mode === b.mode;
}

function preferredBase(items: GitBranchInfo[]): string | undefined {
  const preferred = items.find((item) => PREFERRED_BASES.includes(item.name) && !item.current) ?? items.find((item) => !item.current);
  return preferred?.name ?? items.find((item) => item.current)?.name;
}

export function useLastTurnSnapshot(sessionId: string | null): TurnSnapshot | undefined {
  return useAppStore((s) => (sessionId ? findSession(s.sessionsByProject, sessionId)?.lastTurnSnapshot : undefined));
}

export function snapshotWarning(snapshot: TurnSnapshot | undefined, mode: GitDiffMode): string {
  if (snapshot?.error) return `Last-turn snapshot failed: ${snapshot.error}`;
  if (mode === "turn" && snapshot?.endError) return `End-of-turn snapshot failed, showing changes up to now: ${snapshot.endError}`;
  return "";
}

export interface GitDiffState {
  mode: GitDiffMode;
  branches: GitBranchInfo[];
  baseRef: string | undefined;
  pickBase: (name: string) => void;
  result: GitDiffResult | null;
  files: DiffFile[];
  added: number;
  removed: number;
  loading: boolean;
  error: string;
  refresh: () => void;
}

export function useGitDiff(sessionId: string | null, mode: GitDiffMode): GitDiffState {
  const status = useGitStatus(sessionId);
  const snapshot = useLastTurnSnapshot(sessionId);
  const epoch = useConnectionEpoch();
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [baseRef, setBaseRef] = useState<string>();
  const [loaded, setLoaded] = useState<{ scope: string; result: GitDiffResult } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const turnKey = mode === "turn" ? snapshotKey(snapshot) : "";
  const requestBase = mode === "branch" ? baseRef : undefined;
  const statusKey = statusSignature(status);
  const undoneAt = snapshot?.undoneAt;
  const scope = [sessionId ?? "", mode, requestBase ?? "", mode === "turn" ? (snapshot?.turnId ?? "") : ""].join("|");
  const result = loaded?.scope === scope ? loaded.result : null;

  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    refreshGit(sessionId);
    window.cw.listGitBranches(sessionId).then(
      (items) => {
        if (!active) return;
        setBranches(items);
        setBaseRef((prev) => prev ?? preferredBase(items));
      },
      (reason: Error) => {
        if (active) setError(reason.message);
      }
    );
    return () => {
      active = false;
    };
  }, [sessionId, epoch]);

  useEffect(() => {
    if (status?.baseRef) setBaseRef((prev) => prev ?? status.baseRef ?? prev);
  }, [status?.baseRef]);

  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    setLoading(true);
    setError("");
    window.cw
      .getGitDiff(sessionId, mode, requestBase)
      .then(
        (next) => {
          if (!active) return;
          setLoaded((prev) => (prev && prev.scope === scope && sameDiff(prev.result, next) ? prev : { scope, result: next }));
          if (mode === "branch" && next.baseRef) setBaseRef((prev) => prev ?? next.baseRef ?? prev);
        },
        (reason: Error) => {
          if (active) setError(reason.message);
        }
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [sessionId, mode, requestBase, scope, refreshKey, turnKey, statusKey, undoneAt, epoch]);

  const files = useMemo(() => parseUnifiedDiff(result?.patch ?? ""), [result]);
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  const turnResultReady = mode === "turn" && result !== null;

  useEffect(() => {
    if (!sessionId) return;
    const { setTurnDiffSummary } = usePanelStore.getState();
    if (mode !== "turn") {
      setTurnDiffSummary(sessionId, undefined);
      return;
    }
    setTurnDiffSummary(sessionId, turnResultReady ? { files: files.length, added, deleted: removed } : null);
  }, [sessionId, mode, turnResultReady, files.length, added, removed]);

  useEffect(() => {
    if (!sessionId) return;
    return () => usePanelStore.getState().setTurnDiffSummary(sessionId, undefined);
  }, [sessionId]);

  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);

  return {
    mode,
    branches,
    baseRef,
    pickBase: setBaseRef,
    result,
    files,
    added,
    removed,
    loading,
    error,
    refresh
  };
}
