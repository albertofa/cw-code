import { LOWERCASE_SHA_PATTERN, baseOf, formatVersion, parseTag, sameBase, tagOf, tryParseVersion } from "./semver.ts";

export interface ReleasePlanCandidate {
  tag: string;
  sha: string;
}

export interface ReleasePlan {
  schema: 1;
  channel: "alpha" | "stable";
  version: string;
  tag: string;
  sourceSha: string;
  candidate?: ReleasePlanCandidate;
  previousTag: string | null;
  prerelease: boolean;
  makeLatest: boolean;
  notes: string;
  createdAt: string;
}

export type PlanShapeResult = { ok: true; plan: ReleasePlan } | { ok: false; errors: string[] };

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function validateStructure(raw: unknown): { ok: true; plan: ReleasePlan } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, errors: ["Plan is not an object"] };
  }
  const value = raw as Record<string, unknown>;

  if (value.schema !== 1) errors.push(`schema must be 1, got ${JSON.stringify(value.schema)}`);
  if (value.channel !== "alpha" && value.channel !== "stable") {
    errors.push(`channel must be "alpha" or "stable", got ${JSON.stringify(value.channel)}`);
  }
  if (!isString(value.version)) errors.push("version must be a string");
  if (!isString(value.tag)) errors.push("tag must be a string");
  if (!isString(value.sourceSha)) errors.push("sourceSha must be a string");
  if (value.previousTag !== null && !isString(value.previousTag)) errors.push("previousTag must be a string or null");
  if (!isBoolean(value.prerelease)) errors.push("prerelease must be a boolean");
  if (!isBoolean(value.makeLatest)) errors.push("makeLatest must be a boolean");
  if (!isString(value.notes)) errors.push("notes must be a string");
  if (!isString(value.createdAt)) errors.push("createdAt must be a string");

  let candidate: ReleasePlanCandidate | undefined;
  if (value.candidate !== undefined) {
    const rawCandidate = value.candidate as Record<string, unknown> | null;
    if (typeof rawCandidate !== "object" || rawCandidate === null || !isString(rawCandidate.tag) || !isString(rawCandidate.sha)) {
      errors.push("candidate must be an object with string tag and sha");
    } else {
      candidate = { tag: rawCandidate.tag, sha: rawCandidate.sha };
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    plan: {
      schema: 1,
      channel: value.channel as "alpha" | "stable",
      version: value.version as string,
      tag: value.tag as string,
      sourceSha: value.sourceSha as string,
      candidate,
      previousTag: value.previousTag as string | null,
      prerelease: value.prerelease as boolean,
      makeLatest: value.makeLatest as boolean,
      notes: value.notes as string,
      createdAt: value.createdAt as string
    }
  };
}

export function validatePlanShape(raw: unknown): PlanShapeResult {
  const structural = validateStructure(raw);
  if (!structural.ok) return structural;
  const { plan } = structural;
  const errors: string[] = [];

  if (!LOWERCASE_SHA_PATTERN.test(plan.sourceSha)) {
    errors.push(`sourceSha must be a 40-character hex SHA, got "${plan.sourceSha}"`);
  }

  const version = tryParseVersion(plan.version);
  if (!version) {
    errors.push(`version "${plan.version}" is not a valid "X.Y.Z" or "X.Y.Z-alpha.N" version`);
    return { ok: false, errors };
  }

  if (version.channel !== plan.channel) {
    errors.push(`channel "${plan.channel}" does not match the shape of version "${plan.version}"`);
  }
  if (plan.tag !== tagOf(version)) {
    errors.push(`tag "${plan.tag}" must equal "v" + version ("${tagOf(version)}")`);
  }

  if (plan.channel === "alpha") {
    if (plan.prerelease !== true) errors.push("prerelease must be true for an alpha plan");
    if (plan.makeLatest !== false) errors.push("makeLatest must be false for an alpha plan");
    if (plan.candidate) errors.push("an alpha plan must not carry a candidate");
  } else {
    if (plan.prerelease !== false) errors.push("prerelease must be false for a stable plan");
    if (plan.makeLatest !== true) errors.push("makeLatest must be true for a stable plan");
    if (!plan.candidate) {
      errors.push("a stable plan must carry a candidate");
    } else {
      const candidateVersion = parseTag(plan.candidate.tag);
      if (!candidateVersion) {
        errors.push(`candidate.tag "${plan.candidate.tag}" is not a valid "vX.Y.Z-alpha.N" tag`);
      } else if (candidateVersion.channel !== "alpha") {
        errors.push(`candidate.tag "${plan.candidate.tag}" must be an alpha tag`);
      } else if (!sameBase(candidateVersion, baseOf(version))) {
        errors.push(
          `candidate base ${formatVersion(baseOf(candidateVersion))} does not match plan version base ${formatVersion(baseOf(version))}`
        );
      }
      if (!LOWERCASE_SHA_PATTERN.test(plan.candidate.sha)) {
        errors.push(`candidate.sha must be a 40-character lowercase hex SHA, got "${plan.candidate.sha}"`);
      } else if (plan.candidate.sha !== plan.sourceSha) {
        errors.push(`candidate.sha ${plan.candidate.sha} must equal sourceSha ${plan.sourceSha}`);
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, plan };
}
