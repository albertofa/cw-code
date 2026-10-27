import { useEffect, useMemo, useState } from "react";
import { History, Trash2 } from "lucide-react";
import {
  CURATED_THEME_TOKENS,
  THEME_COLOR_TOKENS,
  THEME_NAME_MAX_LENGTH,
  UNTITLED_THEME_NAME,
  deriveThemeTokens,
  isHexColor
} from "@cw-code/shared/themes";
import type { CustomTheme, ThemeBase } from "../cw.js";
import { BUILTIN_THEME_NAMES, tokenLabel, withoutColor } from "./themeChoices.js";

const THEME_BASES: readonly ThemeBase[] = ["dark", "light"];
const CURATED_TOKENS = new Set(CURATED_THEME_TOKENS.map((entry) => entry.token));
const ADVANCED_THEME_TOKENS = THEME_COLOR_TOKENS.filter((token) => !CURATED_TOKENS.has(token)).map((token) => ({
  token,
  label: tokenLabel(token)
}));

interface ColorEntry {
  token: string;
  label: string;
}

function ColorRow({
  entry,
  value,
  overridden,
  onPick,
  onReset
}: {
  entry: ColorEntry;
  value: string;
  overridden: boolean;
  onPick: (token: string, value: string) => void;
  onReset: (token: string) => void;
}) {
  const id = `theme-color-${entry.token}`;
  return (
    <div className={`tcol${overridden ? " set" : ""}`}>
      <input
        id={id}
        type="color"
        className="tcol-input"
        value={value}
        aria-label={entry.label}
        onChange={(event) => onPick(entry.token, event.target.value)}
      />
      <label htmlFor={id} className="tcol-lab">
        <span>{entry.label}</span>
        <small>{value}</small>
      </label>
      {overridden ? (
        <button
          type="button"
          className="fr-reset"
          title={`Reset ${entry.label.toLowerCase()}`}
          aria-label={`Reset ${entry.label.toLowerCase()}`}
          onClick={() => onReset(entry.token)}
        >
          <History size={14} aria-hidden="true" />
        </button>
      ) : (
        <span className="tcol-slot" aria-hidden="true" />
      )}
    </div>
  );
}

function ColorGrid({
  entries,
  tokens,
  colors,
  onPick,
  onReset
}: {
  entries: readonly ColorEntry[];
  tokens: Record<string, string>;
  colors: Record<string, string>;
  onPick: (token: string, value: string) => void;
  onReset: (token: string) => void;
}) {
  return (
    <div className="tcol-grid">
      {entries.map((entry) => {
        const value = tokens[entry.token];
        if (!isHexColor(value)) return null;
        return (
          <ColorRow
            key={entry.token}
            entry={entry}
            value={value}
            overridden={entry.token in colors}
            onPick={onPick}
            onReset={onReset}
          />
        );
      })}
    </div>
  );
}

export function ThemeEditor({
  theme,
  autoFocusName,
  onNameFocused,
  onChange,
  onDelete
}: {
  theme: CustomTheme;
  autoFocusName: boolean;
  onNameFocused: () => void;
  onChange: (next: CustomTheme) => void;
  onDelete: () => void;
}) {
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => {
    if (autoFocusName) onNameFocused();
  }, [autoFocusName, onNameFocused]);

  const tokens = useMemo(() => deriveThemeTokens(theme.base, theme.colors), [theme.base, theme.colors]);
  const pinsShades = Object.keys(theme.colors).some((token) => !CURATED_TOKENS.has(token));
  const hasOverrides = Object.keys(theme.colors).length > 0;
  const pickColor = (token: string, value: string) => onChange({ ...theme, colors: { ...theme.colors, [token]: value.toLowerCase() } });
  const resetColor = (token: string) => onChange({ ...theme, colors: withoutColor(theme.colors, token) });

  return (
    <div className="theme-editor">
      <div className="frow">
        <div className="fr-h">
          <label className="lab" htmlFor="theme-name">
            Name
            <small>Shown on the theme card.</small>
          </label>
          <div className="fr-c">
            <input
              id="theme-name"
              type="text"
              className="field theme-name"
              value={theme.name}
              maxLength={THEME_NAME_MAX_LENGTH}
              placeholder={UNTITLED_THEME_NAME}
              autoFocus={autoFocusName}
              onChange={(event) => onChange({ ...theme, name: event.target.value })}
            />
          </div>
        </div>
      </div>
      <div className="frow">
        <div className="fr-h">
          <div className="lab">
            Base
            <small>Every color you leave unset comes from this theme.</small>
          </div>
          <div className="fr-c">
            <span className="seg theme-base" role="group" aria-label="Base theme">
              {THEME_BASES.map((base) => (
                <button
                  key={base}
                  type="button"
                  className={theme.base === base ? "on" : ""}
                  aria-pressed={theme.base === base}
                  onClick={() => onChange({ ...theme, base })}
                >
                  {BUILTIN_THEME_NAMES[base]}
                </button>
              ))}
            </span>
          </div>
        </div>
      </div>
      <div className="frow">
        <div className="fr-h">
          <div className="lab">
            Colors
            <small>
              {pinsShades
                ? "Colors set in Advanced stay fixed when you change the ones above; reset them there to let them follow."
                : "Lighter and darker shades follow each color you set. Advanced lists every color for exact control."}
            </small>
          </div>
          <div className="fr-c">
            <label className="adv">
              Advanced
              <span className="settings-switch">
                <input
                  type="checkbox"
                  checked={advanced}
                  onChange={(event) => setAdvanced(event.target.checked)}
                  aria-label="Show every theme color"
                />
                <span className="track" aria-hidden="true" />
              </span>
            </label>
            <button type="button" className="btn sp-btn-sm" disabled={!hasOverrides} onClick={() => onChange({ ...theme, colors: {} })}>
              Reset all colors
            </button>
          </div>
        </div>
        <ColorGrid entries={CURATED_THEME_TOKENS} tokens={tokens} colors={theme.colors} onPick={pickColor} onReset={resetColor} />
        {advanced && (
          <>
            <div className="tcol-sub">
              All colors
              <small>Setting one here replaces the shade derived from the colors above.</small>
            </div>
            <ColorGrid entries={ADVANCED_THEME_TOKENS} tokens={tokens} colors={theme.colors} onPick={pickColor} onReset={resetColor} />
          </>
        )}
      </div>
      <div className="frow">
        <div className="fr-h">
          <div className="lab">
            Delete theme
            <small>Removes it and switches to {BUILTIN_THEME_NAMES[theme.base]}. Discarding unsaved settings brings it back.</small>
          </div>
          <div className="fr-c">
            <button type="button" className="btn btn-danger sp-btn-sm" onClick={onDelete}>
              <Trash2 size={12} aria-hidden="true" /> Delete theme
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
