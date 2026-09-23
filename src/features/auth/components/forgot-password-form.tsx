"use client";

import { useState } from "react";
import { authClient } from "../client";
import { describeAuthError } from "../errors";
import { validateEmail } from "../validation";
import { AuthAlert, AuthSubmit, Field } from "./form-parts";

export function ForgotPasswordForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get("email") ?? "");
    const problem = validateEmail(email);
    setEmailError(problem);
    setError(null);
    if (problem) return;

    setBusy(true);
    const { error: failure } = await authClient.requestPasswordReset({
      email: email.trim(),
      redirectTo: "/reset-password",
    });
    setBusy(false);

    if (failure) {
      setError(describeAuthError(failure));
      return;
    }
    // The server never reveals whether the address exists.
    setSubmitted(true);
  }

  if (submitted) {
    return (
      <AuthAlert tone="info">
        If that email address has an account, a reset link is on its way. Check your inbox and spam folder.
      </AuthAlert>
    );
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit} noValidate>
      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        required
        error={emailError}
        onChange={() => setEmailError(null)}
      />
      {error ? <AuthAlert>{error}</AuthAlert> : null}
      <AuthSubmit busy={busy}>Send reset link</AuthSubmit>
    </form>
  );
}
