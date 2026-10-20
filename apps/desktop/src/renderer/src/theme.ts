import { resolveActiveTheme } from "../../shared/themes.js";
import type { CustomTheme, ThemeBase } from "./cw.js";

export const THEME_STORAGE_KEY = "cw-code:theme";
export const THEME_VARS_ATTRIBUTE = "data-theme-vars";
export const SYSTEM_LIGHT_QUERY = "(prefers-color-scheme: light)";

export interface StoredTheme {
  mode: "system" | ThemeBase;
  vars: Record<string, string>;
}

function clearThemeVars(root: HTMLElement): void {
  for (const name of (root.getAttribute(THEME_VARS_ATTRIBUTE) ?? "").split(" ")) {
    if (name) root.style.removeProperty(`--${name}`);
  }
  root.removeAttribute(THEME_VARS_ATTRIBUTE);
  root.style.removeProperty("background-color");
}

export function cacheTheme(themeId: string, customThemes: readonly CustomTheme[]): void {
  const { base, tokens } = resolveActiveTheme(themeId, customThemes, false);
  const theme: StoredTheme = { mode: themeId === "system" ? "system" : base, vars: tokens ?? {} };
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(theme));
  } catch (err) {
    console.warn(`[theme] could not cache the theme for the next launch: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function applyTheme(root: HTMLElement, themeId: string, customThemes: readonly CustomTheme[], prefersLight: boolean): ThemeBase {
  const { base, tokens } = resolveActiveTheme(themeId, customThemes, prefersLight);
  clearThemeVars(root);
  const vars = tokens ?? {};
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(`--${name}`, value);
  if (tokens) root.setAttribute(THEME_VARS_ATTRIBUTE, Object.keys(tokens).join(" "));
  if (tokens?.["gutter"]) root.style.backgroundColor = tokens["gutter"];
  root.dataset["theme"] = base;
  root.style.colorScheme = base;
  return base;
}
