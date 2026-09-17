import { useCallback, useEffect, useRef, useState, type JSX, type MouseEvent } from "react";
import { AlertTriangle, CheckCircle2, RefreshCw, X, XCircle } from "lucide-react";
import type { CliBinary, CliDiscoveredCandidate } from "@cw-code/contracts";

function isBareName(value: string): boolean {
  return !value.includes("/") && !value.includes("\\");
}

function samePath(a: string, b: string): boolean {
  return a === b || a.toLowerCase() === b.toLowerCase();
}

function firstLine(text: string): string {
  return text.replace(/\r/g, "").split("\n")[0]?.trim() || text;
}

type ProbeStatus = "good" | "stale" | "failed";

function probeStatus(candidate: CliDiscoveredCandidate): ProbeStatus {
  if (candidate.error !== null || candidate.version === null) return "failed";
  return candidate.ok ? "good" : "stale";
}

function failedCandidate(binary: CliBinary, path: string, err: unknown): CliDiscoveredCandidate {
  return {
    binary,
    path,
    source: "configured",
    version: null,
    available: false,
    error: err instanceof Error ? err.message : String(err),
    ok: false,
    minimum: null
  };
}

function sourceBadge(candidate: CliDiscoveredCandidate, currentValue: string): string {
  if (candidate.path === currentValue) return "current";
  if (candidate.source === "path") return "PATH";
  if (candidate.source === "common") return "found";
  return "custom";
}

export function BinaryPicker(props: {
  binary: CliBinary;
  value: string;
  onPick: (path: string) => Promise<void>;
  autoDiscoverKey: string;
}): JSX.Element {
  const { binary, value, onPick, autoDiscoverKey } = props;
  const [candidates, setCandidates] = useState<CliDiscoveredCandidate[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customPath, setCustomPath] = useState("");
  const [customCheck, setCustomCheck] = useState<CliDiscoveredCandidate | null>(null);
  const [checking, setChecking] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  const [hiddenCustom, setHiddenCustom] = useState<string[]>([]);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const valueRef = useRef(value);
  valueRef.current = value;
  const candidatesRef = useRef<CliDiscoveredCandidate[] | null>(null);
  candidatesRef.current = candidates;
  const customKnownRef = useRef<string[]>([]);
  const customVerifySeq = useRef(0);

  const rememberCustom = useCallback((path: string) => {
    if (!customKnownRef.current.some((known) => samePath(known, path))) {
      customKnownRef.current = [...customKnownRef.current, path];
    }
    setHiddenCustom((prev) => prev.filter((h) => !samePath(h, path)));
  }, []);

  const hideCustom = useCallback((e: MouseEvent, path: string) => {
    e.preventDefault();
    e.stopPropagation();
    setHiddenCustom((prev) => (prev.some((h) => samePath(h, path)) ? prev : [...prev, path]));
  }, []);

  const mergeCustomRows = useCallback(async (base: CliDiscoveredCandidate[]): Promise<CliDiscoveredCandidate[]> => {
    const saved = valueRef.current;
    const wanted = [...(isBareName(saved) || saved === "" ? [] : [saved]), ...customKnownRef.current];
    const known = new Set(base.map((c) => c.path.toLowerCase()));
    const extras = wanted.filter(
      (p, i, arr) =>
        !known.has(p.toLowerCase()) && arr.findIndex((q) => q.toLowerCase() === p.toLowerCase()) === i
    );
    if (extras.length === 0) return base;
    const rows = await Promise.all(
      extras.map((p) => window.cw.verifyBinaryPath(binary, p).catch((err) => failedCandidate(binary, p, err)))
    );
    return [...rows, ...base];
  }, [binary]);

  const runDiscover = useCallback(async () => {
    setScanning(true);
    setScanError(null);
    try {
      const result = await window.cw.discoverBinaries([binary]);
      setCandidates(await mergeCustomRows(result[binary] ?? []));
    } catch (err) {
      setScanError(err instanceof Error ? err.message : "Discovery failed");
    } finally {
      setScanning(false);
    }
  }, [binary, mergeCustomRows]);

  useEffect(() => {
    let cancelled = false;
    setScanError(null);
    void (async () => {
      let checked: CliDiscoveredCandidate | null = null;
      try {
        checked = await window.cw.verifyBinaryPath(binary, valueRef.current);
      } catch {
        checked = null;
      }
      if (cancelled) return;
      if (checked && checked.error === null && checked.version !== null) {
        const merged = await mergeCustomRows(candidatesRef.current ?? []);
        if (!cancelled && (merged.length > 0 || candidatesRef.current !== null)) {
          setCandidates(merged);
        }
        return;
      }
      const saved = valueRef.current;
      setScanError(
        isBareName(saved)
          ? `'${saved}' was not found on PATH. Scanning common install locations…`
          : `Saved path '${saved}' stopped working (${checked?.error ?? "verification failed"}). Scanning for installs…`
      );
      setScanning(true);
      try {
        const result = await window.cw.discoverBinaries([binary]);
        if (!cancelled) {
          setCandidates(await mergeCustomRows(result[binary] ?? []));
          setScanError(null);
        }
      } catch (err) {
        if (!cancelled) setScanError(err instanceof Error ? err.message : "Discovery failed");
      } finally {
        if (!cancelled) setScanning(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoDiscoverKey]);

  useEffect(() => {
    const trimmed = customPath.trim();
    if (trimmed === "") {
      customVerifySeq.current += 1;
      setCustomCheck(null);
      setChecking(false);
      return;
    }
    setChecking(true);
    customVerifySeq.current += 1;
    const requestId = customVerifySeq.current;
    const timer = window.setTimeout(() => {
      void window.cw
        .verifyBinaryPath(binary, trimmed)
        .then((candidate) => {
          if (customVerifySeq.current !== requestId) return;
          setCustomCheck(candidate);
        })
        .catch((err: Error) => {
          if (customVerifySeq.current !== requestId) return;
          setCustomCheck(failedCandidate(binary, trimmed, err));
        })
        .finally(() => {
          if (customVerifySeq.current === requestId) setChecking(false);
        });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [binary, customPath]);

  const pick = useCallback(async (path: string, custom: CliDiscoveredCandidate | null = null, isCustomRow = false) => {
    setApplying(path);
    setApplyError(null);
    try {
      await onPickRef.current(path);
      if (custom) {
        rememberCustom(custom.path);
      } else if (!isCustomRow) {
        const saved = valueRef.current;
        if (saved !== "" && !isBareName(saved) && !samePath(saved, path)) rememberCustom(saved);
      }
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : "Could not save binary path");
    } finally {
      setApplying(null);
    }
  }, [rememberCustom]);

  const visible = (candidates ?? []).filter(
    (c) => c.source !== "configured" || !hiddenCustom.some((h) => samePath(h, c.path))
  );
  const pickable = visible
    .filter((c) => c.error === null && c.version !== null)
    .sort((a, b) => (a.source === "configured" ? 0 : 1) - (b.source === "configured" ? 0 : 1));
  const customFailed = visible.filter(
    (c) => c.source === "configured" && (c.error !== null || c.version === null)
  );
  const skipped = visible.filter(
    (c) => c.source !== "configured" && (c.error !== null || c.version === null)
  );
  const scanned = candidates !== null;
  const customStatus = customCheck ? probeStatus(customCheck) : null;

  const renderVersion = (candidate: CliDiscoveredCandidate) => {
    const status = probeStatus(candidate);
    if (status === "failed" || candidate.version === null) return null;
    return (
      <span className={`binary-picker-version ${status}`}>
        {status === "good"
          ? <CheckCircle2 size={12} aria-hidden="true" />
          : <AlertTriangle size={12} aria-hidden="true" />}
        {candidate.version}
        {status === "stale" && candidate.minimum ? <span>needs &gt;= {candidate.minimum}</span> : null}
      </span>
    );
  };

  return (
    <div className="binary-picker">
      {scanning && (
        <div className="binary-picker-status">
          <RefreshCw size={13} className="binary-picker-spin" aria-hidden="true" /> Scanning for {binary} installs…
        </div>
      )}
      {scanError && !scanning && (
        <div className="binary-picker-notice" role="status">
          <AlertTriangle size={13} aria-hidden="true" /> {scanError}
        </div>
      )}
      {scanned && !scanning && pickable.length === 0 && customFailed.length === 0 && (
        <div className="binary-picker-empty" role="alert">
          <AlertTriangle size={13} aria-hidden="true" />
          <span>No verified {binary} installs found. Try a custom path below.</span>
        </div>
      )}
      {(pickable.length > 0 || customFailed.length > 0) && (
        <div className="binary-picker-list" role="radiogroup" aria-label={`${binary} installs`}>
          {pickable.map((candidate) => {
            const selected = samePath(candidate.path, value);
            const busy = applying === candidate.path;
            const custom = candidate.source === "configured";
            return (
              <label
                key={candidate.path}
                className={`binary-picker-row${selected ? " selected" : ""}${custom ? " custom" : ""}`}
                title={candidate.version ? `${candidate.path} — ${candidate.version}` : candidate.path}
              >
                <input
                  type="radio"
                  className="binary-picker-radio"
                  name={`binary-picker-${binary}`}
                  checked={selected}
                  disabled={applying !== null}
                  onChange={() => void pick(candidate.path, null, custom)}
                />
                <span className="binary-picker-row-body">
                  <span className="binary-picker-path">{candidate.path}</span>
                  <span className="binary-picker-meta">
                    {renderVersion(candidate)}
                    <span className="binary-picker-badge">{sourceBadge(candidate, value)}</span>
                    {busy && <span className="binary-picker-saving">Saving…</span>}
                  </span>
                </span>
                {custom && (
                  <button
                    type="button"
                    className="binary-picker-remove"
                    title="Remove custom path"
                    aria-label={`Remove custom path ${candidate.path}`}
                    onClick={(e) => hideCustom(e, candidate.path)}
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                )}
              </label>
            );
          })}
          {customFailed.map((candidate) => (
            <label
              key={candidate.path}
              className="binary-picker-row custom failed"
              title={candidate.error ?? candidate.path}
            >
              <input
                type="radio"
                className="binary-picker-radio"
                name={`binary-picker-${binary}`}
                checked={false}
                disabled
              />
              <span className="binary-picker-row-body">
                <span className="binary-picker-path">{candidate.path}</span>
                <span className="binary-picker-meta">
                  <span className="binary-picker-version failed" title={candidate.error ?? undefined}>
                    <XCircle size={12} aria-hidden="true" /> {firstLine(candidate.error ?? "Verification failed")}
                  </span>
                  <span className="binary-picker-badge">custom</span>
                </span>
              </span>
              <button
                type="button"
                className="binary-picker-remove"
                title="Remove custom path"
                aria-label={`Remove custom path ${candidate.path}`}
                onClick={(e) => hideCustom(e, candidate.path)}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </label>
          ))}
        </div>
      )}
      {scanned && skipped.length > 0 && (
        <div className="binary-picker-skipped">
          {skipped.length} unverified location(s) skipped: {skipped[0].error ?? skipped[0].path}
        </div>
      )}
      <div className="binary-picker-actions">
        <button className="btn binary-picker-btn" onClick={() => void runDiscover()} disabled={scanning}>
          <RefreshCw size={12} aria-hidden="true" /> {scanned ? "Rescan" : "Discover installs"}
        </button>
        <button
          className="btn binary-picker-btn"
          aria-expanded={customOpen}
          onClick={() => setCustomOpen((o) => !o)}
        >
          {customOpen ? "Hide custom path" : "Custom path…"}
        </button>
      </div>
      {customOpen && (
        <div className="binary-picker-custom-body">
            <input
              className="field"
              value={customPath}
              placeholder={value || binary}
              aria-label={`Custom ${binary} path`}
              onChange={(e) => setCustomPath(e.target.value)}
            />
            {checking && <div className="binary-picker-status">Checking…</div>}
            {!checking && customCheck && (customStatus === "good" || customStatus === "stale") && (
              <div className={`binary-picker-valid${customStatus === "stale" ? " stale" : ""}`}>
                {customStatus === "good"
                  ? <CheckCircle2 size={13} aria-hidden="true" />
                  : <AlertTriangle size={13} aria-hidden="true" />}
                {customCheck.version}
                {customStatus === "stale" && customCheck.minimum
                  ? <span>below minimum {customCheck.minimum}, still usable</span>
                  : null}
                <button
                  className="btn btn-primary binary-picker-btn"
                  disabled={applying !== null}
                  onClick={() => void pick(customCheck.path, customCheck)}
                >
                  {applying === customCheck.path ? "Saving…" : "Use this path"}
                </button>
              </div>
            )}
            {!checking && customCheck && customStatus === "failed" && (
              <div className="binary-picker-invalid" role="alert" title={customCheck.error ?? undefined}>
                <XCircle size={13} aria-hidden="true" /> {firstLine(customCheck.error ?? "Not a usable binary")}
              </div>
            )}
        </div>
      )}
      {applyError && <div className="binary-picker-error" role="alert">{applyError}</div>}
    </div>
  );
}
