import { useEffect, useState } from "react";
import type { ThemeMode } from "./cw.js";

export type ResolvedTheme = "dark" | "light";

/** index.html reads the same key before first paint, so a light theme does not flash dark at startup. */
export const THEME_STORAGE_KEY = "cw-code:theme";

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "dark" || value === "light" || value === "system";
}

export function resolveTheme(mode: ThemeMode, systemPrefersLight: boolean): ResolvedTheme {
  if (mode === "system") return systemPrefersLight ? "light" : "dark";
  return mode;
}

export function systemPrefersLight(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: light)").matches;
}

export function storedThemeMode(): ThemeMode {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(value) ? value : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(root: HTMLElement, mode: ThemeMode, prefersLight: boolean = systemPrefersLight()): ResolvedTheme {
  const resolved = resolveTheme(mode, prefersLight);
  root.dataset["theme"] = resolved;
  root.style.colorScheme = resolved;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Without storage the next launch simply starts dark until settings load.
  }
  return resolved;
}

/** The theme currently applied to the document, for surfaces that cannot read CSS variables (the terminal). */
export function useResolvedTheme(): ResolvedTheme {
  const read = (): ResolvedTheme => (document.documentElement.dataset["theme"] === "light" ? "light" : "dark");
  const [theme, setTheme] = useState<ResolvedTheme>(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    setTheme(read());
    return () => observer.disconnect();
  }, []);
  return theme;
}
