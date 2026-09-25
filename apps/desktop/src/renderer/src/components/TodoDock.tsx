import { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronRight, ListChecks, X } from "lucide-react";
import type { TodoItem } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";

const EMPTY_TODOS: TodoItem[] = [];

export function TodoDock({ sessionId }: { sessionId: string }) {
  const todos = useAppStore((s) => s.todosBySession[sessionId] ?? EMPTY_TODOS);
  const [override, setOverride] = useState<boolean | null>(null);

  useEffect(() => {
    setOverride(null);
  }, [sessionId]);

  if (todos.length === 0) return null;

  const total = todos.length;
  const done = todos.filter((t) => t.status === "completed").length;
  const active = todos.filter((t) => t.status === "pending" || t.status === "in_progress").length;
  const open = override ?? active > 0;

  return (
    <section className={`todo-dock${open ? "" : " collapsed"}`} aria-label="Todos">
      <button type="button" className="todo-head" onClick={() => setOverride(!open)} aria-expanded={open}>
        <ListChecks size={15} className="todo-head-icon" aria-hidden="true" />
        <span className="todo-title">Todos</span>
        {active > 0 && (
          <span className="todo-live">
            <span className="pulse" aria-hidden="true" />
            {active} active
          </span>
        )}
        <span className="todo-count">
          · {done}/{total} done
        </span>
        <span className="todo-chev" aria-hidden="true">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>
      <div className="todo-bar">
        <i style={{ width: `${(done / total) * 100}%` }} />
      </div>
      <div className="todo-list">
        {todos.map((t, i) => (
          <div key={`${i}-${t.content}`} className={`todo-item ${t.status}`}>
            <span className={`todo-state ${t.status}`}>
              {t.status === "completed" && <Check size={11} strokeWidth={3.5} aria-hidden="true" />}
              {t.status === "in_progress" && <span className="pulse" aria-hidden="true" />}
              {t.status === "cancelled" && <X size={11} strokeWidth={3} aria-hidden="true" />}
            </span>
            <span className="todo-label" title={t.content}>
              {t.content}
            </span>
            {t.status === "in_progress" && <span className="todo-now">NOW</span>}
          </div>
        ))}
      </div>
    </section>
  );
}
