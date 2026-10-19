import { THEME_NAME_MAX_LENGTH, UNTITLED_THEME_NAME, resolveActiveTheme } from "../../../shared/themes.js";
import type { CustomTheme, ThemeBase } from "../cw.js";

export const BUILTIN_THEME_NAMES: Readonly<Record<ThemeBase, string>> = { dark: "Dark", light: "Light" };

const COPY_SUFFIX = " copy";
const TOKEN_WORDS: Readonly<Record<string, string>> = {
  bg: "background",
  fg: "foreground",
  md: "markdown",
  msg: "message"
};

export function tokenLabel(token: string): string {
  const text = token
    .split("-")
    .filter((word) => word !== "")
    .map((word) => TOKEN_WORDS[word] ?? word)
    .join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function customThemeName(theme: CustomTheme): string {
  return theme.name.trim() || UNTITLED_THEME_NAME;
}

export function activeThemeName(themeId: string, customThemes: readonly CustomTheme[], prefersLight: boolean): string {
  const custom = customThemes.find((theme) => theme.id === themeId);
  if (custom) return customThemeName(custom);
  return BUILTIN_THEME_NAMES[resolveActiveTheme(themeId, customThemes, prefersLight).base];
}

export function newCustomTheme(
  themeId: string,
  customThemes: readonly CustomTheme[],
  prefersLight: boolean,
  uuid: string
): CustomTheme {
  const { base } = resolveActiveTheme(themeId, customThemes, prefersLight);
  const source = customThemes.find((theme) => theme.id === themeId);
  const sourceName = activeThemeName(themeId, customThemes, prefersLight)
    .slice(0, THEME_NAME_MAX_LENGTH - COPY_SUFFIX.length)
    .trimEnd();
  return {
    id: `custom-${uuid.toLowerCase()}`,
    name: `${sourceName}${COPY_SUFFIX}`,
    base,
    colors: { ...(source?.colors ?? {}) }
  };
}

export function withoutColor(colors: Record<string, string>, token: string): Record<string, string> {
  return Object.fromEntries(Object.entries(colors).filter(([key]) => key !== token));
}
