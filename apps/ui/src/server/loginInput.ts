import { pairingLink, parseServerAddress } from "@cw-code/shared/serverAddress";

export type LoginInput = { kind: "token"; token: string } | { kind: "navigate"; href: string } | { kind: "error"; message: string };

export function readLoginInput(raw: string, pageHref: string): LoginInput {
  const value = raw.trim();
  if (!value) return { kind: "error", message: "Paste a device token or a pairing link." };
  if (!value.includes("://")) {
    return /\s/.test(value) ? { kind: "error", message: "A device token has no spaces." } : { kind: "token", token: value };
  }
  const parsed = parseServerAddress(value);
  if ("error" in parsed) return { kind: "error", message: `That pairing link is not valid: ${parsed.error}.` };
  if (!parsed.token) return { kind: "error", message: "That link has no #token=…; paste the full pairing link or the token alone." };
  const page = parseServerAddress(pageHref);
  if ("error" in page || page.httpUrl !== parsed.httpUrl) return { kind: "navigate", href: pairingLink(parsed.httpUrl, parsed.token) };
  return { kind: "token", token: parsed.token };
}
