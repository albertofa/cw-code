import type { ReactNode } from "react";
import type { AppSettings } from "../cw.js";

export type BinaryPickHandler = (patch: Partial<AppSettings>) => Promise<void>;

export function SettingsPageHead({ title, description }: { title: string; description: ReactNode }) {
  return (
    <div className="sp-title">
      <h1 className="sp-h1">{title}</h1>
      <p className="sp-sub">{description}</p>
    </div>
  );
}

export function SettingsGroup({ title, action, children }: { title: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="sp-group">
      <div className="sp-group-h">
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function SettingsRow({ label, hint, children, htmlFor }: { label: ReactNode; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="sp-row">
      <label className="sp-lab" htmlFor={htmlFor}>
        {label}
        {hint && <small>{hint}</small>}
      </label>
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
