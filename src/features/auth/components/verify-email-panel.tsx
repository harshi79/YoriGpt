"use client";

import { useState } from "react";
import { authClient } from "../client";
import { describeAuthError } from "../errors";
import { validateEmail } from "../validation";
import { AuthAlert, AuthSubmit, Field } from "./form-parts";

type Props = {
  email?: string;
  verified: boolean;
  signedIn: boolean;
  status?: string;
};

export function VerifyEmailPanel({ email, verified, signedIn, status }: Props) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);

  async function resend(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = email ?? String(new FormData(event.currentTarget).get("email") ?? "");
    const problem = validateEmail(target);
    setEmailError(problem);
    setMessage(null);
    setError(null);
    if (problem) return;

    setBusy(true);
    const { error: failure } = await authClient.sendVerificationEmail({
      email: target.trim(),
      callbackURL: "/verify-email?status=verified",
    });
    setBusy(false);

    if (failure) {
      setError(describeAuthError(failure));
      return;
    }
    setMessage("If that address has an unverified account, a new verification link is on its way.");
  }

  return (
    <div className="auth-panel-body">
      {verified || status === "verified" ? (
        <AuthAlert tone="success">This email address is verified. You can continue to YoriGPT.</AuthAlert>
      ) : (
        <p className="auth-lead">
          {signedIn && email
            ? `We are waiting for ${email} to be verified. Open the link in the verification email to finish.`
            : "Enter the email address you registered with to request a new verification link."}
        </p>
      )}

      {!verified && status !== "verified" ? (
        <form className="auth-form" onSubmit={resend} noValidate>
          {email ? null : (
            <Field
              label="Email"
              name="email"
              type="email"
              autoComplete="email"
              required
              error={emailError}
              onChange={() => setEmailError(null)}
            />
          )}
          {message ? <AuthAlert tone="info">{message}</AuthAlert> : null}
          {error ? <AuthAlert>{error}</AuthAlert> : null}
          <AuthSubmit busy={busy}>Resend verification email</AuthSubmit>
        </form>
      ) : null}
    </div>
  );
}
