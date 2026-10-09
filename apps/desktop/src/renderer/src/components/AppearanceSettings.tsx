import type { ReactNode } from "react";
import { History, Minus, Plus } from "lucide-react";
import type { AppSettings } from "../cw.js";
import {
  DEFAULT_APPEARANCE,
  DEFAULT_MONO_STACK,
  DEFAULT_SANS_STACK,
  FONT_SIZE_LIMITS,
  PANEL_ANIMATION_LIMITS,
  appearanceOf,
  fontStack,
  resolveTerminalFont
} from "../appearanceFonts.js";
import { DriverIcon } from "./DriverIcon.js";
import { FontFamilyPicker } from "./FontFamilyPicker.js";
import "./appearance.css";

type FamilyKey = "fontFamilySans" | "fontFamilyMono" | "fontFamilyPrompt" | "fontFamilyTerminal";
type SizeKey = keyof typeof FONT_SIZE_LIMITS;

function FontRow({
  title,
  description,
  familyKey,
  sizeKey,
  defaultLabel,
  requireMonospace,
  draft,
  onDraftChange,
  preview
}: {
  title: string;
  description: string;
  familyKey: FamilyKey;
  sizeKey: SizeKey;
  defaultLabel: string;
  requireMonospace?: boolean;
  draft: AppSettings;
  onDraftChange: (patch: Partial<AppSettings>) => void;
  preview: ReactNode;
}) {
  const { min, max } = FONT_SIZE_LIMITS[sizeKey];
  const size = draft[sizeKey];
  const step = (delta: number) => onDraftChange({ [sizeKey]: Math.min(max, Math.max(min, size + delta)) });
  const reset = () => onDraftChange({ [familyKey]: DEFAULT_APPEARANCE[familyKey], [sizeKey]: DEFAULT_APPEARANCE[sizeKey] });

  return (
    <div className="frow">
      <div className="fr-h">
        <div className="lab">
          {title}
          <small>{description}</small>
        </div>
        <div className="fr-c">
          <FontFamilyPicker
            value={draft[familyKey]}
            defaultLabel={defaultLabel}
            requireMonospace={requireMonospace}
            onChange={(value) => onDraftChange({ [familyKey]: value })}
          />
          <span className="step">
            <button type="button" title="Smaller" aria-label={`${title} smaller`} disabled={size <= min} onClick={() => step(-1)}>
              <Minus size={12} aria-hidden="true" />
            </button>
            <span className="v" aria-label={`${title} size`}>{size}</span>
            <span className="u">px</span>
            <button type="button" title="Larger" aria-label={`${title} larger`} disabled={size >= max} onClick={() => step(1)}>
              <Plus size={12} aria-hidden="true" />
            </button>
          </span>
          <button type="button" className="fr-reset" title={`Reset ${title.toLowerCase()}`} aria-label={`Reset ${title.toLowerCase()}`} onClick={reset}>
            <History size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
      {preview}
    </div>
  );
}

function PanelAnimationRow({ draft, onDraftChange }: { draft: AppSettings; onDraftChange: (patch: Partial<AppSettings>) => void }) {
  const { min, max, step } = PANEL_ANIMATION_LIMITS;
  const value = draft.panelAnimationMs;
  const change = (delta: number) => onDraftChange({ panelAnimationMs: Math.min(max, Math.max(min, value + delta)) });

  return (
    <div className="frow">
      <div className="fr-h">
        <div className="lab">
          Panel animation
          <small>How long the right and bottom panels take to open and close. Systems set to reduced motion always skip it.</small>
        </div>
        <div className="fr-c">
          <span className="step">
            <button type="button" title="Shorter" aria-label="Panel animation shorter" disabled={value <= min} onClick={() => change(-step)}>
              <Minus size={12} aria-hidden="true" />
            </button>
            <span className="v wide" aria-label="Panel animation duration">{value === 0 ? "Off" : value}</span>
            {value > 0 && <span className="u">ms</span>}
            <button type="button" title="Longer" aria-label="Panel animation longer" disabled={value >= max} onClick={() => change(step)}>
              <Plus size={12} aria-hidden="true" />
            </button>
          </span>
          <button
            type="button"
            className="fr-reset"
            title="Reset panel animation"
            aria-label="Reset panel animation"
            onClick={() => onDraftChange({ panelAnimationMs: DEFAULT_APPEARANCE.panelAnimationMs })}
          >
            <History size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}

export function AppearanceSettings({
  draft,
  onDraftChange
}: {
  draft: AppSettings;
  onDraftChange: (patch: Partial<AppSettings>) => void;
}) {
  const prefs = appearanceOf(draft);
  const advanced = prefs.typographyAdvanced;
  const sansStack = fontStack(prefs.fontFamilySans, DEFAULT_SANS_STACK);
  const monoStack = fontStack(prefs.fontFamilyMono, DEFAULT_MONO_STACK);
  const promptStack = fontStack(advanced ? prefs.fontFamilyPrompt : "", sansStack);
  const terminal = resolveTerminalFont(prefs);
  const promptSize = advanced ? prefs.fontSizePrompt : DEFAULT_APPEARANCE.fontSizePrompt;
  const rowProps = { draft, onDraftChange };

  const interfacePreview = (
    <div className="fprev" style={{ fontFamily: sansStack, fontSize: prefs.fontSizeInterface }}>
      <div className="fp-ws">
        <span className="fp-ws-body">
          <span className="fp-ws-title">Redesign sidebar status</span>
          <span className="fp-ws-meta">
            <span>cw-code</span>
            <span aria-hidden="true">·</span>
            <span className="fp-ws-branch" style={{ fontFamily: monoStack }}>cw/1d8f716e</span>
          </span>
        </span>
        <DriverIcon driver="claude" size={14} />
      </div>
      <div className="fp-msg">
        I mapped every selected state in the sidebar and moved them to one rule: a <code style={{ fontFamily: monoStack }}>--violet-soft</code> fill with a 2px mark.
      </div>
    </div>
  );

  const monoPreview = (
    <div className="fprev two">
      <pre className="fp-code" style={{ fontFamily: monoStack, fontSize: prefs.fontSizeCode }}>
        {".session-row.active {\n  background: var(--violet-soft);\n  font-size: 0.875rem;\n}"}
      </pre>
      <pre className="fp-term" style={{ fontFamily: terminal.family, fontSize: terminal.size }}>
        <span className="fp-term-prompt">PS cw-code&gt;</span>
        {" pnpm test\n"}
        <span className="fp-term-ok">{" ✓ 412 passed"}</span>
        {" (3.8s)\n"}
        <span className="fp-term-prompt">PS cw-code&gt;</span>
      </pre>
    </div>
  );

  const promptPreview = (
    <div className="fprev">
      <div className="fp-composer" style={{ fontFamily: promptStack, fontSize: promptSize }}>
        Fix the failing <span className="fp-composer-ref">@PrDetailView.tsx</span> snapshot
      </div>
    </div>
  );

  return (
    <>
    <section className="settings-section appearance-section" aria-label="Typography">
      <div className="tsec-h">
        <h3>Typography</h3>
        <label className="adv">
          Advanced
          <span className="settings-switch">
            <input
              type="checkbox"
              checked={advanced}
              onChange={(event) => onDraftChange({ typographyAdvanced: event.target.checked })}
              aria-label="Show advanced typography settings"
            />
            <span className="track" aria-hidden="true" />
          </span>
        </label>
      </div>
      <span className="settings-hint">Changes apply when you save settings. Previews update as you edit.</span>
      <FontRow
        {...rowProps}
        title="Interface font"
        description="Everything outside code blocks and the terminal. The size sets the root size, so rows, tabs and titles scale with it."
        familyKey="fontFamilySans"
        sizeKey="fontSizeInterface"
        defaultLabel="Segoe UI"
        preview={interfacePreview}
      />
      <FontRow
        {...rowProps}
        title="Monospace font"
        description={advanced ? "Code blocks, diffs and file previews." : "Code blocks, diffs, file previews and the terminal."}
        familyKey="fontFamilyMono"
        sizeKey="fontSizeCode"
        defaultLabel="JetBrains Mono"
        requireMonospace
        preview={monoPreview}
      />
      {advanced && (
        <>
          <FontRow
            {...rowProps}
            title="Prompt font"
            description="The composer. Follows the interface font unless set."
            familyKey="fontFamilyPrompt"
            sizeKey="fontSizePrompt"
            defaultLabel="Same as interface"
            preview={promptPreview}
          />
          <FontRow
            {...rowProps}
            title="Terminal font"
            description="Shell and harness CLI tabs. Follows the monospace font unless set."
            familyKey="fontFamilyTerminal"
            sizeKey="fontSizeTerminal"
            defaultLabel="Same as monospace"
            requireMonospace
            preview={null}
          />
        </>
      )}
    </section>
    <section className="settings-section appearance-section" aria-label="Motion">
      <div className="tsec-h">
        <h3>Motion</h3>
      </div>
      <PanelAnimationRow draft={draft} onDraftChange={onDraftChange} />
    </section>
    </>
  );
}
