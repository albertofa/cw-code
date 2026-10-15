import type { CSSProperties } from "react";

export function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

const BOT_LOGIN_SUFFIX = /[bot]$/;

export function isBotLogin(login: string): boolean {
  return BOT_LOGIN_SUFFIX.test(login);
}

export function stripBotSuffix(login: string): string {
  return login.replace(BOT_LOGIN_SUFFIX, "");
}

export function projectInitials(name: string): string {
  const parts = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (parts.length === 0) return name.slice(0, 1).toUpperCase() || "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function projectAvatarStyle(name: string): CSSProperties {
  return { background: `hsl(${hashHue(name)}, 32%, 32%)` };
}
