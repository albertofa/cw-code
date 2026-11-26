import { useCallback, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { trapDialogTab, useModalFocus } from "../ConfirmDialog.js";

export interface InputDialogRequest {
  title: string;
  label: string;
  placeholder?: string;
  note?: ReactNode;
  required?: string;
  checkbox?: { label: string; initial: boolean };
  confirmLabel: string;
  busyLabel: string;
  submit: (value: string, checked: boolean) => Promise<string | null>;
}

export function GitGlassInputDialog({ request, onClose }: { request: InputDialogRequest; onClose: () => void }) {
  const cardRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [checked, setChecked] = useState(request.checkbox?.initial ?? false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const inputId = useId();
  const errorId = useId();
  const cancel = useCallback(() => {
    if (!submittingRef.current) onClose();
  }, [onClose]);
  useModalFocus(cardRef, inputRef, cancel);

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (submittingRef.current) return;
    const text = value.trim();
    if (request.required && text.length === 0) {
      setError(request.required);
      inputRef.current?.focus();
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setError("");
    void request.submit(text, checked).then((failure) => {
      submittingRef.current = false;
      setSubmitting(false);
      if (failure === null) {
        onClose();
        return;
      }
      setError(failure);
      requestAnimationFrame(() => inputRef.current?.focus());
    });
  };

  return (
    <div className="confirm-backdrop" onClick={cancel}>
      <form
        ref={cardRef}
        className="confirm-card gg-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={request.title}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => trapDialogTab(event, cardRef.current)}
        onSubmit={onSubmit}
        noValidate
      >
        <div className="confirm-title">{request.title}</div>
        {request.note !== undefined && <div className="confirm-message gg-dialog-note">{request.note}</div>}
        <label className="gg-dialog-label" htmlFor={inputId}>
          {request.label}
        </label>
        <input
          ref={inputRef}
          id={inputId}
          className="field gg-dialog-input"
          value={value}
          placeholder={request.placeholder}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          disabled={submitting}
          onChange={(event) => {
            setValue(event.target.value);
            if (error) setError("");
          }}
        />
        {request.checkbox && (
          <label className="gg-dialog-check">
            <input type="checkbox" checked={checked} disabled={submitting} onChange={(event) => setChecked(event.target.checked)} />
            {request.checkbox.label}
          </label>
        )}
        {error && (
          <div id={errorId} className="gg-dialog-error" role="alert">
            {error}
          </div>
        )}
        <div className="confirm-actions">
          <button type="button" className="btn" onClick={cancel} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? request.busyLabel : request.confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
