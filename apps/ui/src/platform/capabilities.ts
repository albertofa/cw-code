import type { ConnectionProfile, DesktopApi } from "@cw-code/contracts";

export interface UiCapabilities {
  desktop: boolean;
  localServer: boolean;
}

export function deriveCapabilities(desktop: DesktopApi | null | undefined, profile: ConnectionProfile | null): UiCapabilities {
  const isDesktop = desktop !== undefined && desktop !== null;
  return { desktop: isDesktop, localServer: isDesktop && profile?.kind === "local" };
}
