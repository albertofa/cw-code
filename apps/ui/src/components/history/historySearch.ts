export type HistorySearchScope = "everything" | "messages" | "authors" | "refs" | "ids";

export const HISTORY_SEARCH_SCOPES: { id: HistorySearchScope; label: string }[] = [
  { id: "everything", label: "Everything" },
  { id: "messages", label: "Messages" },
  { id: "authors", label: "Authors" },
  { id: "refs", label: "Branches & tags" },
  { id: "ids", label: "Commit ids" }
];

export type HistorySearchField = "any" | "message" | "author" | "ref" | "sha";

export interface HistorySearchTerm {
  field: HistorySearchField;
  value: string;
}

export interface HistoryQuery {
  terms: HistorySearchTerm[];
}

export interface HistorySearchTarget {
  sha: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  refs: readonly string[];
}

const PREFIXES: Record<string, HistorySearchField> = {
  author: "author",
  branch: "ref",
  tag: "ref",
  sha: "sha",
  message: "message"
};

const SCOPE_FIELD: Record<HistorySearchScope, HistorySearchField> = {
  everything: "any",
  messages: "message",
  authors: "author",
  refs: "ref",
  ids: "sha"
};

const TOKEN = /([A-Za-z]+):(?:"([^"]*)"?|(\S*))|"([^"]*)"?|(\S+)/g;

export function parseHistoryQuery(text: string, scope: HistorySearchScope): HistoryQuery {
  const terms: HistorySearchTerm[] = [];
  const plain = SCOPE_FIELD[scope];
  for (const match of text.matchAll(TOKEN)) {
    const [whole, prefix, quotedValue, bareValue, quoted, bare] = match;
    if (prefix !== undefined) {
      const field = PREFIXES[prefix.toLowerCase()];
      const value = (quotedValue ?? bareValue ?? "").trim().toLowerCase();
      if (field) {
        if (value) terms.push({ field, value });
      } else {
        terms.push({ field: plain, value: whole.toLowerCase() });
      }
      continue;
    }
    const value = (quoted ?? bare ?? "").trim().toLowerCase();
    if (value) terms.push({ field: plain, value });
  }
  return { terms };
}

export function isEmptyQuery(query: HistoryQuery): boolean {
  return query.terms.length === 0;
}

function matchesTerm(term: HistorySearchTerm, target: HistorySearchTarget): boolean {
  const { value } = term;
  const message = (): boolean => target.subject.toLowerCase().includes(value);
  const author = (): boolean => target.authorName.toLowerCase().includes(value) || target.authorEmail.toLowerCase().includes(value);
  const ref = (): boolean => target.refs.some((name) => name.toLowerCase().includes(value));
  const sha = (): boolean => target.sha.toLowerCase().startsWith(value);
  switch (term.field) {
    case "message":
      return message();
    case "author":
      return author();
    case "ref":
      return ref();
    case "sha":
      return sha();
    case "any":
      return message() || author() || ref() || sha();
  }
}

export function matchesQuery(query: HistoryQuery, target: HistorySearchTarget): boolean {
  return query.terms.every((term) => matchesTerm(term, target));
}
