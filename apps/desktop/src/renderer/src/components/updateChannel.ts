import type { UpdateChannel } from "../cw.js";

const ALPHA_VERSION_RE = /^\d+\.\d+\.\d+-alpha/;

export function channelOfVersion(version: string): UpdateChannel {
  return typeof version === "string" && ALPHA_VERSION_RE.test(version.trim()) ? "alpha" : "stable";
}
