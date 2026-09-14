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
