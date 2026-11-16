import { useEffect, useMemo, useState } from "react";
import { Hourglass } from "lucide-react";
import type { ModelOption } from "../cw.js";
import { ipcErrorMessage } from "./ipcError.js";
import { useThreadEntry } from "./useThread.js";

const MODEL_WINDOW_NAMES: Record<string, string> = {
  seven_day_overage_included: "Fable",
  seven_day_opus: "Opus",
  seven_day_sonnet: "Sonnet"
};

function resetPhrase(resetsAt: number, now: number): string {
  const date = new Date(resetsAt);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === new Date(now).toDateString()) return `at ${time}`;
  return `on ${date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} at ${time}`;
}

export function limitResumeSentence(resetsAt: number, now: number = Date.now()): string {
  if (resetsAt <= now) return "Usage limit reached. cw-code is about to continue this session.";
  return `Usage limit reached. cw-code continues this session when it resets, ${resetPhrase(resetsAt, now)}.`;
}

export function modelLimitSentence(name: string, resetsAt: number | undefined, now: number = Date.now()): string {
  const head = `${name} limit reached.`;
  if (resetsAt === undefined) return `${head} Continue on another model now, or send a message later.`;
  if (resetsAt <= now) return `${head} cw-code is about to continue this session.`;
  return `${head} Continue on another model now, or cw-code continues on this one when it resets, ${resetPhrase(resetsAt, now)}.`;
}

function labelOf(models: ModelOption[], id: string | undefined): string | undefined {
  if (!id) return undefined;
  return models.find((model) => model.id === id)?.label ?? id;
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
  const fallbackModel = pending?.fallbackModel;

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

  const options = useMemo(() => models.filter((model) => model.id !== limitedModel), [models, limitedModel]);

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

  const name =
    (pending.window ? MODEL_WINDOW_NAMES[pending.window] : undefined) ?? labelOf(models, limitedModel) ?? "This model's";
  const sentence = modelScoped
    ? modelLimitSentence(name, pending.resetsAt)
    : limitResumeSentence(pending.resetsAt ?? Date.now());
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
