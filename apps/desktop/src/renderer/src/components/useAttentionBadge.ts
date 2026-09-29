import { useEffect, useRef } from "react";
import { useNeedsYouCount } from "./useNeedsYou.js";

const BADGE_SIZE = 32;
const BADGE_FILL = "#e8b44f";
const BADGE_TEXT = "#201b10";
const BADGE_MAX_DIGIT = 9;

export function badgeLabel(count: number): string {
  return count > BADGE_MAX_DIGIT ? `${BADGE_MAX_DIGIT}+` : String(count);
}

let badgeWarningLogged = false;

function warnBadgeUnavailable(): void {
  if (badgeWarningLogged) return;
  badgeWarningLogged = true;
  console.warn("cw-code: could not draw the taskbar badge");
}

function drawBadge(count: number): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = BADGE_SIZE;
  canvas.height = BADGE_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    warnBadgeUnavailable();
    return null;
  }
  const half = BADGE_SIZE / 2;
  ctx.fillStyle = BADGE_FILL;
  ctx.beginPath();
  ctx.arc(half, half, half, 0, Math.PI * 2);
  ctx.fill();
  const label = badgeLabel(count);
  ctx.fillStyle = BADGE_TEXT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `bold ${label.length > 1 ? 18 : 22}px system-ui, sans-serif`;
  ctx.fillText(label, half, half + 1);
  return canvas.toDataURL("image/png");
}

export function useAttentionBadge(): void {
  const count = useNeedsYouCount();
  const sent = useRef<number | null>(null);
  useEffect(() => {
    if (!window.cw || sent.current === count) return;
    sent.current = count;
    window.cw.setAttention({ count, badgeDataUrl: count > 0 ? drawBadge(count) : null });
  }, [count]);
}
