import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import type { ConnectionList, ConnectionProfile, ConnectionTestResult, DesktopConnections, TokenStorage } from "@cw-code/contracts";
import { ipcErrorMessage } from "./ipcError.js";

type RemoteProfile = Extract<ConnectionProfile, { kind: "remote" }>;

interface Draft {
  id: string | null;
  name: string;
  url: string;
  token: string;
}

const EMPTY_DRAFT: Draft = { id: null, name: "", url: "", token: "" };

const STORAGE_WARNINGS: Partial<Record<TokenStorage, string>> = {
  basic: "No system keyring was found, so device tokens are saved with basic obfuscation only. Anyone with access to your user folder can read them.",
  plain: "Encryption is unavailable on this system, so device tokens are saved unencrypted in the cw-code data folder."
};

function testSummary(result: ConnectionTestResult): string {
  if (result.ok) return `Connected to cw-code v${result.info.version}.`;
  return result.message;
}

function draftOf(profile: RemoteProfile): Draft {
  return { id: profile.id, name: profile.name, url: profile.url, token: "" };
}

function ConnectionEditor({
  connections,
  initial,
  onDone
}: {
  connections: DesktopConnections;
  initial: Draft;
  onDone: (saved: boolean) => void;
}) {
  const formId = useId();
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const editing = draft.id !== null;

  const patch = (next: Partial<Draft>): void => {
    setDraft((current) => ({ ...current, ...next }));
    setResult(null);
  };

  const test = async (): Promise<void> => {
    setBusy("test");
    try {
      const outcome = await connections.test({
        url: draft.url,
        ...(draft.token.trim() ? { token: draft.token.trim() } : {}),
        ...(draft.id ? { id: draft.id } : {})
      });
      setResult({ ok: outcome.ok, text: testSummary(outcome) });
    } catch (err) {
      setResult({ ok: false, text: ipcErrorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const save = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setBusy("save");
    try {
      await connections.save({
        ...(draft.id ? { id: draft.id } : {}),
        name: draft.name,
        url: draft.url,
        ...(draft.token.trim() ? { token: draft.token.trim() } : {})
      });
      onDone(true);
    } catch (err) {
      setResult({ ok: false, text: ipcErrorMessage(err) });
      setBusy(null);
    }
  };

  return (
    <form className="connections-editor" onSubmit={(e) => void save(e)} aria-label={editing ? "Edit connection" : "Add connection"}>
      <label className="connections-label" htmlFor={`${formId}-name`}>
        Name
      </label>
      <input
        id={`${formId}-name`}
        className="field"
        value={draft.name}
        placeholder="Studio desktop"
        autoFocus
        onChange={(e) => patch({ name: e.target.value })}
      />
      <label className="connections-label" htmlFor={`${formId}-url`}>
        Server address
      </label>
      <input
        id={`${formId}-url`}
        className="field"
        value={draft.url}
        placeholder="https://cw.example.com or a pairing link"
        autoCapitalize="off"
        spellCheck={false}
        onChange={(e) => patch({ url: e.target.value })}
      />
      <label className="connections-label" htmlFor={`${formId}-token`}>
        Device token
      </label>
      <input
        id={`${formId}-token`}
        className="field"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={draft.token}
        placeholder={editing ? "Leave empty to keep the saved token" : "Not needed when the address is a pairing link"}
        onChange={(e) => patch({ token: e.target.value })}
      />
      {result && (
        <div className={result.ok ? "connections-result" : "connections-result connections-error"} role={result.ok ? "status" : "alert"}>
          {result.text}
        </div>
      )}
      <div className="connections-actions">
        <button type="button" className="btn" disabled={busy !== null} onClick={() => onDone(false)}>
          Cancel
        </button>
        <button type="button" className="btn" disabled={busy !== null || !draft.url.trim()} onClick={() => void test()}>
          {busy === "test" ? "Testing…" : "Test"}
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy !== null}>
          {busy === "save" ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

export function ConnectionsPanel({ connections }: { connections: DesktopConnections }) {
  const [list, setList] = useState<ConnectionList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Draft | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setList(await connections.list());
      setError(null);
    } catch (err) {
      setError(`Could not load the saved connections: ${ipcErrorMessage(err)}`);
    }
  }, [connections]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const remove = async (profile: RemoteProfile): Promise<void> => {
    try {
      await connections.remove(profile.id);
      await refresh();
    } catch (err) {
      setError(`Could not remove ${profile.name}: ${ipcErrorMessage(err)}`);
    }
  };

  const finishEditing = (saved: boolean): void => {
    setEditing(null);
    if (saved) void refresh();
  };

  const warning = list ? STORAGE_WARNINGS[list.tokenStorage] : undefined;

  return (
    <div className="connections-panel">
      {warning && (
        <div className="connections-warning" role="note">
          {warning}
        </div>
      )}
      {list?.warning && (
        <div className="connections-warning" role="alert">
          {list.warning}
        </div>
      )}
      {error && (
        <div className="connections-error" role="alert">
          {error}
        </div>
      )}
      {list && (
        <ul className="connections-list" aria-label="Connections">
          {list.profiles.map((profile) => {
            const active = profile.id === list.activeId;
            return (
              <li key={profile.id} className="connections-row">
                <div className="connections-row-text">
                  <span className="connections-row-name">
                    {profile.name}
                    {active && <span className="connections-active">Active</span>}
                  </span>
                  <span className="connections-row-meta">{profile.kind === "remote" ? profile.url : "The server on this computer"}</span>
                </div>
                <div className="connections-row-actions">
                  {profile.kind === "remote" && (
                    <>
                      <button
                        type="button"
                        className="btn"
                        disabled={editing !== null || active}
                        title={active ? "Switch to another connection before editing this one" : undefined}
                        onClick={() => setEditing(draftOf(profile))}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger"
                        disabled={active}
                        title={active ? "Switch to another connection before removing this one" : undefined}
                        onClick={() => void remove(profile)}
                      >
                        Remove
                      </button>
                    </>
                  )}
                  {!active && (
                    <button type="button" className="btn btn-primary" onClick={() => connections.activate(profile.id)}>
                      Switch
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {editing ? (
        <ConnectionEditor key={editing.id ?? "new"} connections={connections} initial={editing} onDone={finishEditing} />
      ) : (
        <div className="connections-actions">
          <button type="button" className="btn" onClick={() => setEditing(EMPTY_DRAFT)}>
            Add connection
          </button>
        </div>
      )}
      <p className="connections-hint">Switching reopens cw-code against the chosen server. Leaving This computer stops its server, even with Keep server running on.</p>
    </div>
  );
}
