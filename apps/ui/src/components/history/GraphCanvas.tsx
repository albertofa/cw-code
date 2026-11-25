import { useEffect, useRef, useState } from "react";
import type { GraphRow } from "../../history/graphLayout.js";
import { colorOfEmail, getAvatarImage, subscribeAvatarImages, type NodeAvatar } from "./historyAvatars.js";
import type { GraphTheme } from "./graphTheme.js";

export type NodeKind = "commit" | "merge" | "stash" | "wip";

export const ROW_HEIGHT = 30;
export const LANE_WIDTH = 22;
export const MAX_LANES = 10;
export const REF_COLUMN_WIDTH = 150;
export const GRAPH_GAP = 6;
const LANE_PADDING = 8;
const NODE_RADIUS = 5;
const MERGE_RADIUS = 4;
const PLAIN_RADIUS = 6;
const PHOTO_RADIUS = 10;
const RING_WIDTH = 2;
const HEAD_RING_GAP = 2;
const INITIALS_FONT = "600 9px system-ui, sans-serif";

export function graphColumnWidth(laneCount: number): number {
  return Math.min(Math.max(laneCount, 1), MAX_LANES) * LANE_WIDTH + LANE_PADDING;
}

function laneX(lane: number): number {
  return GRAPH_GAP + LANE_PADDING / 2 + lane * LANE_WIDTH + LANE_WIDTH / 2;
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
  kinds,
  avatars,
  labeled,
  headIndex,
  start,
  end,
  laneCount,
  theme
}: {
  rows: GraphRow[];
  kinds: NodeKind[];
  avatars: (NodeAvatar | null)[] | null;
  labeled: boolean[];
  headIndex: number;
  start: number;
  end: number;
  laneCount: number;
  theme: GraphTheme;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [imageVersion, setImageVersion] = useState(0);
  const width = GRAPH_GAP + graphColumnWidth(laneCount);
  const height = (end - start) * ROW_HEIGHT;

  useEffect(() => subscribeAvatarImages(() => setImageVersion((version) => version + 1)), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const frame = requestAnimationFrame(() => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * ratio);
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

      for (let i = start; i < end; i++) {
        const row = rows[i];
        if (!row) continue;
        const top = (i - start) * ROW_HEIGHT;
        const mid = top + ROW_HEIGHT / 2;
        for (const segment of row.up) drawSegment(ctx, segment.from, segment.to, top, mid, colorOf(segment.color));
        for (const segment of row.down) drawSegment(ctx, segment.from, segment.to, mid, top + ROW_HEIGHT, colorOf(segment.color));
        if (labeled[i] && row.lane < MAX_LANES) {
          const hasAvatar = (avatars?.[i] ?? null) !== null;
          const edge = laneX(row.lane) - nodeEdgeRadius(kinds[i] ?? "commit", hasAvatar, i === headIndex) + 1;
          ctx.strokeStyle = colorOf(row.color);
          ctx.lineCap = "butt";
          ctx.beginPath();
          ctx.moveTo(0, mid);
          ctx.lineTo(edge, mid);
          ctx.stroke();
          ctx.lineCap = "round";
        }
      }

      for (let i = start; i < end; i++) {
        const row = rows[i];
        if (!row || row.lane >= MAX_LANES) continue;
        const x = laneX(row.lane);
        const y = (i - start) * ROW_HEIGHT + ROW_HEIGHT / 2;
        const kind = kinds[i] ?? "commit";
        const avatar = avatars?.[i] ?? null;
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
      ctx.restore();
    });
    return () => cancelAnimationFrame(frame);
  }, [rows, kinds, avatars, labeled, headIndex, start, end, width, height, theme, imageVersion]);

  return (
    <canvas
      ref={canvasRef}
      className="history-canvas"
      style={{ top: start * ROW_HEIGHT, left: REF_COLUMN_WIDTH, width, height }}
      aria-hidden="true"
    />
  );
}
