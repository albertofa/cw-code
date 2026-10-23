import { INBOX_SEARCH_LIMIT } from "./prQueries.js";

export const MAX_RUN_REPOS = 20;
export const MAX_RUN_ORGS = 5;
const SUITES_PER_COMMIT = 20;
const CHECK_RUNS_PER_SUITE = 50;

function suiteFields(paging: "first" | "last"): string {
  return `
checkSuites(${paging}: ${SUITES_PER_COMMIT}) {
  nodes {
    status
    conclusion
    createdAt
    updatedAt
    branch {
      name
    }
    creator {
      login
      __typename
      avatarUrl(size: 48)
    }
    app {
      slug
    }
    workflowRun {
      databaseId
      runNumber
      event
      url
      createdAt
      updatedAt
      workflow {
        name
      }
    }
    checkRuns(first: ${CHECK_RUNS_PER_SUITE}) {
      nodes {
        name
        status
        conclusion
        startedAt
        completedAt
        detailsUrl
      }
    }
  }
}`;
}

const DEFAULT_BRANCH_FIELDS = `
defaultBranchRef {
  name
  target {
    ... on Commit {
      oid
      messageHeadline
${suiteFields("last")}
    }
  }
}`;

export const RUNS_PR_QUERY = `
query($q: String!) {
  viewer {
    login
  }
  search(type: ISSUE, first: ${INBOX_SEARCH_LIMIT}, query: $q) {
    nodes {
      ... on PullRequest {
        __typename
        number
        title
        repository {
          nameWithOwner
        }
        commits(last: 1) {
          nodes {
            commit {
              oid
${suiteFields("first")}
            }
          }
        }
      }
    }
  }
}
`;

export function runsSourcesQuery(repoCount: number, orgCount: number): string {
  const variables = [
    ...Array.from({ length: repoCount }, (_, index) => `$ro${index}: String!, $rn${index}: String!`),
    ...Array.from({ length: orgCount }, (_, index) => `$ol${index}: String!`)
  ].join(", ");
  const repositories = Array.from(
    { length: repoCount },
    (_, index) => `  r${index}: repository(owner: $ro${index}, name: $rn${index}) {\n    nameWithOwner${DEFAULT_BRANCH_FIELDS}\n  }`
  );
  const organizations = Array.from(
    { length: orgCount },
    (_, index) =>
      `  o${index}: organization(login: $ol${index}) {\n    repositories(first: ${MAX_RUN_REPOS}, orderBy: {field: PUSHED_AT, direction: DESC}) {\n      nodes {\n        nameWithOwner${DEFAULT_BRANCH_FIELDS}\n      }\n    }\n  }`
  );
  return `query(${variables}) {\n  viewer {\n    login\n  }\n${[...repositories, ...organizations].join("\n")}\n}`;
}
