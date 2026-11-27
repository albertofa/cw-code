import { useEffect, useRef, useState } from "react";
import type { GraphRow } from "../../history/graphLayout.js";
import { colorOfEmail, getAvatarImage, subscribeAvatarImages, type NodeAvatar } from "./historyAvatars.js";
import type { GraphTheme } from "./graphTheme.js";
import type { Slot } from "./gitGlassLayout.js";

export type NodeKind = "commit" | "merge" | "stash" | "wip";

export const LANE_WIDTH = 22;
export const MAX_LANES = 10;
const LANE_PADDING = 8;
const NODE_RADIUS = 5;
const MERGE_RADIUS = 4;
const PLAIN_RADIUS = 6;
const PHOTO_RADIUS = 10;
const RING_WIDTH = 2;
const HEAD_RING_GAP = 2;
const DIMMED_ALPHA = 0.25;
const INITIALS_FONT = "600 9px system-ui, sans-serif";

export function graphColumnWidth(laneCount: number): number {
  return Math.min(Math.max(laneCount, 1), MAX_LANES) * LANE_WIDTH + LANE_PADDING;
}

function laneX(lane: number): number {
  return LANE_PADDING / 2 + lane * LANE_WIDTH + LANE_WIDTH / 2;
}

function nodeLane(lane: number): number {
  return Math.min(lane, MAX_LANES - 1);
}

function useDevicePixelRatio(): number {
  const [ratio, setRatio] = useState(() => window.devicePixelRatio || 1);
  useEffect(() => {
    const query = window.matchMedia(`(resolution: ${ratio}dppx)`);
    const update = (): void => setRatio(window.devicePixelRatio || 1);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [ratio]);
  return ratio;
}

function drawSegment(ctx: CanvasRenderingContext2D, fromLane: number, toLane: number, yFrom: number, yTo: number, color: string): void {
  const x1 = laneX(fromLane);
  const x2 = laneX(toLane);
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(x1, yFrom);
  if (x1 === x2) ctx.lineTo(x2, yTo);
  else {
    const yMid = (yFrom + yTo) / 2;
    ctx.bezierCurveTo(x1, yMid, x2, yMid, x2, yTo);
  }
  ctx.stroke();
}

function drawAvatar(ctx: CanvasRenderingContext2D, x: number, y: number, avatar: NodeAvatar, color: string): void {
  const image = avatar.url === null ? null : getAvatarImage(avatar.url);
  ctx.beginPath();
  ctx.arc(x, y, PHOTO_RADIUS, 0, Math.PI * 2);
  if (image) {
    ctx.save();
    ctx.clip();
    ctx.drawImage(image, x - PHOTO_RADIUS, y - PHOTO_RADIUS, PHOTO_RADIUS * 2, PHOTO_RADIUS * 2);
    ctx.restore();
  } else {
    ctx.fillStyle = colorOfEmail(avatar.email);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = INITIALS_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(avatar.initials, x, y + 0.5);
  }
  ctx.lineWidth = RING_WIDTH;
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, PHOTO_RADIUS + RING_WIDTH / 2, 0, Math.PI * 2);
  ctx.stroke();
}

function drawNode(ctx: CanvasRenderingContext2D, x: number, y: number, kind: NodeKind, color: string, theme: GraphTheme, avatar: NodeAvatar | null): void {
  ctx.lineWidth = 2;
  ctx.setLineDash([]);
  if (kind === "stash") {
    ctx.fillStyle = theme.background;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.rect(x - NODE_RADIUS, y - NODE_RADIUS, NODE_RADIUS * 2, NODE_RADIUS * 2);
    ctx.fill();
    ctx.stroke();
    return;
  }
  if (kind === "wip") {
    ctx.fillStyle = theme.background;
    ctx.strokeStyle = color;
    ctx.setLineDash([3, 2]);
    ctx.beginPath();
    ctx.arc(x, y, NODE_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }
  if (kind === "commit" && avatar) {
    drawAvatar(ctx, x, y, avatar, color);
    return;
  }
  ctx.fillStyle = color;
  ctx.strokeStyle = theme.background;
  ctx.beginPath();
  ctx.arc(x, y, kind === "merge" ? MERGE_RADIUS : PLAIN_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  if (kind === "commit") ctx.stroke();
}

function headRingRadius(kind: NodeKind, hasAvatar: boolean): number {
  if (kind === "commit" && hasAvatar) return PHOTO_RADIUS + RING_WIDTH + HEAD_RING_GAP;
  if (kind === "commit") return PLAIN_RADIUS + HEAD_RING_GAP + 1;
  if (kind === "merge") return MERGE_RADIUS + HEAD_RING_GAP + 2;
  return NODE_RADIUS + HEAD_RING_GAP + 2;
}

function nodeEdgeRadius(kind: NodeKind, hasAvatar: boolean, isHead: boolean): number {
  if (isHead) return headRingRadius(kind, hasAvatar) + 1;
  if (kind === "commit" && hasAvatar) return PHOTO_RADIUS + RING_WIDTH;
  if (kind === "commit") return PLAIN_RADIUS;
  if (kind === "merge") return MERGE_RADIUS;
  return NODE_RADIUS;
}

export function GraphCanvas({
  rows,
  slots,
  start,
  end,
  kinds,
  avatars,
  labeled,
  dimmed,
  headIndex,
  left,
  width,
  theme
}: {
  rows: GraphRow[];
  slots: Slot[];
  start: number;
  end: number;
  kinds: NodeKind[];
  avatars: (NodeAvatar | null)[] | null;
  labeled: boolean[];
  dimmed: boolean[] | null;
  headIndex: number;
  left: number;
  width: number;
  theme: GraphTheme;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [imageVersion, setImageVersion] = useState(0);
  const ratio = useDevicePixelRatio();
  const firstSlot = slots[start];
  const lastSlot = slots[end - 1];
  const origin = firstSlot?.top ?? 0;
  const height = lastSlot ? lastSlot.top + lastSlot.height - origin : 0;

  useEffect(() => subscribeAvatarImages(() => setImageVersion((version) => version + 1)), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const frame = requestAnimationFrame(() => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, width, height);
      ctx.clip();
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      const colorOf = (index: number): string => theme.colors[index] ?? theme.foreground;
      const alphaOf = (index: number): number => (dimmed?.[index] ? DIMMED_ALPHA : 1);

      for (let s = start; s < end; s++) {
        const slot = slots[s];
        if (!slot) continue;
        const top = slot.top - origin;
        if (slot.kind === "separator") {
          const below = rows[slot.before];
          if (!below) continue;
          ctx.globalAlpha = alphaOf(slot.before);
          for (const segment of below.up) drawSegment(ctx, segment.from, segment.from, top, top + slot.height, colorOf(segment.color));
          continue;
        }
        const i = slot.index;
        const row = rows[i];
        if (!row) continue;
        const mid = top + slot.height / 2;
        ctx.globalAlpha = alphaOf(i);
        for (const segment of row.up) drawSegment(ctx, segment.from, segment.to, top, mid, colorOf(segment.color));
        for (const segment of row.down) drawSegment(ctx, segment.from, segment.to, mid, top + slot.height, colorOf(segment.color));
        if (labeled[i]) {
          const hasAvatar = (avatars?.[i] ?? null) !== null;
          const edge = laneX(nodeLane(row.lane)) - nodeEdgeRadius(kinds[i] ?? "commit", hasAvatar, i === headIndex) + 1;
          ctx.strokeStyle = colorOf(row.color);
          ctx.lineCap = "butt";
          ctx.beginPath();
          ctx.moveTo(0, mid);
          ctx.lineTo(edge, mid);
          ctx.stroke();
          ctx.lineCap = "round";
        }
      }

      for (let s = start; s < end; s++) {
        const slot = slots[s];
        if (!slot || slot.kind !== "commit") continue;
        const i = slot.index;
        const row = rows[i];
        if (!row) continue;
        const x = laneX(nodeLane(row.lane));
        const y = slot.top - origin + slot.height / 2;
        const kind = kinds[i] ?? "commit";
        const avatar = avatars?.[i] ?? null;
        ctx.globalAlpha = alphaOf(i);
        if (i === headIndex) {
          ctx.strokeStyle = theme.foreground;
          ctx.lineWidth = 2;
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.arc(x, y, headRingRadius(kind, avatar !== null), 0, Math.PI * 2);
          ctx.stroke();
        }
        drawNode(ctx, x, y, kind, colorOf(row.color), theme, avatar);
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    });
    return () => cancelAnimationFrame(frame);
  }, [rows, slots, start, end, kinds, avatars, labeled, dimmed, headIndex, origin, width, height, theme, imageVersion, ratio]);

  return <canvas ref={canvasRef} className="history-canvas" style={{ top: origin, left, width, height }} aria-hidden="true" />;
}
