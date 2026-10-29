import { useId, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CircleHelp } from "lucide-react";
import type { AppSettings } from "../cw.js";

export type BinaryPickHandler = (patch: Partial<AppSettings>) => Promise<void>;

const TIP_WIDTH = 280;
const TIP_MARGIN = 8;

export function HelpTip({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const show = (el: HTMLElement) => setAnchor(el.getBoundingClientRect());
  const hide = () => setAnchor(null);
  const left = anchor ? Math.max(TIP_MARGIN, Math.min(anchor.left + anchor.width / 2 - TIP_WIDTH / 2, window.innerWidth - TIP_WIDTH - TIP_MARGIN)) : 0;
  const below = anchor ? anchor.bottom + 6 < window.innerHeight - 120 : true;
  return (
    <>
      <button
        type="button"
        className="sp-help"
        aria-label={`About ${label}`}
        aria-describedby={anchor ? id : undefined}
        onMouseEnter={(e) => show(e.currentTarget)}
        onMouseLeave={hide}
        onFocus={(e) => show(e.currentTarget)}
        onBlur={hide}
        onClick={(e) => e.preventDefault()}
      >
        <CircleHelp size={13} aria-hidden="true" />
      </button>
      {anchor &&
        createPortal(
          <div
            id={id}
            role="tooltip"
            className="sp-help-tip"
            style={{ left, width: TIP_WIDTH, ...(below ? { top: anchor.bottom + 6 } : { bottom: window.innerHeight - anchor.top + 6 }) }}
          >
            {children}
          </div>,
          document.body
        )}
    </>
  );
}

export function SettingsPageHead({ title, description, help }: { title: string; description?: ReactNode; help?: ReactNode }) {
  return (
    <div className="sp-title">
      <h1 className="sp-h1">
        {title}
        {help && <HelpTip label={title}>{help}</HelpTip>}
      </h1>
      {description && <p className="sp-sub">{description}</p>}
    </div>
  );
}

function helpLabel(node: ReactNode): string {
  return typeof node === "string" ? node : "this setting";
}

export function SettingsGroup({ title, help, action, children }: { title: ReactNode; help?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="sp-group">
      <div className="sp-group-h">
        <h2>
          {title}
          {help && <HelpTip label={helpLabel(title)}>{help}</HelpTip>}
        </h2>
        {action}
      </div>
      <div className="sp-group-box">{children}</div>
    </section>
  );
}

export function SettingsRow({
  label,
  hint,
  help,
  children,
  htmlFor
}: {
  label: ReactNode;
  hint?: ReactNode;
  help?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="sp-row">
      {help ? (
        <span className="sp-lab sp-lab-help">
          <label htmlFor={htmlFor}>{label}</label>
          <HelpTip label={helpLabel(label)}>{help}</HelpTip>
        </span>
      ) : (
        <label className="sp-lab" htmlFor={htmlFor}>
          {label}
          {hint && <small>{hint}</small>}
        </label>
      )}
      <div className="sp-ctl">{children}</div>
    </div>
  );
}

export function SettingsSwitch({
  checked,
  onChange,
  label,
  disabled,
  id
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <span className="settings-switch">
      <input
        id={id}
        type="checkbox"
        role="switch"
        aria-checked={checked}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={label}
      />
      <span className="track" aria-hidden="true" />
    </span>
  );
}
