import { useSyncExternalStore } from "react";

type IconResolver = (name: string, isDir: boolean, expanded: boolean, light: boolean) => string | null;

let resolver: IconResolver | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function loadIcons(): void {
  loading ??= import("./materialIcons.js")
    .then((module) => {
      resolver = module.iconUrl;
      for (const listener of listeners) listener();
    })
    .catch((err: unknown) => console.warn(`[icons] file icons unavailable: ${err instanceof Error ? err.message : String(err)}`));
}

function subscribe(listener: () => void): () => void {
  loadIcons();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function useIconResolver(): IconResolver | null {
  return useSyncExternalStore(subscribe, () => resolver, () => resolver);
}

function isLightTheme(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.theme === "light";
}

export function FileIcon({
  name,
  isDir = false,
  expanded = false,
  size = 15
}: {
  name: string;
  isDir?: boolean;
  expanded?: boolean;
  size?: number;
}) {
  const resolve = useIconResolver();
  const url = resolve?.(name, isDir, expanded, isLightTheme()) ?? null;
  if (!url) return <span className="file-icon" style={{ display: "inline-block", width: size, height: size }} aria-hidden />;
  return <img src={url} width={size} height={size} className="file-icon" alt="" aria-hidden draggable={false} />;
}
