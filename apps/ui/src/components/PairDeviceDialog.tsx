import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Copy } from "lucide-react";

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  const copy = () => {
    setFailed(false);
    navigator.clipboard
      .writeText(value)
      .then(() => setCopied(true))
      .catch(() => setFailed(true));
  };

  return (
    <div className="sp-field pair-field">
      <span>{label}</span>
      <div className="pair-copy">
        <input className="field sp-mono-field" readOnly value={value} aria-label={label} onFocus={(e) => e.target.select()} />
        <button type="button" className="btn sp-btn-sm" onClick={copy}>
          {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />} {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {failed && (
        <small className="settings-error" role="alert">
          Could not copy to the clipboard. Select the text and copy it manually.
        </small>
      )}
    </div>
  );
}

export function PairDeviceDialog({
  deviceName,
  token,
  link,
  notice,
  onClose
}: {
  deviceName: string;
  token: string;
  link: string | null;
  notice: string | null;
  onClose: () => void;
}) {
  const doneRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    doneRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="confirm-backdrop">
      <div className="confirm-card pair-card" role="dialog" aria-modal="true" aria-label={`Pair ${deviceName}`}>
        <div className="confirm-title">Pair {deviceName}</div>
        <div className="confirm-message">
          Open the pairing link on the new device, or enter the token on its sign-in screen. <b>This token will not be shown again.</b>
        </div>
        {notice && (
          <div className="sp-issue warning" role="status">
            <AlertTriangle size={13} aria-hidden="true" /> {notice}
          </div>
        )}
        {link && <CopyField label="Pairing link" value={link} />}
        <CopyField label="Token" value={token} />
        <div className="confirm-actions">
          <button ref={doneRef} type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
