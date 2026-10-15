import type { KeyboardEvent as ReactKeyboardEvent } from "react";

const TAB_NAV_KEYS = ["ArrowLeft", "ArrowRight", "Home", "End"];
const TAB_CLOSE_KEYS = ["Delete", "Backspace"];

function stripTabs(tab: HTMLElement): HTMLElement[] {
  const list = tab.closest('[role="tablist"]');
  return list ? [...list.querySelectorAll<HTMLElement>('[role="tab"]')] : [];
}

export function nextTabIndex(key: string, current: number, count: number): number {
  const last = count - 1;
  if (key === "Home") return 0;
  if (key === "End") return last;
  if (key === "ArrowLeft") return current <= 0 ? last : current - 1;
  return current >= last ? 0 : current + 1;
}

export function focusSiblingTab(e: ReactKeyboardEvent<HTMLElement>): void {
  if (!TAB_NAV_KEYS.includes(e.key)) return;
  const target = e.target;
  if (!(target instanceof HTMLElement) || target.getAttribute("role") !== "tab") return;
  const tabs = stripTabs(target);
  if (tabs.length === 0) return;
  const next = tabs[nextTabIndex(e.key, tabs.indexOf(target), tabs.length)];
  e.preventDefault();
  next?.focus();
  next?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

export function closeTabOnKey(e: ReactKeyboardEvent<HTMLElement>, onClose: () => void): void {
  if (!TAB_CLOSE_KEYS.includes(e.key)) return;
  e.preventDefault();
  e.stopPropagation();
  const tabs = stripTabs(e.currentTarget);
  const index = tabs.indexOf(e.currentTarget);
  const neighbor = tabs[index + 1] ?? tabs[index - 1];
  onClose();
  requestAnimationFrame(() => neighbor?.focus());
}
