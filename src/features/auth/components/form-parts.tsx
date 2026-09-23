"use client";

import { useId, type InputHTMLAttributes, type ReactNode } from "react";

type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  error?: string | null;
};

export function Field({ label, hint, error, className = "", ...props }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ");

  return (
    <div className="auth-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className={`auth-input ${className}`.trim()}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        {...props}
      />
      {hint ? (
        <p className="auth-hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="auth-field-error" id={errorId}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function AuthAlert({
  tone = "error",
  children,
}: {
  tone?: "error" | "success" | "info";
  children: ReactNode;
}) {
  return (
    <p className={`auth-alert auth-alert-${tone}`} role={tone === "error" ? "alert" : "status"}>
      {children}
    </p>
  );
}

export function AuthSubmit({ children, busy }: { children: ReactNode; busy?: boolean }) {
  return (
    <button className="auth-submit" type="submit" disabled={busy} aria-busy={busy || undefined}>
      {busy ? "Working…" : children}
    </button>
  );
}
