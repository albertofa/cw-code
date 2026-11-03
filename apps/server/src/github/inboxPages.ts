import type { PrSummary } from "@cw-code/contracts";
import { parseInbox } from "./prParsers.js";

export interface InboxQueryResult {
  items: PrSummary[];
  truncated: boolean;
  error: string | null;
}

export async function fetchInboxPages(fetchPage: (after: string | null) => Promise<string>, maxPages: number): Promise<InboxQueryResult> {
  const items: PrSummary[] = [];
  let after: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    let parsed: ReturnType<typeof parseInbox>;
    try {
      parsed = parseInbox(await fetchPage(after));
    } catch (error) {
      return { items, truncated: page > 0, error: (error as Error).message || "GitHub CLI error" };
    }
    if (parsed.viewer === null) return { items, truncated: page > 0, error: "Unexpected response from GitHub" };
    items.push(...parsed.items);
    after = parsed.nextCursor;
    if (after === null) return { items, truncated: false, error: null };
  }
  return { items, truncated: true, error: null };
}

export function combineInboxQueries(results: InboxQueryResult[]): { items: PrSummary[][]; truncated: boolean; error: string | null } {
  const items = results.map((result) => result.items);
  const failure = results.find((result) => result.error !== null)?.error ?? null;
  const fetched = items.some((list) => list.length > 0);
  return {
    items,
    truncated: results.some((result) => result.truncated),
    error: failure === null ? null : fetched ? `Some results failed: ${failure}` : failure
  };
}
