import type { ShikiRequest, ShikiResponse } from "./shikiProtocol.js";

export interface ShikiTokens {
  spans: Int32Array;
  styles: string[];
}

const REQUEST_TIMEOUT_MS = 10_000;
const TIMEOUT_COOLDOWN_MS = 60_000;

interface Job {
  owner: string;
  lang: string;
  text: string;
  resolve: (tokens: ShikiTokens | null) => void;
}

let worker: Worker | null = null;
let nextId = 1;
let running: { id: number; job: Job; timer: ReturnType<typeof setTimeout> } | null = null;
const queue = new Map<string, Job>();
const failedLangs = new Map<string, number>();

function isFailing(lang: string): boolean {
  return (failedLangs.get(lang) ?? 0) > Date.now();
}

function spawn(): Worker {
  const created = new Worker(new URL("./shiki.worker.ts", import.meta.url), { type: "module", name: "shiki" });
  created.onmessage = (event: MessageEvent<ShikiResponse>) => finish(event.data);
  created.onerror = (event) => {
    console.warn(`[editor] syntax highlighter worker failed: ${event.message}`);
    restart(null);
  };
  return created;
}

function restart(timedOutLang: string | null): void {
  worker?.terminate();
  worker = null;
  if (timedOutLang) failedLangs.set(timedOutLang, Date.now() + TIMEOUT_COOLDOWN_MS);
  if (running) {
    clearTimeout(running.timer);
    running.job.resolve(null);
    running = null;
  }
  pump();
}

function finish(response: ShikiResponse): void {
  if (!running || running.id !== response.id) return;
  const { job, timer } = running;
  clearTimeout(timer);
  running = null;
  if (response.ok) {
    job.resolve({ spans: response.spans, styles: response.styles });
  } else {
    failedLangs.set(job.lang, Number.POSITIVE_INFINITY);
    console.warn(`[editor] syntax highlighting unavailable for ${job.lang}: ${response.error}`);
    job.resolve(null);
  }
  pump();
}

function pump(): void {
  if (running) return;
  const next = queue.entries().next();
  if (next.done) return;
  const [owner, job] = next.value;
  queue.delete(owner);
  if (isFailing(job.lang)) {
    job.resolve(null);
    pump();
    return;
  }
  worker ??= spawn();
  const id = nextId++;
  const timer = setTimeout(() => {
    console.warn(`[editor] syntax highlighting for ${job.lang} timed out; restarting the highlighter`);
    restart(job.lang);
  }, REQUEST_TIMEOUT_MS);
  running = { id, job, timer };
  const request: ShikiRequest = { id, lang: job.lang, text: job.text };
  worker.postMessage(request);
}

export function highlightWithShiki(owner: string, lang: string, text: string): Promise<ShikiTokens | null> {
  return new Promise((resolve) => {
    queue.get(owner)?.resolve(null);
    queue.set(owner, { owner, lang, text, resolve });
    pump();
  });
}
