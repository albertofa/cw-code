import { useEffect, useState } from "react";

const PALETTE_VARS = [
  "--project-blue",
  "--project-green",
  "--project-orange",
  "--project-violet",
  "--project-pink",
  "--project-teal",
  "--project-amber",
  "--project-red"
];

export const PALETTE_SIZE = PALETTE_VARS.length;

export interface GraphTheme {
  colors: string[];
  background: string;
  foreground: string;
}

export function paletteVar(index: number): string {
  return `var(${PALETTE_VARS[index % PALETTE_SIZE]})`;
}

function readGraphTheme(): GraphTheme {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback;
  return {
    colors: PALETTE_VARS.map((name) => read(name, "#888888")),
    background: read("--bg-deep", "#ffffff"),
    foreground: read("--fg", "#000000")
  };
}

export function useGraphTheme(): GraphTheme {
  const [theme, setTheme] = useState(readGraphTheme);
  useEffect(() => {
    const update = (): void => setTheme(readGraphTheme());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", update);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", update);
    };
  }, []);
  return theme;
}
