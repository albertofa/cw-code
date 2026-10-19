import { useEffect } from "react";
import { applyTheme, cacheTheme, SYSTEM_LIGHT_QUERY } from "../theme.js";
import { useAppStore } from "../stores/appStore.js";

export function ThemeSync(): null {
  const settingsLoaded = useAppStore((s) => s.settingsLoaded);
  const themeId = useAppStore((s) => s.appearance.themeId);
  const customThemes = useAppStore((s) => s.appearance.customThemes);
  const themePreview = useAppStore((s) => s.themePreview);
  const shownThemeId = themePreview?.themeId ?? themeId;
  const shownCustomThemes = themePreview?.customThemes ?? customThemes;
  const previewing = themePreview !== null;

  useEffect(() => {
    if (settingsLoaded) cacheTheme(themeId, customThemes);
  }, [settingsLoaded, themeId, customThemes]);

  useEffect(() => {
    if (!settingsLoaded) return;
    const media = window.matchMedia(SYSTEM_LIGHT_QUERY);
    const apply = () => applyTheme(document.documentElement, shownThemeId, shownCustomThemes, media.matches);
    const frame = previewing ? requestAnimationFrame(apply) : 0;
    if (!previewing) apply();
    const followSystem = shownThemeId === "system";
    if (followSystem) media.addEventListener("change", apply);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      if (followSystem) media.removeEventListener("change", apply);
    };
  }, [settingsLoaded, previewing, shownThemeId, shownCustomThemes]);

  return null;
}
