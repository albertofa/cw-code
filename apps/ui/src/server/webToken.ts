import { tokenFromHash } from "@cw-code/shared/serverAddress";

export const DEVICE_TOKEN_KEY = "cw-code:deviceToken";

let pairingCandidate: string | null = null;

export function readDeviceToken(): string | null {
  try {
    return localStorage.getItem(DEVICE_TOKEN_KEY) || null;
  } catch {
    return null;
  }
}

export function storeDeviceToken(token: string): boolean {
  try {
    localStorage.setItem(DEVICE_TOKEN_KEY, token);
    return true;
  } catch {
    return false;
  }
}

export function clearDeviceToken(expected?: string): void {
  if (expected !== undefined && readDeviceToken() !== expected) return;
  try {
    localStorage.removeItem(DEVICE_TOKEN_KEY);
  } catch {
    console.warn("[cw-code] could not remove the saved device token");
  }
}

export function pendingPairingToken(): string | null {
  return pairingCandidate;
}

export function settlePairingToken(): void {
  pairingCandidate = null;
}

export function captureHashToken(): void {
  if (window.cwDesktop || !/(^#|&)token=/.test(window.location.hash)) return;
  const token = tokenFromHash(window.location.hash);
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
  pairingCandidate = token;
}
