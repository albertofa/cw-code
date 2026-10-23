export const TEMP_BRANCH_PATTERN = /^cw\/[0-9a-f]{8}(?:-\d+)?$/;

const MAX_SLUG_LENGTH = 40;

export function slugForBranchTitle(title: string, maxLength = MAX_SLUG_LENGTH): string | null {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug || null;
}

export function branchNameForTitle(title: string): string | null {
  const slug = slugForBranchTitle(title);
  return slug ? `cw/${slug}` : null;
}

const MAX_BRANCH_LENGTH = 100;

function cleanBranchComponent(component: string): string {
  return component.replace(/^\.+/, "").replace(/(?:\.lock)+$/i, "").replace(/\.+$/, "");
}

export function sanitizeGeneratedBranch(raw: string): string | null {
  const joined = raw
    .trim()
    .replace(/^[`"'*_]+|[`"'*_]+$/g, "")
    .replace(/^refs\/heads\//, "")
    .replace(/\s+/g, "-")
    .replace(/[\x00-\x1f\x7f~^:?*[\\"'`<>|]/g, "")
    .replace(/@\{/g, "")
    .replace(/\.{2,}/g, ".")
    .split("/")
    .map(cleanBranchComponent)
    .filter(Boolean)
    .join("/")
    .replace(/^-+/, "");
  const name = joined.slice(0, MAX_BRANCH_LENGTH).replace(/[/.-]+$/, "");
  return name && name !== "@" && name !== "HEAD" ? name : null;
}

export function ownsSessionBranch(branch: string, namedBranch: string | undefined): boolean {
  return branch.startsWith("cw/") || branch === namedBranch;
}

export function shouldRenameSessionBranch(input: { temporary: boolean; hasLinks: boolean; published: boolean; shared: boolean }): boolean {
  return input.temporary && !input.hasLinks && !input.published && !input.shared;
}
