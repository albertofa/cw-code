import type { HistoryRef } from "@cw-code/contracts";

export type RefLabelKind = HistoryRef["kind"] | "head";

export interface RefEntry {
  key: string;
  name: string;
  checkout: string | null;
  localElsewhere: boolean;
  kind: RefLabelKind;
  isCurrent: boolean;
  hasLocal: boolean;
  hasRemote: boolean;
}

export interface RefLabel {
  key: string;
  label: string;
  kind: RefLabelKind;
  isCurrent: boolean;
  hasLocal: boolean;
  hasRemote: boolean;
  extra: number;
  title: string;
  entries: RefEntry[];
}

interface Candidate {
  key: string;
  label: string;
  kind: RefLabelKind;
  isCurrent: boolean;
  hasRemote: boolean;
  checkout: string | null;
  localElsewhere: boolean;
}

export interface LocalBranches {
  names: ReadonlySet<string>;
  current: string | null;
}

const NO_LOCALS: LocalBranches = { names: new Set(), current: null };

function checkoutFor(ref: HistoryRef, locals: LocalBranches): { checkout: string | null; localElsewhere: boolean } {
  if (ref.kind === "local") return { checkout: ref.name, localElsewhere: false };
  if (ref.kind !== "remote") return { checkout: null, localElsewhere: false };
  const local = remoteBranchName(ref.name);
  if (!locals.names.has(local)) return { checkout: ref.name, localElsewhere: false };
  return { checkout: local === locals.current ? null : local, localElsewhere: true };
}

const KIND_ORDER: Record<RefLabelKind, number> = { head: 0, local: 1, remote: 2, tag: 3, stash: 4 };

function remoteBranchName(name: string): string {
  const slash = name.indexOf("/");
  return slash === -1 ? name : name.slice(slash + 1);
}

export function buildRefLabel(refs: HistoryRef[], detachedHead: boolean, localBranches: LocalBranches = NO_LOCALS): RefLabel | null {
  const locals = refs.filter((ref) => ref.kind === "local");
  const candidates: Candidate[] = [];
  for (const ref of refs) {
    if (ref.kind === "remote") {
      if (locals.some((local) => local.name === remoteBranchName(ref.name))) continue;
    }
    const twinRemote =
      ref.kind === "local" ? refs.find((other) => other.kind === "remote" && remoteBranchName(other.name) === ref.name) : undefined;
    candidates.push({
      key: ref.fullName,
      label: ref.name,
      kind: ref.kind,
      isCurrent: ref.isCurrent && ref.kind === "local",
      hasRemote: twinRemote !== undefined,
      ...checkoutFor(ref, localBranches),
    });
  }
  if (detachedHead) candidates.push({ key: "HEAD", label: "HEAD", kind: "head", isCurrent: true, hasRemote: false, checkout: null, localElsewhere: false });
  if (candidates.length === 0) return null;
  candidates.sort(
    (a, b) =>
      Number(b.isCurrent) - Number(a.isCurrent) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.label.localeCompare(b.label),
  );
  const [primary] = candidates;
  const names = candidates.map((candidate) => (candidate.hasRemote ? `${candidate.label} (local + remote)` : candidate.label));
  return {
    key: primary.key,
    label: primary.label,
    kind: primary.kind,
    isCurrent: primary.isCurrent,
    hasLocal: primary.kind === "local",
    hasRemote: primary.kind === "remote" || primary.hasRemote,
    extra: candidates.length - 1,
    title: names.join("\n"),
    entries: candidates.map((candidate) => ({
      key: candidate.key,
      name: candidate.label,
      checkout: candidate.checkout,
      localElsewhere: candidate.localElsewhere,
      kind: candidate.kind,
      isCurrent: candidate.isCurrent,
      hasLocal: candidate.kind === "local",
      hasRemote: candidate.kind === "remote" || candidate.hasRemote,
    })),
  };
}
