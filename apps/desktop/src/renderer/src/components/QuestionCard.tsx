import { useState } from "react";
import { Check } from "lucide-react";
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

export function QuestionCard({ request }: { request: QuestionRequest }) {
  const sessionId = useAppStore((s) => s.activeSessionId);
  const respond = useAppStore((s) => s.respondQuestion);
  const [states, setStates] = useState<Record<string, AnswerState>>({});

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
    const answers: Record<string, string> = {};
    for (const q of request.questions) {
      const value = answerFor(q, states[q.question]).trim();
      if (value) answers[q.question] = value;
    }
    if (Object.keys(answers).length === 0 || !sessionId) return;
    void respond(sessionId, request.requestId, answers).catch(() => {});
  };

  const complete = request.questions.every((q) => isAnswered(q, states[q.question]));

  return (
    <div className="question-card" role="group" aria-label="Your input is required">
      {request.questions.map((q, idx) => {
        const state = states[q.question];
        return (
          <div key={q.question} className="question-item">
            <div className="question-progress">
              {request.questions.length > 1 ? `Question ${idx + 1} of ${request.questions.length}` : "Question"}
            </div>
            {q.header && <div className="question-header">{q.header}</div>}
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
                    <span className="question-cell">[{picked ? "✓" : " "}]</span>
                    <span className="question-index">{i + 1}.</span>
                    <span className="question-row-body">
                      <span className="question-row-label">{o.label}</span>
                      {o.description && <span className="question-row-desc">{o.description}</span>}
                    </span>
                  </button>
                );
              })}
              {q.allowCustom && (
                <div className={`question-row question-custom-row${state?.custom.trim() ? " picked" : ""}`}>
                  <span className="question-cell">[{state?.custom.trim() ? "✓" : " "}]</span>
                  <span className="question-index">{q.options.length + 1}.</span>
                  <span className="question-row-body">
                    {state?.customOpen ? (
                      <input
                        className="question-custom-input"
                        placeholder="Type your answer..."
                        value={state.custom.trim()}
                        onChange={(e) => setCustom(q, e.target.value)}
                        autoFocus
                      />
                    ) : (
                      <button className="question-row-inner" onClick={() => openCustom(q)} type="button">
                        Type your own answer
                      </button>
                    )}
                  </span>
                </div>
              )}
            </div>
            <div className="question-hint">{q.multiSelect ? "Select all answers that apply" : "Select one answer"}</div>
          </div>
        );
      })}
      <div className="question-footer">
        <span className="question-progress">
          {complete
            ? "Ready to submit"
            : request.questions.length > 1
              ? `${request.questions.filter((q) => isAnswered(q, states[q.question])).length}/${request.questions.length} answered`
              : ""}
        </span>
        <button className="btn question-submit" onClick={submit} disabled={!complete}>
          <Check size={14} />
          Submit
        </button>
      </div>
    </div>
  );
}
