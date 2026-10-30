import { createHash, randomBytes } from "node:crypto";
import { tokensEqual } from "../transport/ownerToken.js";

interface TokenEntry {
  sessionId: string;
  token: string;
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class AgentTokens {
  private bySession = new Map<string, string>();
  private byDigest = new Map<string, TokenEntry>();

  tokenFor(sessionId: string): string {
    const existing = this.bySession.get(sessionId);
    if (existing !== undefined) return existing;
    const token = randomBytes(32).toString("base64url");
    this.bySession.set(sessionId, token);
    this.byDigest.set(digest(token), { sessionId, token });
    return token;
  }

  verify(token: string): { sessionId: string } | null {
    const entry = this.byDigest.get(digest(token));
    if (!entry || !tokensEqual(entry.token, token)) return null;
    return { sessionId: entry.sessionId };
  }

  revoke(sessionId: string): void {
    const token = this.bySession.get(sessionId);
    if (token === undefined) return;
    this.bySession.delete(sessionId);
    this.byDigest.delete(digest(token));
  }
}
