import { useEffect, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, MessageCircleQuestion } from "lucide-react";
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

function tabLabel(q: QuestionInfo, idx: number): string {
  const header = q.header?.trim();
  if (header) return header.length > 18 ? `${header.slice(0, 17)}…` : header;
  const text = q.question.trim().replace(/\s+/g, " ");
  if (text.length <= 18) return text || `Q${idx + 1}`;
  return `${text.slice(0, 17)}…`;
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
  const panelRef = useRef<HTMLElement>(null);
  const [states, setStates] = useState<Record<string, AnswerState>>({});
  const [submitting, setSubmitting] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const totalQuestions = request.questions.length;
  const safeIndex = totalQuestions === 0 ? 0 : Math.min(activeIndex, totalQuestions - 1);
  const active = request.questions[safeIndex];

  useEffect(() => {
    const section = panelRef.current;
    const raf = requestAnimationFrame(() => {
      section?.querySelector<HTMLButtonElement>(".question-list .question-row")?.focus();
    });
    return () => {
      cancelAnimationFrame(raf);
      if (section?.contains(document.activeElement)) {
        (document.activeElement as HTMLElement).blur();
        document.querySelector<HTMLTextAreaElement>(".composer-input")?.focus();
      }
    };
  }, []);

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
  const go = (idx: number) => {
    if (totalQuestions === 0) return;
    setActiveIndex(Math.max(0, Math.min(idx, totalQuestions - 1)));
  };

  const focusFirstOption = () => {
    requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLButtonElement>(".question-list .question-row")?.focus();
    });
  };

  const advanceOrSubmit = () => {
    if (submitting || !active || !isAnswered(active, states[active.question])) return;
    if (complete) {
      submit();
      return;
    }
    if (safeIndex < totalQuestions - 1) {
      go(safeIndex + 1);
    } else {
      const firstOpen = request.questions.findIndex((q) => !isAnswered(q, states[q.question]));
      if (firstOpen !== -1) go(firstOpen);
    }
    focusFirstOption();
  };

  const moveOptionFocus = (delta: 1 | -1) => {
    const section = panelRef.current;
    if (!section) return false;
    const rows = [...section.querySelectorAll<HTMLButtonElement>(".question-list .question-row")];
    if (rows.length === 0) return false;
    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = current === -1 ? (delta === 1 ? 0 : rows.length - 1) : (current + delta + rows.length) % rows.length;
    rows[next].focus();
    return true;
  };

  const handleKey = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
    if (!active) return;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      if (target && target.closest(".question-tabs")) return;
      if (target && target.tagName === "BUTTON" && !target.classList.contains("question-row")) return;
      e.preventDefault();
      moveOptionFocus(e.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      go(safeIndex - 1);
      focusFirstOption();
      return;
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      go(safeIndex + 1);
      focusFirstOption();
      return;
    }
    if (e.key === "Enter") {
      const onOption = target && target.tagName === "BUTTON" && target.classList.contains("question-row");
      if (onOption) {
        if (isAnswered(active, states[active.question])) {
          e.preventDefault();
          advanceOrSubmit();
        }
        return;
      }
      if (target && target.tagName === "BUTTON") return;
      if (isAnswered(active, states[active.question])) {
        e.preventDefault();
        advanceOrSubmit();
      } else {
        e.preventDefault();
        focusFirstOption();
      }
    }
  };

  const renderOptions = (q: QuestionInfo) => {
    const state = states[q.question];
    return (
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
        {q.allowCustom &&
          (state?.customOpen ? (
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
          ))}
      </div>
    );
  };

  if (!active) return null;

  return (
    <section ref={panelRef} className="question-panel" aria-label="Your input is required" onKeyDown={handleKey}>
      <header className="question-panel-head">
        <MessageCircleQuestion size={15} className="question-panel-icon" />
        <span className="question-panel-title">Your input is needed</span>
        {total > 1 && (
          <span className="question-panel-count queue chip">{`${position} of ${total}`}</span>
        )}
        <span className="question-panel-count chip">
          {totalQuestions > 1 ? `${answeredCount}/${totalQuestions} answered` : "1 question"}
        </span>
      </header>
      {totalQuestions > 1 && (
        <nav className="question-tabs" aria-label="Questions">
          <button
            type="button"
            className="question-tab-arrow"
            onClick={() => go(safeIndex - 1)}
            disabled={safeIndex === 0}
            aria-label="Previous question"
          >
            <ChevronLeft size={14} />
          </button>
          <div className="question-tabs-list" role="tablist">
            {request.questions.map((q, idx) => {
              const answered = isAnswered(q, states[q.question]);
              const selected = idx === safeIndex;
              return (
                <button
                  key={`${idx}-${q.header ?? ""}`}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  className={`question-tab${selected ? " active" : ""}${answered ? " answered" : ""}`}
                  onClick={() => go(idx)}
                  title={q.header?.trim() || q.question}
                >
                  <span className="question-tab-box">{answered ? "✓" : "○"}</span>
                  <span className="question-tab-label">{tabLabel(q, idx)}</span>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className="question-tab-arrow"
            onClick={() => go(safeIndex + 1)}
            disabled={safeIndex === totalQuestions - 1}
            aria-label="Next question"
          >
            <ChevronRight size={14} />
          </button>
        </nav>
      )}
      <div className="question-panel-body">
        <div className="question-item">
          <div className="question-item-head">
            {active.header ? <span className="question-header chip">{active.header}</span> : null}
            {totalQuestions > 1 && (
              <span className="question-progress chip">{`Question ${safeIndex + 1} of ${totalQuestions}`}</span>
            )}
          </div>
          <div className="question-text">{active.question}</div>
          {renderOptions(active)}
          <div className="question-hint">
            {active.multiSelect ? "Select all answers that apply" : "Select one answer"}
            {totalQuestions > 1 ? " · ↑/↓ move, Space selects, Enter next, ←/→ switch question" : " · ↑/↓ move, Space selects, Enter submits when done"}
          </div>
        </div>
      </div>
      <footer className="question-panel-foot">
        <span className={`question-status${complete ? " ready" : ""}`}>
          {submitting ? "Submitting…" : complete ? "Ready to submit" : "Answer every question to continue"}
        </span>
        <span className="question-foot-actions">
          {totalQuestions > 1 && (
            <>
              <button
                type="button"
                className="btn question-nav"
                onClick={() => go(safeIndex - 1)}
                disabled={safeIndex === 0 || submitting}
              >
                ← Back
              </button>
              <button
                type="button"
                className="btn question-nav"
                onClick={() => go(safeIndex + 1)}
                disabled={safeIndex === totalQuestions - 1 || submitting}
              >
                Next →
              </button>
            </>
          )}
          <button className="btn question-submit" onClick={submit} disabled={!complete || submitting}>
            <Check size={14} />
            Submit
          </button>
        </span>
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
