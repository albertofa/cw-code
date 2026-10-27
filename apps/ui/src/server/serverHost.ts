import { useEffect, useState } from "react";
import type { CwApi, ServerHost } from "../cw.js";
import { ipcErrorMessage } from "../components/ipcError.js";

let cached: { api: CwApi; host: Promise<ServerHost> } | null = null;

export function serverHost(): Promise<ServerHost> {
  const api = window.cw;
  if (cached?.api === api) return cached.host;
  const host = api.getServerHost();
  cached = { api, host };
  host.catch(() => {
    if (cached?.host === host) cached = null;
  });
  return host;
}

export function useServerHost(): ServerHost | null {
  const [host, setHost] = useState<ServerHost | null>(null);
  useEffect(() => {
    let live = true;
    serverHost()
      .then((value) => {
        if (live) setHost(value);
      })
      .catch((err: unknown) => console.warn(`[cw-code] could not read the server host: ${ipcErrorMessage(err)}`));
    return () => {
      live = false;
    };
  }, []);
  return host;
}
