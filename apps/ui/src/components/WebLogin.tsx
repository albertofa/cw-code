import { useState, type FormEvent } from "react";
import { readLoginInput } from "../server/loginInput.js";

export function WebLogin({ notice, onToken }: { notice: string | null; onToken: (token: string) => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    const input = readLoginInput(value, window.location.href);
    if (input.kind === "error") {
      setError(input.message);
      return;
    }
    if (input.kind === "navigate") {
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
