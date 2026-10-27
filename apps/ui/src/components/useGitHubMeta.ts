import type { GitHubContext, GitHubMetaTopicData } from "@cw-code/contracts";
import { GITHUB_META_TOPIC } from "@cw-code/shared/topics";
import { useTopicEntry } from "../server/topics.js";

export function useGitHubMetaContext(): GitHubContext | undefined {
  return useTopicEntry<GitHubContext>(GITHUB_META_TOPIC, "context");
}

export function useGitHubViews(): GitHubMetaTopicData["views"] | undefined {
  return useTopicEntry<GitHubMetaTopicData["views"]>(GITHUB_META_TOPIC, "views");
}

export function useGitHubBadges(): GitHubMetaTopicData["badges"] | undefined {
  return useTopicEntry<GitHubMetaTopicData["badges"]>(GITHUB_META_TOPIC, "badges");
}
