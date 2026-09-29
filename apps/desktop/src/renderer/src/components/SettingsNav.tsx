import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, Download, Eye, GitBranch, GitPullRequest, Search, Settings, X } from "lucide-react";
import { usePrStore } from "../stores/prStore.js";
import { useSettingsDraftStore, type HarnessCheck } from "../stores/settingsDraftStore.js";
import { DriverIcon } from "./DriverIcon.js";
import { SETTINGS_NAV, filterSettingsNav, viewOfNavId, type SettingsNavId, type SettingsNavItem } from "./settingsSections.js";
import { version as appVersion } from "../../../../package.json";
import "./settingsPage.css";

const APP_ICONS: Partial<Record<SettingsNavId, ReactNode>> = {
  general: <Settings size={14} aria-hidden="true" />,
  appearance: <Eye size={14} aria-hidden="true" />,
  updates: <Download size={14} aria-hidden="true" />,
  sourceControl: <GitBranch size={14} aria-hidden="true" />,
  prWorkflows: <GitPullRequest size={14} aria-hidden="true" />
};

function versionTag(check: HarnessCheck | undefined): { text: string; warn: boolean; title: string } | null {
  if (!check) return null;
  if (!check.available) return { text: "missing", warn: true, title: check.error ?? `Could not run '${check.binaryPath}'` };
  if (check.actual === null) return { text: "unknown", warn: true, title: check.error ?? "Could not read the version" };
  if (!check.ok) return { text: check.actual, warn: true, title: `Below the minimum ${check.minimum}` };
  return { text: check.actual, warn: false, title: `Installed ${check.actual} · minimum ${check.minimum}` };
}

export function SettingsNav({ active, onBack }: { active: SettingsNavId; onBack: () => void }) {
  const openSettings = usePrStore((s) => s.openSettings);
  const checks = useSettingsDraftStore((s) => s.harnessChecks);
  const checksError = useSettingsDraftStore((s) => s.harnessChecksError);
  const checksLoading = useSettingsDraftStore((s) => s.harnessChecksLoading);
  const recheckHarnesses = useSettingsDraftStore((s) => s.recheckHarnesses);
  const [query, setQuery] = useState("");

  useEffect(() => {
    void recheckHarnesses();
  }, [recheckHarnesses]);

  const shown = filterSettingsNav(SETTINGS_NAV, query);
  const appItems = shown.filter((item) => item.group === "app");
  const harnessItems = shown.filter((item) => item.group === "harnesses");

  const pick = (id: SettingsNavId) => {
    const view = viewOfNavId(id);
    openSettings(view.section, view.harness);
  };

  const renderItem = (item: SettingsNavItem) => {
    const on = item.id === active;
    const driver = viewOfNavId(item.id).harness;
    const tag = driver ? versionTag(checks?.find((check) => check.binary === driver)) : null;
    return (
      <button
        key={item.id}
        type="button"
        className={`sp-item${on ? " on" : ""}`}
        aria-current={on ? "page" : undefined}
        onClick={() => pick(item.id)}
      >
        {driver ? <DriverIcon driver={driver} size={14} /> : APP_ICONS[item.id]}
        <span className="sp-item-label">{item.label}</span>
        {tag && (
          <span className={`sp-ver${tag.warn ? " warn" : ""}`} title={tag.title}>
            {tag.text}
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="side sp-nav">
      <div className="head-seg side-seg" onDoubleClick={() => window.cw.toggleMaximizeWindow()}>
        <button type="button" className="sp-back" onClick={onBack}>
          <ArrowLeft size={14} aria-hidden="true" />
          Back to sessions
        </button>
        <span className="side-kbd" aria-hidden="true">Esc</span>
      </div>
      <div className="brand">
        <label className="side-search">
          <Search size={14} aria-hidden="true" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search settings" aria-label="Search settings" />
          {query && (
            <button type="button" className="icon-btn" aria-label="Clear search" onClick={() => setQuery("")}>
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </label>
      </div>
      <nav className="sp-nav-list" aria-label="Settings sections">
        {appItems.length > 0 && <div className="sp-glabel">App</div>}
        {appItems.map(renderItem)}
        {harnessItems.length > 0 && <div className="sp-glabel">Harnesses</div>}
        {harnessItems.map(renderItem)}
        {harnessItems.length > 0 && checksError && (
          <div className="sp-nav-error" role="alert">
            <span>Version check failed: {checksError}</span>
            <button type="button" className="sp-link" onClick={() => void recheckHarnesses()} disabled={checksLoading}>
              {checksLoading ? "Checking…" : "Retry"}
            </button>
          </div>
        )}
        {shown.length === 0 && <div className="sp-nav-empty">No settings match “{query.trim()}”.</div>}
      </nav>
      <div className="sp-nav-foot">cw-code {appVersion} · MIT</div>
    </div>
  );
}
