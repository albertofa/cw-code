import { useState } from "react";
import { Check, MessageCircleQuestion } from "lucide-react";
import type { QuestionInfo, QuestionOption, QuestionRequest } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";

interface AnswerState {
  chosen: Record<string, boolean>;
  custom: string;
  customOpen: boolean;
}

function answerFor(q: QuestionInfo, state: AnswerState | undefined): string {
  if (state?.custom.trim()) return state.custom.trim();
  return q.options.filter((o) => state?.chosen[o.label]).map((o) => o.label).join(", ");
}

function isAnswered(q: QuestionInfo, state: AnswerState | undefined): boolean {
  return answerFor(q, state).length > 0;
}

function baseState(prev?: AnswerState): AnswerState {
  return prev ?? { chosen: {}, custom: "", customOpen: false };
}

function QuestionPanel({
  request,
  sessionId,
  position,
  total
}: {
  request: QuestionRequest;
  sessionId: string;
  position: number;
  total: number;
}) {
  const respond = useAppStore((s) => s.respondQuestion);
  const [states, setStates] = useState<Record<string, AnswerState>>({});
  const [submitting, setSubmitting] = useState(false);

  const select = (q: QuestionInfo, option: QuestionOption, multiSelect: boolean) => {
    setStates((prev) => {
      const current = baseState(prev[q.question]);
      const chosen = multiSelect
        ? { ...current.chosen, [option.label]: !current.chosen[option.label] }
        : current.chosen[option.label]
          ? {}
          : { [option.label]: true };
      return { ...prev, [q.question]: { ...current, chosen, custom: "", customOpen: false } };
    });
  };

  const openCustom = (q: QuestionInfo) => {
    setStates((prev) => {
      const current = baseState(prev[q.question]);
      return { ...prev, [q.question]: { ...current, custom: " ", customOpen: true, chosen: q.multiSelect ? current.chosen : {} } };
    });
  };

  const setCustom = (q: QuestionInfo, value: string) => {
    setStates((prev) => ({ ...prev, [q.question]: { ...baseState(prev[q.question]), custom: value, customOpen: true } }));
  };

  const submit = () => {
    if (submitting) return;
    const answers: Record<string, string> = {};
    for (const q of request.questions) {
      const value = answerFor(q, states[q.question]).trim();
      if (value) answers[q.question] = value;
    }
    if (Object.keys(answers).length === 0) return;
    setSubmitting(true);
    void respond(sessionId, request.requestId, answers).catch(() => setSubmitting(false));
  };

  const complete = request.questions.every((q) => isAnswered(q, states[q.question]));
  const answeredCount = request.questions.filter((q) => isAnswered(q, states[q.question])).length;

  return (
    <section className="question-panel" aria-label="Your input is required">
      <header className="question-panel-head">
        <MessageCircleQuestion size={15} className="question-panel-icon" />
        <span className="question-panel-title">Your input is needed</span>
        {total > 1 && (
          <span className="question-panel-count queue chip">{`${position} of ${total}`}</span>
        )}
        <span className="question-panel-count chip">
          {request.questions.length > 1 ? `${answeredCount}/${request.questions.length} answered` : "1 question"}
        </span>
      </header>
      <div className="question-panel-body">
        {request.questions.map((q, idx) => {
          const state = states[q.question];
          return (
            <div key={q.question} className="question-item">
              <div className="question-item-head">
                {q.header ? <span className="question-header chip">{q.header}</span> : null}
                {request.questions.length > 1 && (
                  <span className="question-progress chip">{`Question ${idx + 1} of ${request.questions.length}`}</span>
                )}
              </div>
              <div className="question-text">{q.question}</div>
              <div className="question-list">
                {q.options.map((o, i) => {
                  const picked = state?.chosen[o.label] === true;
                  return (
                    <button
                      key={o.label}
                      className={`question-row${picked ? " picked" : ""}`}
                      onClick={() => select(q, o, q.multiSelect)}
                    >
                      <span className="question-cell">[ {picked ? <Check aria-hidden="true" size={13} /> : null} ]</span>
                      <span className="question-index">{i + 1}.</span>
                      <span className="question-row-body">
                        <span className="question-row-label">{o.label}</span>
                        {o.description && <span className="question-row-desc">{o.description}</span>}
                      </span>
                    </button>
                  );
                })}
                {q.allowCustom && (
                  state?.customOpen ? (
                    <div className={`question-row question-custom-row${state.custom.trim() ? " picked" : ""}`}>
                      <span className="question-cell">[ {state.custom.trim() ? <Check aria-hidden="true" size={13} /> : null} ]</span>
                      <span className="question-index">{q.options.length + 1}.</span>
                      <span className="question-row-body">
                        <input
                          className="question-custom-input"
                          placeholder="Type your answer..."
                          value={state.custom}
                          onChange={(e) => setCustom(q, e.target.value)}
                          autoFocus
                        />
                      </span>
                    </div>
                  ) : (
                    <button className="question-row" onClick={() => openCustom(q)} type="button">
                      <span className="question-cell">[ ]</span>
                      <span className="question-index">{q.options.length + 1}.</span>
                      <span className="question-row-body">
                        <span className="question-row-inner">Type your own answer</span>
                      </span>
                    </button>
                  )
                )}
              </div>
              <div className="question-hint">{q.multiSelect ? "Select all answers that apply" : "Select one answer"}</div>
              {idx < request.questions.length - 1 && <div className="question-sep" />}
            </div>
          );
        })}
      </div>
      <footer className="question-panel-foot">
        <span className={`question-status${complete ? " ready" : ""}`}>
          {submitting ? "Submitting…" : complete ? "Ready to submit" : "Answer every question to continue"}
        </span>
        <button className="btn question-submit" onClick={submit} disabled={!complete || submitting}>
          <Check size={14} />
          Submit
        </button>
      </footer>
    </section>
  );
}

const NO_REQUESTS: QuestionRequest[] = [];

export function QuestionDock({ sessionId }: { sessionId: string }) {
  const requests = useAppStore((s) => s.pendingQuestions[sessionId] ?? NO_REQUESTS);
  const current = requests[0];
  if (!current) return null;
  return (
    <div className="question-dock">
      <QuestionPanel
        key={current.requestId}
        request={current}
        sessionId={sessionId}
        position={1}
        total={requests.length}
      />
    </div>
  );
}
