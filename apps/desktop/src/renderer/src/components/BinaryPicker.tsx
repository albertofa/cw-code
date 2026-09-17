import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { AlertTriangle, CheckCircle2, RefreshCw, XCircle } from "lucide-react";
import type { CliBinary, CliDiscoveredCandidate } from "@cw-code/contracts";

function isBareName(value: string): boolean {
  return !value.includes("/") && !value.includes("\\");
}

function sourceBadge(candidate: CliDiscoveredCandidate, currentValue: string): string {
  if (candidate.path === currentValue) return "current";
  if (candidate.source === "path") return "PATH";
  if (candidate.source === "common") return "found";
  return "saved";
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
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const customVerifySeq = useRef(0);

  const runDiscover = useCallback(async () => {
    setScanning(true);
    setScanError(null);
    try {
      const result = await window.cw.discoverBinaries([binary]);
      setCandidates(result[binary] ?? []);
    } catch (err) {
      setScanError(err instanceof Error ? err.message : "Discovery failed");
    } finally {
      setScanning(false);
    }
  }, [binary]);

  useEffect(() => {
    let cancelled = false;
    setScanError(null);
    void (async () => {
      let checked: CliDiscoveredCandidate | null = null;
      try {
        checked = await window.cw.verifyBinaryPath(binary, value);
      } catch {
        checked = null;
      }
      if (cancelled) return;
      if (checked && checked.available) return;
      setScanError(
        isBareName(value)
          ? `'${value}' was not found on PATH. Scanning common install locations…`
          : `Saved path '${value}' stopped working (${checked?.error ?? "verification failed"}). Scanning for installs…`
      );
      setScanning(true);
      try {
        const result = await window.cw.discoverBinaries([binary]);
        if (!cancelled) {
          setCandidates(result[binary] ?? []);
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
          setCustomCheck({
            binary,
            path: trimmed,
            source: "configured",
            version: null,
            available: false,
            error: err.message,
            ok: false
          });
        })
        .finally(() => {
          if (customVerifySeq.current === requestId) setChecking(false);
        });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [binary, customPath]);

  const pick = useCallback(async (path: string) => {
    setApplying(path);
    setApplyError(null);
    try {
      await onPickRef.current(path);
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : "Could not save binary path");
    } finally {
      setApplying(null);
    }
  }, []);

  const verified = (candidates ?? []).filter((c) => c.available === true);
  const unverified = (candidates ?? []).filter((c) => c.available !== true);
  const scanned = candidates !== null;

  return (
    <div className="binary-picker">
      <div className="binary-picker-current" title={value}>
        Current: <span className="binary-picker-path">{value === "" ? "(default)" : value}</span>
      </div>
      {scanning && (
        <div className="binary-picker-status">
          <RefreshCw size={13} className="binary-picker-spin" aria-hidden="true" /> Scanning for {binary} installs…
        </div>
      )}
      {!scanning && !scanned && !scanError && (
        <div className="binary-picker-actions">
          <button className="btn binary-picker-btn" onClick={() => void runDiscover()}>
            Discover installs
          </button>
        </div>
      )}
      {scanError && !scanning && (
        <div className="binary-picker-notice" role="status">
          <AlertTriangle size={13} aria-hidden="true" /> {scanError}
        </div>
      )}
      {scanned && !scanning && verified.length === 0 && (
        <div className="binary-picker-empty" role="alert">
          <AlertTriangle size={13} aria-hidden="true" />
          <span>No verified {binary} installs found.{scanError ? "" : " Try a custom path below."}</span>
          <button className="btn binary-picker-btn" onClick={() => void runDiscover()}>
            <RefreshCw size={12} aria-hidden="true" /> Rescan
          </button>
        </div>
      )}
      {verified.length > 0 && (
        <div className="binary-picker-list" role="radiogroup" aria-label={`${binary} installs`}>
          {verified.map((candidate) => {
            const selected = candidate.path === value;
            const busy = applying === candidate.path;
            return (
              <label
                key={candidate.path}
                className={`binary-picker-row${selected ? " selected" : ""}`}
                title={candidate.version ? `${candidate.path} — ${candidate.version}` : candidate.path}
              >
                <input
                  type="radio"
                  name={`binary-picker-${binary}`}
                  checked={selected}
                  disabled={applying !== null}
                  onChange={() => void pick(candidate.path)}
                />
                <span className="binary-picker-row-body">
                  <span className="binary-picker-path">{candidate.path}</span>
                  <span className="binary-picker-meta">
                    {candidate.version && <span className="binary-picker-version">{candidate.version}</span>}
                    <span className="binary-picker-badge">{sourceBadge(candidate, value)}</span>
                    {busy && <span className="binary-picker-saving">Saving…</span>}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      )}
      {scanned && unverified.length > 0 && (
        <div className="binary-picker-skipped">
          {unverified.length} unverified location(s) skipped: {unverified[0].error ?? unverified[0].path}
        </div>
      )}
      {scanned && verified.length > 0 && (
        <div className="binary-picker-actions">
          <button className="btn binary-picker-btn" onClick={() => void runDiscover()} disabled={scanning}>
            <RefreshCw size={12} aria-hidden="true" /> Rescan
          </button>
        </div>
      )}
      <div className="binary-picker-custom">
        <button
          className="binary-picker-toggle"
          aria-expanded={customOpen}
          onClick={() => setCustomOpen((o) => !o)}
        >
          {customOpen ? "Hide custom path" : "Custom path…"}
        </button>
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
            {!checking && customCheck?.available === true && (
              <div className="binary-picker-valid">
                <CheckCircle2 size={13} aria-hidden="true" /> {customCheck.version ?? "Verified"}
                <button
                  className="btn btn-primary binary-picker-btn"
                  disabled={applying !== null}
                  onClick={() => void pick(customCheck.path)}
                >
                  {applying === customCheck.path ? "Saving…" : "Use this path"}
                </button>
              </div>
            )}
            {!checking && customCheck && customCheck.available !== true && (
              <div className="binary-picker-invalid" role="alert">
                <XCircle size={13} aria-hidden="true" /> {customCheck.error ?? "Not a usable binary"}
              </div>
            )}
          </div>
        )}
      </div>
      {applyError && <div className="binary-picker-error" role="alert">{applyError}</div>}
    </div>
  );
}
