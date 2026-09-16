import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { HarnessId, SkillMeta } from "@cw-code/contracts";
import type { DriverName } from "../cw.js";
import { toggleKey, useSkillsStore } from "../stores/skillsStore.js";
import { DriverIcon } from "./DriverIcon.js";
import { Md } from "./Markdown.js";
import { useNotifs } from "./Notifications.js";

const HARNESSES: Array<{ id: HarnessId; label: string }> = [
  { id: "claude", label: "Claude" },
  { id: "opencode", label: "OpenCode" },
  { id: "codex", label: "Codex" }
];

const SKILL_PATH: Record<HarnessId, string> = {
  claude: "~/.claude/skills",
  opencode: "~/.config/opencode/skills",
  codex: "~/.agents/skills"
};

const SKILL_NAME_PATTERN = /^[a-z0-9-]{1,64}$/;

type EditorTab = "preview" | "source";

function harnessTip(harness: HarnessId, name: string): string {
  const label = HARNESSES.find((h) => h.id === harness)?.label ?? harness;
  return `${label} — ${SKILL_PATH[harness]}/${name || "new-skill"}/SKILL.md`;
}

function enabledCount(enabled: Record<HarnessId, boolean>): number {
  return HARNESSES.filter((h) => enabled[h.id]).length;
}

function SkillRow({ meta, selected, onPick }: { meta: SkillMeta; selected: boolean; onPick: (name: string) => void }) {
  const toggle = useSkillsStore((s) => s.toggle);
  const pending = useSkillsStore((s) => s.pending);
  return (
    <div
      className={`skill-item${selected ? " sel" : ""}`}
      onClick={() => onPick(meta.name)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPick(meta.name);
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={`Edit skill ${meta.name}`}
    >
      <div className="skill-top">
        <span className="skill-name">/{meta.name}</span>
        <span className="skill-toggles">
          {HARNESSES.map(({ id, label }) => {
            const on = meta.enabled[id];
            const busy = Boolean(pending[toggleKey(meta.name, id)]);
            return (
              <button
                key={id}
                type="button"
                className={`skill-htoggle${on ? "" : " off"}${busy ? " pending" : ""}`}
                title={harnessTip(id, meta.name)}
                aria-label={`${label} ${on ? "enabled" : "disabled"}`}
                aria-pressed={on}
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  void toggle(meta.name, id, !on);
                }}
              >
                <span className={on ? undefined : "skill-icon-off"}>
                  <DriverIcon driver={id as DriverName} size={15} />
                </span>
              </button>
            );
          })}
        </span>
      </div>
      <div className="skill-desc" title={meta.description || undefined}>
        {meta.description || "No description yet"}
      </div>
    </div>
  );
}

function SkillEditor({ tab, setTab }: { tab: EditorTab; setTab: (tab: EditorTab) => void }) {
  const draft = useSkillsStore((s) => s.draft);
  const selectedName = useSkillsStore((s) => s.selectedName);
  const dirty = useSkillsStore((s) => s.dirty);
  const items = useSkillsStore((s) => s.items);
  const setDraft = useSkillsStore((s) => s.setDraft);
  const saveDraft = useSkillsStore((s) => s.saveDraft);
  const select = useSkillsStore((s) => s.select);
  const [saving, setSaving] = useState(false);
  if (!draft) {
    return (
      <div className="skills-editor">
        <div className="skills-editor-empty">Select a skill to edit, or create a new one.</div>
      </div>
    );
  }
  const isNew = selectedName === null;
  const extras = draft.frontmatter ?? {};
  const count = enabledCount(draft.enabled);

  const setExtraValue = (key: string, value: string) => {
    setDraft({ frontmatter: { ...extras, [key]: value } });
  };

  const renameExtra = (oldKey: string, newKey: string) => {
    if (newKey === oldKey) return;
    if (newKey !== "" && newKey in extras) {
      const next = { ...extras };
      delete next[oldKey];
      setDraft({ frontmatter: next });
      return;
    }
    setDraft({
      frontmatter: Object.fromEntries(Object.entries(extras).map(([k, v]) => [k === oldKey ? newKey : k, v]))
    });
  };

  const removeExtra = (key: string) => {
    const next = { ...extras };
    delete next[key];
    setDraft({ frontmatter: next });
  };

  const addExtra = () => {
    if ("" in extras) return;
    setDraft({ frontmatter: { ...extras, "": "" } });
  };

  const onCancel = () => {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    void select(isNew ? (items[0]?.name ?? null) : selectedName);
  };

  const onSave = async () => {
    if (saving) return;
    const name = draft.name.trim();
    if (!SKILL_NAME_PATTERN.test(name)) {
      useNotifs.getState().push({
        kind: "error",
        title: `Could not save skill '${draft.name || "(new)"}'`,
        message: "Use 1–64 lowercase letters, numbers, or hyphens."
      });
      return;
    }
    setSaving(true);
    try {
      const payload = name === draft.name ? draft : { ...draft, name };
      await saveDraft(payload);
      if (!useSkillsStore.getState().error) {
        const n = enabledCount(payload.enabled);
        useNotifs.getState().push({
          kind: "success",
          title: `/${name} saved — propagated to ${n} harness${n === 1 ? "" : "es"}`
        });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="skills-editor">
      <div className="crumb-row">
        <span className="path">
          … <span className="sep">›</span> userData <span className="sep">›</span> skills <span className="sep">›</span>{" "}
          <b>{draft.name || "new-skill"}</b> <span className="sep">›</span> <b>SKILL.md</b>
        </span>
        <span className="seg" role="tablist" aria-label="Editor view">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "preview"}
            className={tab === "preview" ? "on" : ""}
            onClick={() => setTab("preview")}
          >
            Preview
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "source"}
            className={tab === "source" ? "on" : ""}
            onClick={() => setTab("source")}
          >
            Source
          </button>
        </span>
      </div>
      <div className="harness-row">
        <span className="lbl">Sync to</span>
        {HARNESSES.map(({ id, label }) => {
          const on = draft.enabled[id];
          return (
            <button
              key={id}
              type="button"
              className={`skill-htoggle-lg${on ? " on" : ""}`}
              data-h={id}
              title={harnessTip(id, draft.name)}
              aria-label={`Sync to ${label}`}
              aria-pressed={on}
              onClick={() => setDraft({ enabled: { ...draft.enabled, [id]: !on } })}
            >
              <DriverIcon driver={id as DriverName} size={20} />
              {label}
            </button>
          );
        })}
      </div>
      <div className="ed-scroll">
        <div className="props">
          <h3>Properties</h3>
          <div className="prop-row">
            <span className="grip" aria-hidden="true">
              ☰
            </span>
            <span className="prop-key">name</span>
            <input
              className="prop-input prop-mono"
              value={draft.name}
              disabled={!isNew}
              spellCheck={false}
              autoFocus={isNew}
              aria-label="Skill name"
              onChange={(e) => setDraft({ name: e.target.value })}
            />
          </div>
          <div className="prop-row">
            <span className="grip" aria-hidden="true">
              ☰
            </span>
            <span className="prop-key">description</span>
            <input
              className="prop-input"
              value={draft.description}
              aria-label="Skill description"
              onChange={(e) => setDraft({ description: e.target.value })}
            />
          </div>
          {Object.entries(extras).map(([key, value], index) => (
            <div className="prop-row" key={index}>
              <span className="grip" aria-hidden="true">
                ☰
              </span>
              <input
                className="prop-input prop-mono prop-key-input"
                value={key}
                placeholder="key"
                spellCheck={false}
                aria-label="Property key"
                onChange={(e) => renameExtra(key, e.target.value)}
              />
              <input
                className="prop-input"
                value={value}
                placeholder="value"
                aria-label={`Value for ${key || "new property"}`}
                onChange={(e) => setExtraValue(key, e.target.value)}
              />
              <button
                type="button"
                className="icon-btn prop-remove"
                aria-label={`Remove ${key || "new property"}`}
                title={`Remove ${key || "new property"}`}
                onClick={() => removeExtra(key)}
              >
                <X size={14} />
              </button>
            </div>
          ))}
          <button type="button" className="add-prop" onClick={addExtra} disabled={"" in extras}>
            + Add property
          </button>
        </div>
        {tab === "preview" ? (
          <div className="skills-preview">
            {draft.body.trim() ? (
              <Md text={draft.body} />
            ) : (
              <div className="side-empty">Nothing to preview yet — switch to Source to write.</div>
            )}
          </div>
        ) : (
          <textarea
            className="skills-src"
            value={draft.body}
            spellCheck={false}
            aria-label="Skill body markdown"
            onChange={(e) => setDraft({ body: e.target.value })}
          />
        )}
      </div>
      <div className="ed-foot">
        <span className="status">
          {dirty || isNew ? (
            <>
              Unsaved changes · will propagate to <b>{count}/3</b>
            </>
          ) : (
            <>
              Synced to <b>{count}/3</b> harnesses · hover an icon for its path
            </>
          )}
        </span>
        <span className="sp" />
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void onSave()}
          disabled={(!dirty && !isNew) || saving}
        >
          {saving ? "Saving…" : "Save & propagate"}
        </button>
      </div>
    </div>
  );
}

export function SkillsModal({ onClose }: { onClose: () => void }) {
  const items = useSkillsStore((s) => s.items);
  const filter = useSkillsStore((s) => s.filter);
  const selectedName = useSkillsStore((s) => s.selectedName);
  const draft = useSkillsStore((s) => s.draft);
  const dirty = useSkillsStore((s) => s.dirty);
  const status = useSkillsStore((s) => s.status);
  const error = useSkillsStore((s) => s.error);
  const load = useSkillsStore((s) => s.load);
  const select = useSkillsStore((s) => s.select);
  const setFilter = useSkillsStore((s) => s.setFilter);
  const createNew = useSkillsStore((s) => s.createNew);
  const importAll = useSkillsStore((s) => s.importAll);
  const [tab, setTab] = useState<EditorTab>("preview");
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (status === "ready" && selectedName === null && draft === null && items.length > 0) {
      void select(items[0].name);
    }
  }, [status, selectedName, draft, items, select]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const state = useSkillsStore.getState();
        if (state.dirty && !window.confirm("Discard unsaved changes?")) return;
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const requestClose = () => {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    onClose();
  };

  const pick = (name: string) => {
    if (name === selectedName) return;
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    setTab("preview");
    void select(name);
  };

  const onNew = () => {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    createNew();
    setTab("source");
  };

  const onImport = async () => {
    if (importing) return;
    setImporting(true);
    try {
      await importAll();
      if (!useSkillsStore.getState().error) {
        useNotifs.getState().push({ kind: "success", title: "Skills re-imported" });
      }
    } finally {
      setImporting(false);
    }
  };

  const query = filter.trim().toLowerCase();
  const visible = query
    ? items.filter((item) => `${item.name} ${item.description}`.toLowerCase().includes(query))
    : items;

  return (
    <div className="settings-backdrop" onClick={requestClose}>
      <div className="settings-modal skills-modal" role="dialog" aria-label="Skills" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>✦ Skills</h2>
          <span className="sp" />
          <button type="button" className="btn" onClick={() => void onImport()} disabled={importing}>
            {importing ? "Re-importing…" : "↻ Re-import"}
          </button>
          <button type="button" className="btn btn-primary" onClick={onNew}>
            + New skill
          </button>
          <button type="button" className="icon-btn" aria-label="Close skills" onClick={requestClose}>
            <X size={16} />
          </button>
        </div>
        <div className="skills-main">
          <div className="skills-list">
            <div className="skills-search">
              <input
                className="field"
                value={filter}
                placeholder="Filter skills…"
                aria-label="Filter skills"
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            <div className="skills-items">
              {status === "loading" && items.length === 0 && <div className="side-empty">Loading skills…</div>}
              {status === "error" && items.length === 0 && (
                <div className="skills-list-error">
                  <div className="settings-error">{error ?? "Could not load skills"}</div>
                  <button type="button" className="btn" onClick={() => void load()}>
                    Retry
                  </button>
                </div>
              )}
              {status === "ready" && visible.length === 0 && (
                <div className="side-empty">{query ? "No matches." : "No skills yet — create one."}</div>
              )}
              {visible.map((item) => (
                <SkillRow key={item.name} meta={item} selected={item.name === selectedName} onPick={pick} />
              ))}
            </div>
          </div>
          <SkillEditor key={selectedName ?? "__new"} tab={tab} setTab={setTab} />
        </div>
      </div>
    </div>
  );
}
