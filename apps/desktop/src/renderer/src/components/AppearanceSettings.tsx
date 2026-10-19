import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { History, Minus, Plus } from "lucide-react";
import { MAX_CUSTOM_THEMES, THEME_PALETTES, deriveThemeTokens } from "../../../shared/themes.js";
import type { AppSettings, CustomTheme } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { SYSTEM_LIGHT_QUERY } from "../theme.js";
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
import { useConfirm } from "./ConfirmDialog.js";
import { DriverIcon } from "./DriverIcon.js";
import { FontFamilyPicker } from "./FontFamilyPicker.js";
import { sameValue } from "./settingsSections.js";
import { ThemeEditor } from "./ThemeEditor.js";
import { customThemeName, newCustomTheme } from "./themeChoices.js";
import "./appearance.css";

type SwatchStyle = CSSProperties & Record<`--sw-${string}`, string>;
type Palette = Record<string, string>;

const SWATCH_TOKENS = ["gutter", "bg", "card", "border", "text", "muted", "violet"] as const;

const BUILTIN_CHOICES: readonly { id: string; label: string; hint: string; scenes: readonly Palette[] }[] = [
  { id: "dark", label: "Dark", hint: "Deep slate with a violet accent.", scenes: [THEME_PALETTES.dark] },
  { id: "light", label: "Light", hint: "Cool neutrals with a violet accent.", scenes: [THEME_PALETTES.light] },
  { id: "system", label: "System", hint: "Follows your operating system.", scenes: [THEME_PALETTES.dark, THEME_PALETTES.light] }
];

function prefersLight(): boolean {
  return window.matchMedia(SYSTEM_LIGHT_QUERY).matches;
}

function swatchStyle(tokens: Palette): SwatchStyle {
  const style: SwatchStyle = {};
  for (const token of SWATCH_TOKENS) style[`--sw-${token}`] = tokens[token] ?? "";
  return style;
}

function ThemeSwatch({ scenes }: { scenes: readonly Palette[] }) {
  return (
    <span className="theme-swatch" aria-hidden="true">
      {scenes.map((tokens, index) => (
        <span key={index} className={`tsw-scene${index > 0 ? " second" : ""}`} style={swatchStyle(tokens)}>
          <span className="tsw-win">
            <span className="tsw-card">
              <span className="tsw-lines">
                <span className="tsw-line" />
                <span className="tsw-line short" />
              </span>
              <span className="tsw-dot" />
            </span>
          </span>
        </span>
      ))}
    </span>
  );
}

interface ThemeCardProps {
  label: string;
  hint: string;
  scenes: readonly Palette[];
  selected: boolean;
  focusable: boolean;
  register: (element: HTMLButtonElement | null) => void;
  onSelect: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

function ThemeCard({ label, hint, scenes, selected, focusable, register, onSelect, onKeyDown }: ThemeCardProps) {
  return (
    <button
      ref={register}
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={focusable ? 0 : -1}
      className="theme-choice"
      onClick={onSelect}
      onKeyDown={onKeyDown}
    >
      <ThemeSwatch scenes={scenes} />
      <span className="theme-choice-label">{label}</span>
      <small>{hint}</small>
    </button>
  );
}

function CustomThemeCard({ theme, ...props }: { theme: CustomTheme } & Omit<ThemeCardProps, "label" | "hint" | "scenes">) {
  const scenes = useMemo(() => [deriveThemeTokens(theme.base, theme.colors)], [theme.base, theme.colors]);
  return <ThemeCard {...props} label={customThemeName(theme)} hint={theme.base === "light" ? "Based on Light." : "Based on Dark."} scenes={scenes} />;
}

const NEXT_INDEX: Readonly<Record<string, (index: number, count: number) => number>> = {
  ArrowRight: (index, count) => (index + 1) % count,
  ArrowDown: (index, count) => (index + 1) % count,
  ArrowLeft: (index, count) => (index - 1 + count) % count,
  ArrowUp: (index, count) => (index - 1 + count) % count,
  Home: () => 0,
  End: (_index, count) => count - 1
};

function useThemePreview(themeId: string, customThemes: CustomTheme[], previewing: boolean): void {
  const setThemePreview = useAppStore((s) => s.setThemePreview);

  useEffect(() => {
    setThemePreview(previewing ? { themeId, customThemes } : null);
  }, [setThemePreview, previewing, themeId, customThemes]);

  useEffect(() => () => setThemePreview(null), [setThemePreview]);
}

function ThemeSection({ draft, onDraftChange }: { draft: AppSettings; onDraftChange: (patch: Partial<AppSettings>) => void }) {
  const { themeId, customThemes } = draft;
  const saved = useAppStore((s) => s.appearance);
  const { confirm, dialog } = useConfirm();
  const radios = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterDelete = useRef<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const previewing = !sameValue(themeId, saved.themeId) || !sameValue(customThemes, saved.customThemes);
  useThemePreview(themeId, customThemes, previewing);

  useEffect(() => {
    const id = focusAfterDelete.current;
    if (id === null) return;
    focusAfterDelete.current = null;
    radios.current.get(id)?.focus();
  }, [themeId, customThemes]);

  const ids = [...BUILTIN_CHOICES.map((choice) => choice.id), ...customThemes.map((theme) => theme.id)];
  const focusableId = ids.includes(themeId) ? themeId : ids[0];
  const editing = customThemes.find((theme) => theme.id === themeId);
  const atLimit = customThemes.length >= MAX_CUSTOM_THEMES;

  const select = (id: string) => {
    if (id !== themeId) onDraftChange({ themeId: id });
  };

  const cardProps = (id: string, index: number) => ({
    selected: id === themeId,
    focusable: id === focusableId,
    register: (element: HTMLButtonElement | null) => {
      if (element) radios.current.set(id, element);
      else radios.current.delete(id);
    },
    onSelect: () => select(id),
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
      const next = NEXT_INDEX[event.key];
      if (!next) return;
      event.preventDefault();
      const nextId = ids[next(index, ids.length)];
      if (!nextId) return;
      select(nextId);
      radios.current.get(nextId)?.focus();
    }
  });

  const createTheme = () => {
    if (atLimit) return;
    const theme = newCustomTheme(themeId, customThemes, prefersLight(), crypto.randomUUID());
    setCreatedId(theme.id);
    onDraftChange({ customThemes: [...customThemes, theme], themeId: theme.id });
  };

  const updateTheme = (next: CustomTheme) =>
    onDraftChange({ customThemes: customThemes.map((theme) => (theme.id === next.id ? next : theme)) });

  const deleteTheme = async (theme: CustomTheme) => {
    const ok = await confirm({
      title: `Delete ${customThemeName(theme)}?`,
      message: "The theme and its colors are removed when you save settings.",
      danger: true,
      confirmLabel: "Delete theme"
    });
    if (!ok) return;
    focusAfterDelete.current = theme.base;
    onDraftChange({ customThemes: customThemes.filter((entry) => entry.id !== theme.id), themeId: theme.base });
  };

  return (
    <section className="settings-section appearance-section" aria-label="Theme">
      <div className="tsec-h">
        <h3>Theme</h3>
      </div>
      <span className="settings-hint theme-previewing" role="status">
        {previewing ? "Previewing — save to keep these colors." : ""}
      </span>
      <div className="theme-picker">
        <div className="theme-choices" role="radiogroup" aria-label="Theme">
          {BUILTIN_CHOICES.map((choice, index) => (
            <ThemeCard key={choice.id} {...cardProps(choice.id, index)} label={choice.label} hint={choice.hint} scenes={choice.scenes} />
          ))}
          {customThemes.map((theme, index) => (
            <CustomThemeCard key={theme.id} theme={theme} {...cardProps(theme.id, BUILTIN_CHOICES.length + index)} />
          ))}
        </div>
        <button type="button" className="theme-new" aria-disabled={atLimit} onClick={createTheme}>
          <Plus size={16} aria-hidden="true" />
          <span className="theme-choice-label">New theme</span>
          <small>{atLimit ? `You've reached the limit of ${MAX_CUSTOM_THEMES} themes.` : "Starts as a copy of the selected theme."}</small>
        </button>
      </div>
      {editing && (
        <ThemeEditor
          key={editing.id}
          theme={editing}
          autoFocusName={editing.id === createdId}
          onNameFocused={() => setCreatedId(null)}
          onChange={updateTheme}
          onDelete={() => void deleteTheme(editing)}
        />
      )}
      {dialog}
    </section>
  );
}

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
    <ThemeSection draft={draft} onDraftChange={onDraftChange} />
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
