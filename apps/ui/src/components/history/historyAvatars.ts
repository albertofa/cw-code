import { useEffect, useRef, useState } from "react";
import type { HistoryAvatarAuthor, HistoryCommit, HistoryScope } from "@cw-code/contracts";

export interface NodeAvatar {
  email: string;
  initials: string;
  url: string | null;
}

const SHAS_PER_AUTHOR = 3;
const BATCH_SIZE = 25;
const STORAGE_KEY = "cw-code:history-avatars";
const LETTER_OR_DIGIT = /[\p{L}\p{N}]+/gu;

function firstLetter(word: string | undefined): string {
  return Array.from(word ?? "")[0] ?? "";
}

export function initialsOf(name: string, email: string): string {
  const fromName = name.match(LETTER_OR_DIGIT) ?? [];
  const words = fromName.length > 0 ? fromName : ((email.split("@")[0] ?? "").match(LETTER_OR_DIGIT) ?? []);
  if (words.length === 0) return "?";
  const letters = words.length === 1 ? Array.from(words[0] ?? "").slice(0, 2) : [firstLetter(words[0]), firstLetter(words[words.length - 1])];
  return letters.join("").toUpperCase();
}

export function colorOfEmail(email: string): string {
  let hash = 0;
  for (const char of email.toLowerCase()) hash = (Math.imul(hash, 31) + (char.codePointAt(0) ?? 0)) | 0;
  return `hsl(${Math.abs(hash) % 360} 50% 42%)`;
}

export function latestAuthorShas(commits: HistoryCommit[], skip: (commit: HistoryCommit) => boolean): Map<string, string[]> {
  const byAuthor = new Map<string, HistoryCommit[]>();
  for (const commit of commits) {
    if (commit.authorEmail === "" || commit.isStash || skip(commit)) continue;
    const email = commit.authorEmail.toLowerCase();
    const list = byAuthor.get(email);
    if (list) list.push(commit);
    else byAuthor.set(email, [commit]);
  }
  const latest = new Map<string, string[]>();
  for (const [email, list] of byAuthor) {
    const newest = [...list].sort((a, b) => b.authorDate - a.authorDate).slice(0, SHAS_PER_AUTHOR);
    latest.set(email, newest.map((commit) => commit.sha));
  }
  return latest;
}

const images = new Map<string, HTMLImageElement>();
const failed = new Set<string>();
const imageListeners = new Set<() => void>();

function notifyImages(): void {
  for (const listener of imageListeners) listener();
}

export function subscribeAvatarImages(listener: () => void): () => void {
  imageListeners.add(listener);
  return () => {
    imageListeners.delete(listener);
  };
}

export function getAvatarImage(url: string): HTMLImageElement | null {
  if (failed.has(url)) return null;
  const existing = images.get(url);
  if (existing) return existing.complete && existing.naturalWidth > 0 ? existing : null;
  const image = new Image();
  image.referrerPolicy = "no-referrer";
  image.onload = notifyImages;
  image.onerror = () => {
    failed.add(url);
    images.delete(url);
    notifyImages();
  };
  images.set(url, image);
  image.src = url;
  return null;
}

export function loadShowAvatars(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function saveShowAvatars(value: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
  } catch {
    return;
  }
}

export function useHistoryAvatars(
  scope: HistoryScope,
  commits: HistoryCommit[],
  skip: (commit: HistoryCommit) => boolean,
  enabled: boolean,
  avatarsRev: number
): Record<string, string | null> {
  const [avatars, setAvatars] = useState<Record<string, string | null>>({});
  const state = useRef({ done: new Set<string>(), inflight: new Set<string>(), pending: new Set<string>(), rev: avatarsRev });
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const tracked = state.current;
    if (tracked.rev !== avatarsRev) {
      tracked.rev = avatarsRev;
      tracked.pending.clear();
    }
    const wanted: HistoryAvatarAuthor[] = [];
    for (const [email, shas] of latestAuthorShas(commits, skip)) {
      if (!tracked.done.has(email) && !tracked.inflight.has(email) && !tracked.pending.has(email)) wanted.push({ email, shas });
    }
    for (let i = 0; i < wanted.length; i += BATCH_SIZE) {
      const batch = wanted.slice(i, i + BATCH_SIZE);
      for (const author of batch) tracked.inflight.add(author.email);
      window.cw.getHistoryAvatars(scope, batch).then(
        (result) => {
          for (const email of Object.keys(result.avatars)) {
            tracked.done.add(email);
            tracked.inflight.delete(email);
          }
          for (const email of result.pending) {
            tracked.inflight.delete(email);
            tracked.pending.add(email);
          }
          if (alive.current && Object.keys(result.avatars).length > 0) setAvatars((previous) => ({ ...previous, ...result.avatars }));
        },
        () => {
          for (const author of batch) tracked.inflight.delete(author.email);
        }
      );
    }
  }, [scope, commits, skip, enabled, avatarsRev]);

  return avatars;
}
