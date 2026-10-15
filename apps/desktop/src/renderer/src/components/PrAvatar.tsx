import { useState, type CSSProperties } from "react";
import { projectAvatarStyle, projectInitials } from "./avatar.js";
import "./prInbox.css";

interface PrAvatarProps {
  login: string;
  name?: string;
  avatarUrl?: string;
  size?: number;
}

const BOT_SUFFIX = /\[bot\]$/;

export function PrAvatar({ login, name, avatarUrl, size = 24 }: PrAvatarProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = avatarUrl !== undefined && avatarUrl !== failedUrl;
  const style: CSSProperties = { ...projectAvatarStyle(login), width: size, height: size };
  return (
    <span className="pr-avatar" style={style} aria-hidden="true">
      {showImage ? (
        <img src={avatarUrl} alt="" referrerPolicy="no-referrer" loading="lazy" onError={() => setFailedUrl(avatarUrl)} />
      ) : (
        projectInitials((name || login).replace(BOT_SUFFIX, ""))
      )}
    </span>
  );
}
