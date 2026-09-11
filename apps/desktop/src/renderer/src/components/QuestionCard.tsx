import { useState } from "react";
import { CheckCircle2, MessageCircleQuestion } from "lucide-react";
import type { QuestionRequest } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";

export function QuestionCard({ request }: { request: QuestionRequest }) {
  const sessionId = useAppStore((s) => s.activeSessionId);
  const respond = useAppStore((s) => s.respondQuestion);
  const [answers, setAnswers] = useState<Record<string, Record<string, boolean>>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});

  const toggle = (question: string, label: string, multiSelect: boolean) => {
    setAnswers((prev) => {
      const forQuestion = prev[question] ?? {};
      const next = multiSelect
        ? { ...forQuestion, [label]: !forQuestion[label] }
        : { [label]: true };
      return { ...prev, [question]: next };
    });
  };

  const submit = () => {
    const out: Record<string, string> = {};
    for (const q of request.questions) {
      const chosen = Object.entries(answers[q.question] ?? {})
        .filter(([, on]) => on)
        .map(([label]) => label);
      const customText = custom[q.question]?.trim();
      if (customText) out[q.question] = customText;
      else if (chosen.length > 0) out[q.question] = chosen.join(", ");
    }
    if (Object.keys(out).length === 0) return;
    if (!sessionId) return;
    void respond(sessionId, request.requestId, out).catch(() => {});
  };

  const hasSelection = request.questions.some((q) => {
    const chosen = answers[q.question];
    return Object.values(chosen ?? {}).some((on) => on) || (custom[q.question]?.trim().length ?? 0) > 0;
  });

  return (
    <div className="approval-card question-card" role="alert" aria-label="Question requested">
      <div className="approval-head">
        <MessageCircleQuestion size={15} className="approval-icon" />
        <span className="approval-title">Claude needs your input</span>
      </div>
      {request.questions.map((q) => (
        <div key={q.question} className="question-item">
          {q.header && <div className="question-header">{q.header}</div>}
          <div className="question-text">{q.question}</div>
          <div className="question-options">
            {q.options.map((o) => {
              const active = answers[q.question]?.[o.label] === true;
              return (
                <button
                  key={o.label}
                  className={`btn question-option${active ? " active" : ""}`}
                  onClick={() => toggle(q.question, o.label, q.multiSelect)}
                >
                  <span className="question-option-text">{o.label}</span>
                  {o.description && <span className="question-option-desc">{o.description}</span>}
                </button>
              );
            })}
          </div>
          {q.allowCustom && (
            <input
              className="question-custom"
              placeholder="Other…"
              value={custom[q.question] ?? ""}
              onChange={(e) => setCustom((prev) => ({ ...prev, [q.question]: e.target.value }))}
            />
          )}
        </div>
      ))}
      <div className="approval-actions">
        <button className="btn approval-accept" onClick={submit} disabled={!hasSelection}>
          <CheckCircle2 size={14} />
          Submit answer
        </button>
      </div>
    </div>
  );
}
