import { useEffect, useRef, useState, type ReactNode } from "react";
import { ServerClient, type ServerCallError } from "@cw-code/client";
import type { ServerInfo } from "@cw-code/contracts";
import { INFO_PATH, isServerInfo } from "@cw-code/shared/protocol";
import { wsUrlFromPage } from "@cw-code/shared/serverAddress";
import { WebLogin } from "../components/WebLogin.js";
import { useEditorBuffers } from "../stores/editorBuffers.js";
import { describeConnectionError } from "./connectionErrors.js";
import { reload, ServerConnectionView, useServerConnection } from "./connect.js";
import type { ShutdownHandlers } from "./createCwApi.js";
import { clearDeviceToken, DEVICE_TOKEN_KEY, pendingPairingToken, readDeviceToken, settlePairingToken, storeDeviceToken } from "./webToken.js";

const NO_PROFILE = { current: null };
const LINK_REJECTED = "The pairing link's token was rejected (revoked or mistyped).";
const LINK_REJECTED_FALLBACK = "The pairing link's token was rejected; this browser stays signed in with its saved device token.";

interface Mismatch {
  error: ServerCallError;
  info: ServerInfo | null;
}

interface Session {
  token: string;
  verified: boolean;
  fromLink: boolean;
}

let signingOut = false;

function hasDirtyBuffers(): boolean {
  return useEditorBuffers.getState().dirty().length > 0;
}

async function fetchServerInfo(): Promise<ServerInfo | null> {
  try {
    const response = await fetch(new URL(INFO_PATH.slice(1), window.location.href), { cache: "no-store" });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    return isServerInfo(body) ? body : null;
  } catch {
    return null;
  }
}

export function signOutOfBrowser(): void {
  if (hasDirtyBuffers() && !window.confirm("Discard unsaved editor changes and sign out of this browser?")) return;
  signingOut = true;
  clearDeviceToken();
  reload();
}

function warnOnDirtyBuffers(e: BeforeUnloadEvent): void {
  if (signingOut || !hasDirtyBuffers()) return;
  e.preventDefault();
  e.returnValue = "";
}

function initialSession(): Session | null {
  const candidate = pendingPairingToken();
  if (candidate) return { token: candidate, verified: false, fromLink: true };
  const stored = readDeviceToken();
  return stored ? { token: stored, verified: true, fromLink: false } : null;
}

function MismatchScreen({ error, info }: { error: ServerCallError; info: ServerInfo | null }) {
  const text = describeConnectionError(error, info, "web");
  return (
    <div className="server-gate" role="alert">
      <div className="preload-error">
        {text.title}: {text.message}
      </div>
      <button type="button" className="btn btn-primary" onClick={reload}>
        Reload
      </button>
    </div>
  );
}

function WebSession({
  token,
  onAccepted,
  onRejected,
  children
}: {
  token: string;
  onAccepted: () => void;
  onRejected: (message: string) => void;
  children: ReactNode;
}) {
  const [client] = useState(() => new ServerClient({ endpoint: { url: wsUrlFromPage(window.location.href), token }, client: "web", reconnect: true }));
  const [shutdownHandlers] = useState<ShutdownHandlers>(() => new Set());
  const [mismatch, setMismatch] = useState<Mismatch | null>(null);
  const connection = useServerConnection(client, null, NO_PROFILE, shutdownHandlers);
  const callbacks = useRef({ onAccepted, onRejected });
  callbacks.current = { onAccepted, onRejected };

  useEffect(() => {
    let cancelled = false;
    let accepted = false;
    const check = (): void => {
      if (client.state === "open" && !accepted) {
        accepted = true;
        callbacks.current.onAccepted();
        return;
      }
      if (client.state !== "closed") return;
      const error = client.lastError;
      if (error?.code === "unauthorized") {
        client.close();
        callbacks.current.onRejected(describeConnectionError(error, null, "web").message);
      } else if (error?.code === "protocol-mismatch") {
        setMismatch({ error, info: null });
        void fetchServerInfo().then((info) => {
          if (!cancelled) setMismatch({ error, info });
        });
      }
    };
    const offState = client.onState(check);
    check();
    return () => {
      cancelled = true;
      offState();
    };
  }, [client]);

  useEffect(() => {
    window.addEventListener("beforeunload", warnOnDirtyBuffers);
    return () => window.removeEventListener("beforeunload", warnOnDirtyBuffers);
  }, []);

  if (mismatch) return <MismatchScreen error={mismatch.error} info={mismatch.info} />;
  return (
    <ServerConnectionView client={client} connection={connection} side="web">
      {children}
    </ServerConnectionView>
  );
}

export function WebGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState(initialSession);
  const [notice, setNotice] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const current = useRef(session);
  current.current = session;

  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key !== DEVICE_TOKEN_KEY && e.key !== null) return;
      const stored = readDeviceToken();
      const active = current.current;
      if (active?.verified && stored === null) reload();
      else if (!active && stored) setSession({ token: stored, verified: true, fromLink: false });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const accept = (accepted: Session): void => {
    settlePairingToken();
    if (accepted.verified) return;
    if (!storeDeviceToken(accepted.token)) console.warn("[cw-code] could not save the device token; this browser will ask for it again after a reload");
    setSession({ ...accepted, verified: true });
  };

  const reject = (rejected: Session, message: string): void => {
    settlePairingToken();
    if (rejected.verified) clearDeviceToken(rejected.token);
    const stored = readDeviceToken();
    if (rejected.fromLink && stored && stored !== rejected.token) {
      setBanner(LINK_REJECTED_FALLBACK);
      setSession({ token: stored, verified: true, fromLink: false });
      return;
    }
    setNotice(rejected.fromLink ? LINK_REJECTED : message);
    setSession(null);
  };

  if (!session) {
    return (
      <WebLogin
        notice={notice}
        onToken={(token) => {
          setNotice(null);
          setSession({ token, verified: false, fromLink: false });
        }}
      />
    );
  }
  return (
    <>
      {banner && (
        <div className="server-banner" role="status">
          {banner}
          <button type="button" className="btn" onClick={() => setBanner(null)}>
            Dismiss
          </button>
        </div>
      )}
      <WebSession key={session.token} token={session.token} onAccepted={() => accept(session)} onRejected={(message) => reject(session, message)}>
        {children}
      </WebSession>
    </>
  );
}
