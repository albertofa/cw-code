import { useCallback, useEffect, useState } from "react";
import { Star } from "lucide-react";
import type { AppSettings, DriverName } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { useNotifs } from "./Notifications.js";
import { DriverIcon } from "./DriverIcon.js";

// Must match CLAUDE_CURATED_MODELS in apps/desktop/src/main/providers/claude/ClaudeCliDriver.ts.
// Main drops unknown ids on save, so keep this list in sync with the driver.
const CURATED_MODELS = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "fable", label: "Fable 5.1" },
  { id: "haiku", label: "Haiku" },
  { id: "claude-opus-5", label: "Opus 5" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-fable-5", label: "Fable 5" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" }
];

type Category = "general" | "harnesses";
type Harness = DriverName;

export function SettingsModal({
  initialHarness = "claude",
  onClose
}: {
  initialHarness?: Harness;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [category, setCategory] = useState<Category>("harnesses");
  const [harness, setHarness] = useState<Harness>(initialHarness);

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    void window.cw
      .getSettings()
      .then((s) => setDraft(s))
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Could not load settings"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    setCategory("harnesses");
    setHarness(initialHarness);
  }, [initialHarness]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const set = (patch: Partial<AppSettings>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
  };

  const setCustom = (patch: Partial<{ id: string; name: string }>) => {
    setDraft((d) => (d ? { ...d, claudeCustomModel: { ...d.claudeCustomModel, ...patch } } : d));
  };

  const customId = draft?.claudeCustomModel.id.trim() ?? "";
  const customName = draft?.claudeCustomModel.name.trim() ?? "";

  const removeCustom = () => {
    if (!draft) return;
    set({
      claudeCustomModel: { id: "", name: "" },
      ...(draft.claudeDefaultModel === customId ? { claudeDefaultModel: "" } : {})
    });
  };

  const toggleModel = (id: string) => {
    setDraft((d) => {
      if (!d) return d;
      const has = d.claudeEnabledModels.includes(id);
      return {
        ...d,
        claudeEnabledModels: has ? d.claudeEnabledModels.filter((m) => m !== id) : [...d.claudeEnabledModels, id],
        ...(has && d.claudeDefaultModel === id ? { claudeDefaultModel: "" } : {})
      };
    });
  };

  const starModel = (id: string) => {
    setDraft((d) => {
      if (!d) return d;
      if (d.claudeDefaultModel === id) return { ...d, claudeDefaultModel: "" };
      return {
        ...d,
        claudeDefaultModel: id,
        claudeEnabledModels: d.claudeEnabledModels.includes(id)
          ? d.claudeEnabledModels
          : [...d.claudeEnabledModels, id]
      };
    });
  };

  const starButton = (id: string, label: string) => {
    const active = draft?.claudeDefaultModel === id;
    return (
      <button
        className={`settings-star${active ? " active" : ""}`}
        title={active ? `Default model (${label}) — click to clear` : `Set ${label} as default`}
        aria-label={active ? `Default model (${label}) — click to clear` : `Set ${label} as default`}
        aria-pressed={active}
        onClick={() => starModel(id)}
      >
        <Star size={14} fill={active ? "currentColor" : "none"} />
      </button>
    );
  };

  const onSave = () => {
    if (!draft || saving) return;
    setSaving(true);
    setSaveError(null);
    void useAppStore
      .getState()
      .saveSettings(draft)
      .then(() => onClose())
      .catch((err) => {
        const message = err instanceof Error ? err.message : "Could not save settings";
        setSaveError(message);
        useNotifs.getState().push({ kind: "error", title: "Could not save settings", message });
      })
      .finally(() => setSaving(false));
  };

  const pickHarness = (h: Harness) => {
    setCategory("harnesses");
    setHarness(h);
  };

  const modelsSection = draft && (
    <section className="settings-section">
      <h3>Models</h3>
      <span className="settings-hint">Star a model to make it the default, used when a session has no model set.</span>
      <div className="settings-checks">
        {CURATED_MODELS.map((m) => (
          <div key={m.id} className="settings-check">
            <input
              type="checkbox"
              aria-label={`Enable ${m.label}`}
              checked={draft.claudeEnabledModels.includes(m.id)}
              onChange={() => toggleModel(m.id)}
            />
            {starButton(m.id, m.label)}
            <span>
              {m.label} <span className="settings-id">{m.id}</span>
            </span>
          </div>
        ))}
        {customId && (
          <div className="settings-check" key="__custom">
            <span className="settings-tag">custom</span>
            {starButton(customId, customName || customId)}
            <span>
              {customName || customId}
              {customName && <span className="settings-id"> {customId}</span>}
            </span>
            <button className="btn settings-remove" onClick={removeCustom}>
              Remove
            </button>
          </div>
        )}
      </div>
      <div className="settings-custom">
        <label className="settings-row">
          <span className="settings-label">Custom model ID</span>
          <input
            className="field"
            value={draft.claudeCustomModel.id}
            placeholder="provider/model"
            onChange={(e) => setCustom({ id: e.target.value })}
          />
        </label>
        <label className="settings-row">
          <span className="settings-label">Display name</span>
          <input
            className="field"
            value={draft.claudeCustomModel.name}
            placeholder="My model"
            onChange={(e) => setCustom({ name: e.target.value })}
          />
        </label>
      </div>
    </section>
  );

  const claudeFields = draft && (
    <>
      <label className="settings-row">
        <span className="settings-label">Binary path</span>
        <span className="settings-hint">Path to the Claude binary used by this instance.</span>
        <input
          className="field"
          value={draft.claudeBinaryPath}
          placeholder="claude"
          onChange={(e) => set({ claudeBinaryPath: e.target.value })}
        />
      </label>
      <label className="settings-row">
        <span className="settings-label">Launch arguments</span>
        <span className="settings-hint">Additional CLI arguments passed on session start.</span>
        <input
          className="field"
          value={draft.claudeExtraArgs}
          placeholder="--dangerously-skip-permissions"
          onChange={(e) => set({ claudeExtraArgs: e.target.value })}
        />
      </label>
      {modelsSection}
    </>
  );

  const opencodeFields = draft && (
    <>
      <label className="settings-row">
        <span className="settings-label">Binary path</span>
        <span className="settings-hint">Path to the OpenCode binary used by this instance.</span>
        <input
          className="field"
          value={draft.opencodeBinaryPath}
          placeholder="opencode"
          onChange={(e) => set({ opencodeBinaryPath: e.target.value })}
        />
      </label>
      <label className="settings-row">
        <span className="settings-label">Launch arguments</span>
        <span className="settings-hint">Additional CLI arguments passed on session start.</span>
        <input
          className="field"
          value={draft.opencodeExtraArgs}
          placeholder="--dangerously-skip-permissions"
          onChange={(e) => set({ opencodeExtraArgs: e.target.value })}
        />
      </label>
    </>
  );

  const codexFields = draft && (
    <>
      <label className="settings-row">
        <span className="settings-label">Binary path</span>
        <span className="settings-hint">Path to the Codex binary used by this instance.</span>
        <input
          className="field"
          value={draft.codexBinaryPath}
          placeholder="codex"
          onChange={(e) => set({ codexBinaryPath: e.target.value })}
        />
      </label>
      <label className="settings-row">
        <span className="settings-label">Launch arguments</span>
        <span className="settings-hint">Additional CLI arguments passed to the app server on startup.</span>
        <input
          className="field"
          value={draft.codexExtraArgs}
          placeholder="--enable feature"
          onChange={(e) => set({ codexExtraArgs: e.target.value })}
        />
      </label>
    </>
  );

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div className="settings-modal" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <span>Settings</span>
          <button className="icon-btn" aria-label="Close settings" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="settings-main">
          <nav className="settings-nav" aria-label="Settings categories">
            <button
              className={`settings-nav-item${category === "general" ? " active" : ""}`}
              onClick={() => setCategory("general")}
              aria-current={category === "general"}
            >
              General
            </button>
            <div className="settings-nav-group">Harnesses</div>
            <button
              className={`settings-nav-item sub${category === "harnesses" && harness === "claude" ? " active" : ""}`}
              onClick={() => pickHarness("claude")}
              aria-current={category === "harnesses" && harness === "claude"}
            >
              <span className="driver-dot claude" /> Claude Code
            </button>
            <button
              className={`settings-nav-item sub${category === "harnesses" && harness === "opencode" ? " active" : ""}`}
              onClick={() => pickHarness("opencode")}
              aria-current={category === "harnesses" && harness === "opencode"}
            >
              <span className="driver-dot opencode" /> OpenCode
            </button>
            <button
              className={`settings-nav-item sub${category === "harnesses" && harness === "codex" ? " active" : ""}`}
              onClick={() => pickHarness("codex")}
              aria-current={category === "harnesses" && harness === "codex"}
            >
              <span className="driver-dot codex" /> Codex
            </button>
          </nav>
          <div className="settings-content">
            {loading && <div className="side-empty">Loading settings…</div>}
            {!loading && loadError && (
              <>
                <div className="settings-error">{loadError}</div>
                <div>
                  <button className="btn" onClick={load}>
                    Retry
                  </button>
                </div>
              </>
            )}
            {!loading && !loadError && draft && category === "general" && (
              <div className="side-empty">Nothing here yet.</div>
            )}
            {!loading && !loadError && draft && category === "harnesses" && (
              <>
                <div className="harness-row" role="group" aria-label="Harness">
                  <button
                    className={`harness-btn claude${harness === "claude" ? " active" : ""}`}
                    onClick={() => setHarness("claude")}
                    aria-pressed={harness === "claude"}
                  >
                    <DriverIcon driver="claude" size={14} />
                    Claude Code
                  </button>
                  <button
                    className={`harness-btn opencode${harness === "opencode" ? " active" : ""}`}
                    onClick={() => setHarness("opencode")}
                    aria-pressed={harness === "opencode"}
                  >
                    <DriverIcon driver="opencode" size={14} />
                    OpenCode
                  </button>
                  <button
                    className={`harness-btn codex${harness === "codex" ? " active" : ""}`}
                    onClick={() => setHarness("codex")}
                    aria-pressed={harness === "codex"}
                  >
                    <DriverIcon driver="codex" size={14} />
                    Codex
                  </button>
                </div>
                <div className="settings-section">
                  {harness === "claude" ? claudeFields : harness === "codex" ? codexFields : opencodeFields}
                </div>
              </>
            )}
            {saveError && <div className="settings-error">{saveError}</div>}
          </div>
        </div>
        <div className="settings-foot">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={onSave} disabled={!draft || loading || saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
