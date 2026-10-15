import { INBOX_SEARCH_LIMIT } from "./prQueries.js";

export const MAX_COUNT_QUERIES = 20;

const ISSUE_SUMMARY_FIELDS = `
  number
  url
  title
  state
  stateReason
  author {
    login
    __typename
  }
  assignees(first: 10) {
    nodes {
      login
    }
  }
  labels(first: 20) {
    nodes {
      name
    }
  }
  milestone {
    title
  }
  commentCount: comments {
    totalCount
  }
  closedByPullRequestsReferences(first: 5) {
    nodes {
      number
      url
      state
      isDraft
    }
  }
  createdAt
  updatedAt
`;

export const ISSUE_SEARCH_QUERY = `
query($q: String!, $open: String!, $closed: String!) {
  viewer {
    login
  }
  results: search(type: ISSUE, first: ${INBOX_SEARCH_LIMIT}, query: $q) {
    issueCount
    nodes {
      ... on Issue {
        __typename
${ISSUE_SUMMARY_FIELDS}
      }
    }
  }
  open: search(type: ISSUE, first: 0, query: $open) {
    issueCount
  }
  closed: search(type: ISSUE, first: 0, query: $closed) {
    issueCount
  }
}
`;

export const ISSUE_DETAIL_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  viewer {
    login
  }
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
${ISSUE_SUMMARY_FIELDS}
      body
      comments(last: 20) {
        nodes {
          author {
            login
          }
          body
          createdAt
        }
      }
    }
  }
}
`;

export function countsQuery(count: number): string {
  const variables = Array.from({ length: count }, (_, index) => `$c${index}: String!`).join(", ");
  const aliases = Array.from(
    { length: count },
    (_, index) => `  c${index}: search(type: ISSUE, first: 0, query: $c${index}) {\n    issueCount\n  }`
  ).join("\n");
  return `query(${variables}) {\n${aliases}\n}`;
}
