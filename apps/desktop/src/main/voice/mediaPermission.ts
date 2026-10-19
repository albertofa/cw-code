/**
 * Electron approves every permission request when no handler is set. Setting one to narrow microphone access
 * must not change that default for anything else, so only "media" is decided here.
 */
export function allowPermissionRequest(permission: string, details: { mediaTypes?: readonly string[] }): boolean {
  if (permission !== "media") return true;
  const types = details.mediaTypes ?? [];
  return types.length > 0 && types.every((type) => type === "audio");
}
