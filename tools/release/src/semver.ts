export interface StableVersion {
  channel: "stable";
  major: number;
  minor: number;
  patch: number;
}

export interface AlphaVersion {
  channel: "alpha";
  major: number;
  minor: number;
  patch: number;
  alphaNumber: number;
}

export type ParsedVersion = StableVersion | AlphaVersion;

const INTEGER_LITERAL = /^(0|[1-9]\d*)$/;
const STABLE_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const ALPHA_PATTERN = /^(\d+)\.(\d+)\.(\d+)-alpha\.(\d+)$/;

function toInteger(literal: string, field: string, input: string): number {
  if (!INTEGER_LITERAL.test(literal)) {
    throw new Error(`Invalid version "${input}": ${field} "${literal}" has a leading zero or is not a non-negative integer`);
  }
  return Number.parseInt(literal, 10);
}

export function parseVersion(input: string): ParsedVersion {
  const alphaMatch = ALPHA_PATTERN.exec(input);
  if (alphaMatch) {
    const [, major, minor, patch, alphaNumber] = alphaMatch;
    return {
      channel: "alpha",
      major: toInteger(major, "major", input),
      minor: toInteger(minor, "minor", input),
      patch: toInteger(patch, "patch", input),
      alphaNumber: toInteger(alphaNumber, "alphaNumber", input)
    };
  }
  const stableMatch = STABLE_PATTERN.exec(input);
  if (stableMatch) {
    const [, major, minor, patch] = stableMatch;
    return {
      channel: "stable",
      major: toInteger(major, "major", input),
      minor: toInteger(minor, "minor", input),
      patch: toInteger(patch, "patch", input)
    };
  }
  throw new Error(`Invalid version "${input}": expected "X.Y.Z" or "X.Y.Z-alpha.N"`);
}

export function tryParseVersion(input: string): ParsedVersion | null {
  try {
    return parseVersion(input);
  } catch {
    return null;
  }
}

export function formatVersion(version: ParsedVersion): string {
  const base = `${version.major}.${version.minor}.${version.patch}`;
  return version.channel === "stable" ? base : `${base}-alpha.${version.alphaNumber}`;
}

export function baseOf(version: ParsedVersion): StableVersion {
  return { channel: "stable", major: version.major, minor: version.minor, patch: version.patch };
}

export function sameBase(a: ParsedVersion, b: ParsedVersion): boolean {
  return a.major === b.major && a.minor === b.minor && a.patch === b.patch;
}

export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.channel === "alpha" && b.channel === "alpha") return a.alphaNumber - b.alphaNumber;
  if (a.channel === b.channel) return 0;
  return a.channel === "stable" ? 1 : -1;
}

export function tagOf(version: ParsedVersion): string {
  return `v${formatVersion(version)}`;
}

export function parseTag(tag: string): ParsedVersion | null {
  if (!tag.startsWith("v")) return null;
  return tryParseVersion(tag.slice(1));
}

export const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/i;

export function isFullSha(value: string): boolean {
  return FULL_SHA_PATTERN.test(value);
}
