import { useState } from "react";
import { Bot } from "lucide-react";
import { projectAvatarStyle, projectInitials } from "./avatar.js";
import { isBotLogin, type Tone } from "./githubRowModel.js";

export function GitHubAvatar({
  login,
  avatarUrl,
  small = false,
  badge = null,
  assignee = false,
  viewer = false
}: {
  login: string;
  avatarUrl?: string;
  small?: boolean;
  badge?: Tone | null;
  assignee?: boolean;
  viewer?: boolean;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const bot = isBotLogin(login);
  const showImage = avatarUrl !== undefined && avatarUrl !== failedUrl;
  const className = ["hub-av", small ? "sm" : "", bot && !showImage ? "bot" : "", viewer ? "you" : "", assignee ? "assignee-ring" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={className} style={bot ? undefined : projectAvatarStyle(login)} title={login}>
      {showImage ? (
        <img className="hub-av-img" src={avatarUrl} alt="" referrerPolicy="no-referrer" loading="lazy" onError={() => setFailedUrl(avatarUrl)} />
      ) : bot ? (
        <Bot size={12} aria-hidden="true" />
      ) : (
        projectInitials(login)
      )}
      {badge && <i className={`hub-av-badge ${badge}`} aria-hidden="true" />}
    </span>
  );
}
