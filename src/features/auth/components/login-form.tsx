"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "../client";
import { describeAuthError } from "../errors";
import { validateEmail } from "../validation";
import { AuthAlert, AuthSubmit, Field } from "./form-parts";

export function LoginForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");

    const emailProblem = validateEmail(email);
    setEmailError(emailProblem);
    setError(null);
    if (emailProblem || !password) return;

    setBusy(true);
    const { error: failure } = await authClient.signIn.email({ email: email.trim(), password });
    setBusy(false);

    if (failure) {
      setError(describeAuthError(failure));
      return;
    }
    // Refresh so server components re-read the new session cookie.
    router.push("/");
    router.refresh();
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
      <Field label="Password" name="password" type="password" autoComplete="current-password" required />
      {error ? <AuthAlert>{error}</AuthAlert> : null}
      <AuthSubmit busy={busy}>Sign in</AuthSubmit>
    </form>
  );
}
