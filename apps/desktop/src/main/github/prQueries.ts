const PR_SUMMARY_FIELDS = `
  number
  url
  title
  state
  isDraft
  viewerDidAuthor
  author {
    login
    __typename
  }
  headRefName
  headRefOid
  baseRefName
  additions
  deletions
  changedFiles
  comments {
    totalCount
  }
  reviewDecision
  mergeable
  labels(first: 20) {
    nodes {
      name
    }
  }
  updatedAt
  reviewRequests(first: 20) {
    nodes {
      requestedReviewer {
        ... on User {
          login
        }
      }
    }
  }
  ciCommits: commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup {
          contexts(first: 100) {
            nodes {
              __typename
              ... on CheckRun {
                conclusion
                status
              }
              ... on StatusContext {
                state
              }
            }
          }
        }
      }
    }
  }
`;

export const INBOX_QUERY = `
query($q: String!) {
  viewer {
    login
  }
  search(type: ISSUE, first: 50, query: $q) {
    nodes {
      ... on PullRequest {
        __typename
${PR_SUMMARY_FIELDS}
        reviewThreads(first: 100) {
          nodes {
            isResolved
          }
        }
      }
    }
  }
}
`;

export const DETAIL_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  viewer {
    login
  }
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
${PR_SUMMARY_FIELDS}
      body
      createdAt
      timelineItems(
        first: 100
        itemTypes: [
          PULL_REQUEST_COMMIT
          PULL_REQUEST_REVIEW
          ISSUE_COMMENT
          REVIEW_REQUESTED_EVENT
          MERGED_EVENT
          CLOSED_EVENT
          REOPENED_EVENT
          READY_FOR_REVIEW_EVENT
        ]
      ) {
        nodes {
          __typename
          ... on PullRequestCommit {
            commit {
              oid
              messageHeadline
              committedDate
              author {
                name
                user {
                  login
                }
              }
              statusCheckRollup {
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun {
                      conclusion
                      status
                    }
                    ... on StatusContext {
                      state
                    }
                  }
                }
              }
            }
          }
          ... on PullRequestReview {
            id
            state
            body
            createdAt
            author {
              login
            }
          }
          ... on IssueComment {
            body
            createdAt
            author {
              login
            }
          }
          ... on ReviewRequestedEvent {
            createdAt
            actor {
              login
            }
            requestedReviewer {
              ... on User {
                login
              }
            }
          }
          ... on MergedEvent {
            createdAt
            actor {
              login
            }
          }
          ... on ClosedEvent {
            createdAt
            actor {
              login
            }
          }
          ... on ReopenedEvent {
            createdAt
            actor {
              login
            }
          }
          ... on ReadyForReviewEvent {
            createdAt
            actor {
              login
            }
          }
        }
      }
      threads: reviewThreads(first: 100) {
        nodes {
          id
          path
          line
          isResolved
          comments(first: 50) {
            nodes {
              author {
                login
              }
              body
              createdAt
              diffHunk
              pullRequestReview {
                id
              }
            }
          }
        }
      }
      latestReviews(first: 20) {
        nodes {
          author {
            login
          }
          state
        }
      }
      commits(last: 100) {
        nodes {
          commit {
            oid
            messageHeadline
            committedDate
            author {
              name
              user {
                login
              }
            }
            statusCheckRollup {
              contexts(first: 100) {
                nodes {
                  __typename
                  ... on CheckRun {
                    conclusion
                    status
                  }
                  ... on StatusContext {
                    state
                  }
                }
              }
            }
          }
        }
      }
      checkRunCommits: commits(last: 1) {
        nodes {
          commit {
            checkSuites(first: 20) {
              nodes {
                workflowRun {
                  databaseId
                  workflow {
                    name
                  }
                }
                checkRuns(first: 50) {
                  nodes {
                    name
                    conclusion
                    status
                    detailsUrl
                    completedAt
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
`;

export function inboxSearchQueries(now: number): string[] {
  const since = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return ["is:pr is:open involves:@me archived:false", `is:pr is:merged author:@me merged:>=${since}`];
}
