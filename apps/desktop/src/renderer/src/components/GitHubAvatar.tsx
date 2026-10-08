import { Bot } from "lucide-react";
import { projectAvatarStyle, projectInitials } from "./avatar.js";
import { isBotLogin, type Tone } from "./githubRowModel.js";

export function GitHubAvatar({
  login,
  small = false,
  badge = null,
  assignee = false,
  viewer = false
}: {
  login: string;
  small?: boolean;
  badge?: Tone | null;
  assignee?: boolean;
  viewer?: boolean;
}) {
  const bot = isBotLogin(login);
  const className = ["hub-av", small ? "sm" : "", bot ? "bot" : "", viewer ? "you" : "", assignee ? "assignee-ring" : ""].filter(Boolean).join(" ");
  return (
    <span className={className} style={bot ? undefined : projectAvatarStyle(login)} title={login}>
      {bot ? <Bot size={12} aria-hidden="true" /> : projectInitials(login)}
      {badge && <i className={`hub-av-badge ${badge}`} aria-hidden="true" />}
    </span>
  );
}
