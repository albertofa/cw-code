import { useEffect, useState } from "react";

const CURRENCY_SYMBOLS: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", BRL: "R$" };

export function formatMoney(minorUnits: number, currency = "USD"): string {
  const symbol = CURRENCY_SYMBOLS[currency.toUpperCase()] ?? `${currency.toUpperCase()} `;
  return `${symbol}${(minorUnits / 100).toFixed(2)}`;
}

export function formatCostUsd(costUsd: number | null): string {
  return costUsd === null ? "—" : `$${costUsd.toFixed(2)}`;
}

const RELATIVE_TIME_REFRESH_MS = 30000;

export function useNow(intervalMs: number = RELATIVE_TIME_REFRESH_MS): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

function shortDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

export function formatResetsAt(resetsAt: number, nowMs: number = Date.now()): string {
  const diff = resetsAt - nowMs;
  if (diff <= 0) return "Resets now";
  if (diff < 24 * 60 * 60 * 1000) return `Resets in ${shortDuration(diff)}`;
  const date = new Date(resetsAt);
  if (diff < 7 * 24 * 60 * 60 * 1000) {
    const weekday = date.toLocaleDateString(undefined, { weekday: "short" });
    const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
    return `Resets ${weekday} ${time}`;
  }
  return `Resets ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}
