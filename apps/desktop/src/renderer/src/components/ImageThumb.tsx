import { useEffect, useState } from "react";
import { Image } from "lucide-react";
import { imageDataUrl, type ImageTarget } from "./imagePreview.js";

export function ImageThumb({
  target,
  path,
  className
}: {
  target: ImageTarget;
  path: string;
  className: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    imageDataUrl(target, path)
      .then((url) => {
        if (alive) setSrc(url);
      })
      .catch(() => {
        if (alive) setSrc(null);
      });
    return () => {
      alive = false;
    };
  }, [target.sessionId, target.projectId, path]);
  if (!src) {
    return (
      <span className={className} aria-hidden>
        <Image aria-hidden="true" size={14} />
      </span>
    );
  }
  return <img className={className} src={src} alt={path} title={path} draggable={false} />;
}
