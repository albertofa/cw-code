import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, ChartColumn, CheckCircle2, RefreshCw, Search, Star, XCircle } from "lucide-react";
import type { AccountUsageSnapshot, AppSettings, DriverName, ModelOption } from "../cw.js";
import { useSettingsDraftStore, type HarnessCheck } from "../stores/settingsDraftStore.js";
import { useUsageStore } from "../stores/usageStore.js";
import { BinaryPicker } from "./BinaryPicker.js";
import { DriverIcon } from "./DriverIcon.js";
import { errorMessage } from "./errorMessage.js";
import { CLAUDE_CURATED_MODELS, defaultModelPatch, filterModels } from "./modelMenus.js";
import { HARNESS_NAMES } from "./settingsSections.js";
import { SettingsGroup, SettingsRow, SettingsSwitch, type BinaryPickHandler } from "./SettingsLayout.js";
import { unavailableTitle } from "./UsagePlanCard.js";

const ARGS_PLACEHOLDER: Record<DriverName, string> = {
  claude: "--dangerously-skip-permissions",
  opencode: "--dangerously-skip-permissions",
  codex: "--enable feature"
};

function binaryOf(settings: AppSettings, driver: DriverName): string {
  if (driver === "claude") return settings.claudeBinaryPath;
  return driver === "codex" ? settings.codexBinaryPath : settings.opencodeBinaryPath;
}

function binaryPatch(driver: DriverName, path: string): Partial<AppSettings> {
  if (driver === "claude") return { claudeBinaryPath: path };
  return driver === "codex" ? { codexBinaryPath: path } : { opencodeBinaryPath: path };
}

function argsOf(settings: AppSettings, driver: DriverName): string {
  if (driver === "claude") return settings.claudeExtraArgs;
  return driver === "codex" ? settings.codexExtraArgs : settings.opencodeExtraArgs;
}

function argsPatch(driver: DriverName, value: string): Partial<AppSettings> {
  if (driver === "claude") return { claudeExtraArgs: value };
  return driver === "codex" ? { codexExtraArgs: value } : { opencodeExtraArgs: value };
}

function reasoningOf(settings: AppSettings, driver: DriverName): boolean {
  if (driver === "claude") return settings.claudeReasoningExpanded;
  return driver === "codex" ? settings.codexReasoningExpanded : settings.opencodeReasoningExpanded;
}

function reasoningPatch(driver: DriverName, value: boolean): Partial<AppSettings> {
  if (driver === "claude") return { claudeReasoningExpanded: value };
  return driver === "codex" ? { codexReasoningExpanded: value } : { opencodeReasoningExpanded: value };
}

function defaultModelOf(settings: AppSettings, driver: DriverName): string {
  if (driver === "claude") return settings.claudeDefaultModel;
  return driver === "codex" ? settings.codexDefaultModel : settings.opencodeDefaultModel;
}

function curatedOrder(enabled: string[], next: Set<string>): string[] {
  const curated = CLAUDE_CURATED_MODELS.map((model) => model.id);
  return [...curated.filter((id) => next.has(id)), ...enabled.filter((id) => !curated.includes(id) && next.has(id))];
}

function StarButton({ active, label, harness, onToggle }: { active: boolean; label: string; harness: string; onToggle: () => void }) {
  const text = active ? `Clear ${label} as the ${harness} default model` : `Set ${label} as the ${harness} default model`;
  return (
    <button type="button" className={`sp-star${active ? " on" : ""}`} aria-pressed={active} aria-label={text} title={text} onClick={onToggle}>
      <Star size={14} fill={active ? "currentColor" : "none"} aria-hidden="true" />
    </button>
  );
}

function ModelRow({
  label,
  id,
  isDefault,
  harness,
  onStar,
  enabled,
  onToggleEnabled,
  extra
}: {
  label: string;
  id: string;
  isDefault: boolean;
  harness: string;
  onStar: () => void;
  enabled?: boolean;
  onToggleEnabled?: () => void;
  extra?: ReactNode;
}) {
  return (
    <div className={`sp-mrow${isDefault ? " default" : ""}`}>
      {onToggleEnabled && <input type="checkbox" checked={enabled === true} onChange={onToggleEnabled} aria-label={`Enable ${label}`} />}
      <StarButton active={isDefault} label={label} harness={harness} onToggle={onStar} />
      <span className="sp-mrow-name">{label}</span>
      <span className="sp-mono sp-mrow-id" title={id}>
        {id}
      </span>
      <span className="sp-mrow-end">
        {extra}
        {isDefault && <span className="sp-tag">Default</span>}
      </span>
    </div>
  );
}

function ClaudeModels({ draft, set }: { draft: AppSettings; set: (patch: Partial<AppSettings>) => void }) {
  const customId = draft.claudeCustomModel.id.trim();
  const customName = draft.claudeCustomModel.name.trim();

  const toggle = (id: string) => {
    const has = draft.claudeEnabledModels.includes(id);
    const next = new Set(draft.claudeEnabledModels);
    if (has) next.delete(id);
    else next.add(id);
    set({
      claudeEnabledModels: curatedOrder(draft.claudeEnabledModels, next),
      ...(has && draft.claudeDefaultModel === id ? { claudeDefaultModel: "" } : {})
    });
  };

  const star = (id: string) => {
    if (draft.claudeDefaultModel === id) {
      set({ claudeDefaultModel: "" });
      return;
    }
    const isCurated = CLAUDE_CURATED_MODELS.some((model) => model.id === id);
    const enabled = !isCurated || draft.claudeEnabledModels.includes(id) ? draft.claudeEnabledModels : curatedOrder(draft.claudeEnabledModels, new Set([...draft.claudeEnabledModels, id]));
    set({ claudeDefaultModel: id, claudeEnabledModels: enabled });
  };

  const editCustomId = (id: string) => {
    const wasDefault = customId !== "" && draft.claudeDefaultModel === customId;
    set({ claudeCustomModel: { ...draft.claudeCustomModel, id }, ...(wasDefault ? { claudeDefaultModel: id.trim() } : {}) });
  };

  const removeCustom = () => {
    set({ claudeCustomModel: { id: "", name: "" }, ...(draft.claudeDefaultModel === customId ? { claudeDefaultModel: "" } : {}) });
  };

  return (
    <>
      <div className="sp-mlist">
        {CLAUDE_CURATED_MODELS.map((model) => (
          <ModelRow
            key={model.id}
            label={model.label}
            id={model.id}
            harness="Claude Code"
            isDefault={draft.claudeDefaultModel === model.id}
            onStar={() => star(model.id)}
            enabled={draft.claudeEnabledModels.includes(model.id)}
            onToggleEnabled={() => toggle(model.id)}
          />
        ))}
        {customId && (
          <ModelRow
            label={customName || customId}
            id={customId}
            harness="Claude Code"
            isDefault={draft.claudeDefaultModel === customId}
            onStar={() => star(customId)}
            extra={
              <>
                <span className="sp-tag custom">custom</span>
                <button type="button" className="btn sp-btn-sm" onClick={removeCustom}>
                  Remove
                </button>
              </>
            }
          />
        )}
      </div>
      <div className="sp-custom">
        <input
          className="field sp-mono-field"
          value={draft.claudeCustomModel.id}
          placeholder="provider/model"
          aria-label="Custom model ID"
          onChange={(e) => editCustomId(e.target.value)}
        />
        <input
          className="field"
          value={draft.claudeCustomModel.name}
          placeholder="Display name"
          aria-label="Custom model display name"
          onChange={(e) => set({ claudeCustomModel: { ...draft.claudeCustomModel, name: e.target.value } })}
        />
      </div>
    </>
  );
}

function LiveModels({ driver, draft, set }: { driver: DriverName; draft: AppSettings; set: (patch: Partial<AppSettings>) => void }) {
  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [reload, setReload] = useState(0);
  const binary = binaryOf(draft, driver);
  const current = defaultModelOf(draft, driver);
  const harness = HARNESS_NAMES[driver];

  useEffect(() => {
    let cancelled = false;
    setModels(null);
    setError(null);
    window.cw
      .listModelsForHarness(driver)
      .then((list) => {
        if (!cancelled) setModels(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err) || "Could not load models");
      });
    return () => {
      cancelled = true;
    };
  }, [driver, binary, reload]);

  const star = (id: string) => set(defaultModelPatch(driver, current === id ? "" : id));
  const shown = filterModels(models ?? [], query);
  const missingDefault = current !== "" && models !== null && !models.some((model) => model.id === current);

  return (
    <>
      {models !== null && models.length > 8 && (
        <label className="side-search sp-mfilter">
          <Search size={14} aria-hidden="true" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Filter ${models.length} models`} aria-label={`Filter ${harness} models`} />
        </label>
      )}
      <div className="sp-mlist sp-mlist-scroll">
        {models === null && !error && <div className="sp-mempty">Loading models from {harness}…</div>}
        {error && (
          <div className="sp-mempty bad" role="alert">
            <span>Model list failed: {error}</span>
            <button type="button" className="btn sp-btn-sm" onClick={() => setReload((n) => n + 1)}>
              Retry
            </button>
          </div>
        )}
        {missingDefault && (
          <ModelRow
            label={`${current} (saved)`}
            id={current}
            harness={harness}
            isDefault
            onStar={() => star(current)}
          />
        )}
        {shown.map((model) => (
          <ModelRow key={model.id} label={model.label} id={model.id} harness={harness} isDefault={current === model.id} onStar={() => star(model.id)} />
        ))}
        {models !== null && shown.length === 0 && !missingDefault && (
          <div className="sp-mempty">{models.length === 0 ? `${harness} reported no models.` : "No models match."}</div>
        )}
      </div>
    </>
  );
}

function accountText(snapshot: AccountUsageSnapshot | undefined, loading: boolean, error: string | undefined): { account: string; plan: string; bad: boolean } {
  if (!snapshot) {
    if (error) return { account: `Couldn't load: ${error}`, plan: "—", bad: true };
    return { account: loading ? "Loading…" : "Not checked yet", plan: "—", bad: false };
  }
  const state = snapshot.state;
  if (state.status === "ok") {
    const plan = state.windows.map((w) => `${Math.round(w.percent)}% ${w.label.toLowerCase()}`).join(" · ");
    return { account: `Signed in${state.plan ? ` · ${state.plan}` : ""}`, plan: plan || "No limits reported", bad: false };
  }
  if (state.status === "unavailable") return { account: unavailableTitle(state.reason), plan: "—", bad: false };
  return { account: `Couldn't load: ${state.message}`, plan: "—", bad: true };
}

function StatusCard({ driver, check, onOpenUsage }: { driver: DriverName; check: HarnessCheck | undefined; onOpenUsage: () => void }) {
  const checksLoading = useSettingsDraftStore((s) => s.harnessChecksLoading);
  const checksError = useSettingsDraftStore((s) => s.harnessChecksError);
  const recheckHarnesses = useSettingsDraftStore((s) => s.recheckHarnesses);
  const snapshot = useUsageStore((s) => s.accountByDriver[driver]);
  const accountLoading = useUsageStore((s) => s.accountLoading[driver] === true);
  const accountError = useUsageStore((s) => s.accountError[driver]);
  const refreshAccount = useUsageStore((s) => s.refreshAccount);

  useEffect(() => {
    const usage = useUsageStore.getState();
    if (!usage.accountByDriver[driver] && !usage.accountLoading[driver]) void refreshAccount([driver]);
  }, [driver, refreshAccount]);

  const status = checksError
    ? { tone: "bad", icon: <XCircle size={14} aria-hidden="true" />, text: "Version check failed" }
    : !check
      ? { tone: "muted", icon: <RefreshCw size={14} aria-hidden="true" />, text: "Checking…" }
      : !check.available
        ? { tone: "bad", icon: <XCircle size={14} aria-hidden="true" />, text: "Not installed" }
        : check.actual === null
          ? { tone: "warn", icon: <AlertTriangle size={14} aria-hidden="true" />, text: "Version unknown" }
          : !check.ok
            ? { tone: "warn", icon: <AlertTriangle size={14} aria-hidden="true" />, text: "Update required" }
            : { tone: "ok", icon: <CheckCircle2 size={14} aria-hidden="true" />, text: "Ready" };
  const account = accountText(snapshot, accountLoading, accountError);

  return (
    <aside className="sp-aside" aria-label={`${HARNESS_NAMES[driver]} status`}>
      <div className={`sp-aside-h ${status.tone}`} role={status.tone === "bad" ? "alert" : undefined}>
        {status.icon}
        {status.text}
      </div>
      {checksError && <p className="sp-aside-error">{checksError}</p>}
      {check && !check.available && check.error && <p className="sp-aside-error">{check.error}</p>}
      {check && check.available && check.actual === null && check.error && (
        <p className="sp-aside-faint" title={check.error}>
          {check.error}
        </p>
      )}
      <dl className="sp-kv">
        <dt>Version</dt>
        <dd className={check && check.actual !== null && !check.ok ? "warn" : undefined}>{check?.actual ?? "—"}</dd>
        <dt>Minimum</dt>
        <dd>{check?.minimum ?? "—"}</dd>
        <dt>Account</dt>
        <dd className={`sans${account.bad ? " bad" : ""}`}>{account.account}</dd>
        <dt>Plan use</dt>
        <dd className="sans">{account.plan}</dd>
      </dl>
      <div className="sp-aside-actions">
        <button
          type="button"
          className="btn sp-btn-sm"
          disabled={checksLoading || accountLoading}
          onClick={() => {
            void recheckHarnesses();
            void refreshAccount([driver], true);
          }}
        >
          <RefreshCw size={12} aria-hidden="true" /> {checksLoading || accountLoading ? "Checking…" : "Recheck"}
        </button>
        <button type="button" className="btn sp-btn-sm" onClick={onOpenUsage}>
          <ChartColumn size={12} aria-hidden="true" /> Usage
        </button>
      </div>
    </aside>
  );
}

export function HarnessSettings({ driver, onPickBinary, onOpenUsage }: { driver: DriverName; onPickBinary: BinaryPickHandler; onOpenUsage: () => void }) {
  const draft = useSettingsDraftStore((s) => s.draft);
  const set = useSettingsDraftStore((s) => s.set);
  const check = useSettingsDraftStore((s) => s.harnessChecks?.find((item) => item.binary === driver));
  if (!draft) return null;
  const name = HARNESS_NAMES[driver];
  const binaryPath = binaryOf(draft, driver);

  return (
    <div className="sp-harness">
      <div className="sp-harness-main">
        <div className="sp-harness-title">
          <span className={`sp-tile ${driver}`}>
            <DriverIcon driver={driver} size={18} />
          </span>
          <div className="sp-title">
            <h1 className="sp-h1">{name}</h1>
            <p className="sp-sub">
              Runs your installed <span className="sp-mono">{driver}</span> binary with its own login and subscription.
            </p>
          </div>
        </div>

        <SettingsGroup title="Binary">
          <p className="sp-hint">Verified installs only. Picking one applies immediately.</p>
          <BinaryPicker
            key={driver}
            binary={driver}
            value={binaryPath}
            onPick={(path) => onPickBinary(binaryPatch(driver, path))}
            autoDiscoverKey={`harness:${driver}:${binaryPath}`}
          />
        </SettingsGroup>

        <SettingsGroup title="Launch">
          <SettingsRow
            label="Launch arguments"
            htmlFor={`sp-args-${driver}`}
            hint={driver === "codex" ? "Additional CLI arguments passed to the app server on startup." : "Additional CLI arguments passed on session start."}
          >
            <input
              id={`sp-args-${driver}`}
              className="field sp-mono-field"
              value={argsOf(draft, driver)}
              placeholder={ARGS_PLACEHOLDER[driver]}
              onChange={(e) => set(argsPatch(driver, e.target.value))}
            />
          </SettingsRow>
          <SettingsRow
            label="Chain of thought expanded"
            htmlFor={`sp-reasoning-${driver}`}
            hint={`Show ${name} reasoning open instead of behind a “Thought for Xs” summary.`}
          >
            <SettingsSwitch
              id={`sp-reasoning-${driver}`}
              checked={reasoningOf(draft, driver)}
              onChange={(next) => set(reasoningPatch(driver, next))}
              label={`Expand ${name} reasoning by default`}
            />
          </SettingsRow>
          {driver === "opencode" && (
            <SettingsRow
              label="Show OpenCode Go plan limits"
              htmlFor="sp-opencode-go"
              hint="Reads your OpenCode Go key from opencode's auth file. The key stays on this device and is only sent to opencode.ai."
            >
              <SettingsSwitch id="sp-opencode-go" checked={draft.opencodeGoUsage} onChange={(next) => set({ opencodeGoUsage: next })} label="Show OpenCode Go plan limits" />
            </SettingsRow>
          )}
        </SettingsGroup>

        <SettingsGroup
          title={
            <>
              Models <small>Star a model to make it the default when a session has none. The composer picker's star sets the same default.</small>
            </>
          }
        >
          {driver === "claude" ? <ClaudeModels draft={draft} set={set} /> : <LiveModels driver={driver} draft={draft} set={set} />}
        </SettingsGroup>
      </div>
      <StatusCard driver={driver} check={check} onOpenUsage={onOpenUsage} />
    </div>
  );
}
