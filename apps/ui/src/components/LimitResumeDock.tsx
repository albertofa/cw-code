import { useEffect, useMemo, useState } from "react";
import { Hourglass } from "lucide-react";
import type { ModelOption } from "../cw.js";
import { isLimitedModel, limitWindowFamily } from "@cw-code/shared/usageLimits";
import { ipcErrorMessage } from "./ipcError.js";
import { useThreadEntry } from "./useThread.js";

function whenPhrase(at: number, now: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === new Date(now).toDateString()) return `at ${time}`;
  return `on ${date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} at ${time}`;
}

/** `resumesAt` is when cw-code starts the continuation, shortly after the limit resets. */
export function limitResumeSentence(resumesAt: number, now: number = Date.now()): string {
  if (resumesAt <= now) return "Usage limit reached. cw-code is about to continue this session.";
  return `Usage limit reached. cw-code continues this session ${whenPhrase(resumesAt, now)}, once it resets.`;
}

export function modelLimitSentence(name: string, resumesAt: number | undefined, now: number = Date.now()): string {
  const head = `${name} limit reached.`;
  if (resumesAt === undefined) return `${head} Continue on another model now, or send a message later.`;
  if (resumesAt <= now) return `${head} cw-code is about to continue this session.`;
  return `${head} Continue on another model now, or cw-code continues on this one ${whenPhrase(resumesAt, now)}, once it resets.`;
}

function labelOf(models: ModelOption[], id: string | undefined): string | undefined {
  if (!id) return undefined;
  return models.find((model) => model.id === id)?.label ?? id;
}

/** Re-renders once `at` passes, so the dock switches to "about to continue" without waiting for another update. */
function useNowAfter(at: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at === undefined) return;
    const wait = at - Date.now();
    if (wait <= 0) {
      setNow(Date.now());
      return;
    }
    const timer = setTimeout(() => setNow(Date.now()), Math.min(wait, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [at]);
  return now;
}

export function LimitResumeDock({ sessionId }: { sessionId: string }) {
  const pending = useThreadEntry(sessionId, "limitResume");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [choice, setChoice] = useState<string>("");
  const waiting = pending != null;
  const modelScoped = pending?.scope === "model";
  const limitedModel = pending?.model;
  const limitedWindow = pending?.window;
  const fallbackModel = pending?.fallbackModel;
  const now = useNowAfter(pending?.resumesAt);

  useEffect(() => {
    if (!waiting) setError(null);
  }, [waiting]);

  useEffect(() => {
    if (!modelScoped) return;
    let live = true;
    window.cw
      .listModels(sessionId)
      .then((list) => {
        if (live) setModels(list);
      })
      .catch((err) => {
        if (live) setError(`Could not load models: ${ipcErrorMessage(err)}`);
      });
    return () => {
      live = false;
    };
  }, [sessionId, modelScoped]);

  const options = useMemo(
    () => models.filter((model) => !isLimitedModel(model.id, { model: limitedModel, window: limitedWindow })),
    [models, limitedModel, limitedWindow]
  );

  useEffect(() => {
    if (options.some((model) => model.id === choice)) return;
    const preferred = options.find((model) => model.id === fallbackModel) ?? options[0];
    setChoice(preferred?.id ?? "");
  }, [options, fallbackModel, choice]);

  if (!pending) return null;

  const run = async (action: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(`${failure}: ${ipcErrorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => run(() => window.cw.cancelLimitResume(sessionId), "Could not cancel");
  const continueOn = () => run(() => window.cw.continueWithModel(sessionId, choice), "Could not continue");

  const name = limitWindowFamily(pending.window)?.label ?? labelOf(models, limitedModel) ?? "This model's";
  const sentence = modelScoped
    ? modelLimitSentence(name, pending.resumesAt, now)
    : limitResumeSentence(pending.resumesAt ?? now, now);
  const choiceLabel = labelOf(models, choice);

  return (
    <section className="pr-dock branch-dock" aria-label="Usage limit">
      <div className="pr-dock-head">
        <Hourglass size={14} className="pr-dock-head-icon warn" aria-hidden="true" />
        <span className="pr-dock-title branch-dock-title" title={sentence}>
          {sentence}
        </span>
        <span className="pr-dock-spacer" />
        {modelScoped && options.length > 0 && (
          <>
            <select
              className="field sp-select"
              aria-label="Model to continue with"
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              disabled={busy}
            >
              {options.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
            <button className="pr-detail-btn primary sm" onClick={() => void continueOn()} disabled={busy || !choice}>
              Continue with {choiceLabel ?? "this model"}
            </button>
          </>
        )}
        <button className="pr-detail-btn ghost sm" onClick={() => void cancel()} disabled={busy}>
          {pending.resetsAt === undefined ? "Dismiss" : "Don't continue"}
        </button>
      </div>
      {error && (
        <div className="pr-dock-error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
