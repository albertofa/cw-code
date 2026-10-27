import { tokenFromHash } from "@cw-code/shared/serverAddress";

const DEVICE_TOKEN_KEY = "cw-code:deviceToken";

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

export function clearDeviceToken(): void {
  try {
    localStorage.removeItem(DEVICE_TOKEN_KEY);
  } catch {
    return;
  }
}

export function captureHashToken(): void {
  if (window.cwDesktop || !/(^#|&)token=/.test(window.location.hash)) return;
  const token = tokenFromHash(window.location.hash);
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
  if (token && !storeDeviceToken(token)) console.warn("[cw-code] could not save the device token from the pairing link; paste it on the sign-in screen");
}
