"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "../client";
import { describeAuthError } from "../errors";
import { validatePassword, validatePasswordConfirmation, validateResetToken } from "../validation";
import { AuthAlert, AuthSubmit, Field } from "./form-parts";

export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | null>>({});
  const tokenProblem = validateResetToken(token);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    const confirmation = String(form.get("confirmation") ?? "");

    const nextErrors = {
      password: validatePassword(password),
      confirmation: validatePasswordConfirmation(password, confirmation),
    };
    setFieldErrors(nextErrors);
    setError(null);
    if (tokenProblem || Object.values(nextErrors).some(Boolean)) return;

    setBusy(true);
    const { error: failure } = await authClient.resetPassword({ newPassword: password, token });
    setBusy(false);

    if (failure) {
      setError(describeAuthError(failure));
      return;
    }
    // Reset tokens are single use; the user signs in again with the new password.
    setDone(true);
    router.refresh();
  }

  if (tokenProblem) {
    return (
      <AuthAlert>
        This reset link is invalid or has expired. Request a new one from the forgot password page.
      </AuthAlert>
    );
  }

  if (done) {
    return (
      <AuthAlert tone="success">
        Your password has been updated. You can now sign in with your new password.
      </AuthAlert>
    );
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit} noValidate>
      <Field
        label="New password"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        minLength={8}
        hint="At least 8 characters."
        error={fieldErrors.password}
        onChange={() => setFieldErrors((current) => ({ ...current, password: null }))}
      />
      <Field
        label="Confirm new password"
        name="confirmation"
        type="password"
        autoComplete="new-password"
        required
        error={fieldErrors.confirmation}
        onChange={() => setFieldErrors((current) => ({ ...current, confirmation: null }))}
      />
      {error ? <AuthAlert>{error}</AuthAlert> : null}
      <AuthSubmit busy={busy}>Update password</AuthSubmit>
    </form>
  );
}
