import { useState, type FormEvent } from "react";
import { parseServerAddress } from "@cw-code/shared/serverAddress";

export type LoginInput = { kind: "token"; token: string } | { kind: "link"; href: string } | { kind: "error"; message: string };

function pageBase(): string {
  return new URL(".", window.location.href).toString().replace(/\/+$/, "");
}

export function readLoginInput(raw: string): LoginInput {
  const value = raw.trim();
  if (!value) return { kind: "error", message: "Paste a device token or a pairing link." };
  if (!value.includes("://")) {
    return /\s/.test(value) ? { kind: "error", message: "A device token has no spaces." } : { kind: "token", token: value };
  }
  const parsed = parseServerAddress(value);
  if ("error" in parsed) return { kind: "error", message: `That pairing link is not valid: ${parsed.error}.` };
  if (!parsed.token) return { kind: "error", message: "That link has no #token=…; paste the full pairing link or the token alone." };
  if (parsed.httpUrl !== pageBase()) return { kind: "link", href: value };
  return { kind: "token", token: parsed.token };
}

export function WebLogin({ notice, onToken }: { notice: string | null; onToken: (token: string) => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    const input = readLoginInput(value);
    if (input.kind === "error") {
      setError(input.message);
      return;
    }
    if (input.kind === "link") {
      window.location.assign(input.href);
      return;
    }
    setError(null);
    onToken(input.token);
  };

  return (
    <div className="server-gate">
      <form className="web-login" onSubmit={submit}>
        <h1>Sign in to cw-code</h1>
        <p className="web-login-hint">
          Paste a device token or a pairing link. Create one in the cw-code desktop app under Settings, Remote access.
        </p>
        {notice && (
          <div className="web-login-error" role="alert">
            {notice}
          </div>
        )}
        <label className="web-login-label" htmlFor="web-login-token">
          Device token or pairing link
        </label>
        <input
          id="web-login-token"
          className="field"
          type="password"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-invalid={error !== null}
          aria-describedby={error ? "web-login-token-error" : undefined}
        />
        {error && (
          <div id="web-login-token-error" className="web-login-error" role="alert">
            {error}
          </div>
        )}
        <button type="submit" className="btn btn-primary">
          Connect
        </button>
      </form>
    </div>
  );
}
