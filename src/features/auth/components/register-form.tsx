"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "../client";
import { describeAuthError } from "../errors";
import { validateEmail, validateName, validatePassword } from "../validation";
import { AuthAlert, AuthSubmit, Field } from "./form-parts";

export function RegisterForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | null>>({});

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "");
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");

    const nextErrors = {
      name: validateName(name),
      email: validateEmail(email),
      password: validatePassword(password),
    };
    setFieldErrors(nextErrors);
    setError(null);
    if (Object.values(nextErrors).some(Boolean)) return;

    setBusy(true);
    // A verification link is emailed when delivery is configured; the account
    // itself is real and managed by Better Auth either way.
    const { error: failure } = await authClient.signUp.email({
      name: name.trim(),
      email: email.trim(),
      password,
      callbackURL: "/verify-email?status=verified",
    });
    setBusy(false);

    if (failure) {
      setError(describeAuthError(failure));
      return;
    }
    router.push("/verify-email?status=sent");
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit} noValidate>
      <Field
        label="Name"
        name="name"
        type="text"
        autoComplete="name"
        required
        error={fieldErrors.name}
        onChange={() => setFieldErrors((current) => ({ ...current, name: null }))}
      />
      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        required
        error={fieldErrors.email}
        onChange={() => setFieldErrors((current) => ({ ...current, email: null }))}
      />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        minLength={8}
        hint="At least 8 characters."
        error={fieldErrors.password}
        onChange={() => setFieldErrors((current) => ({ ...current, password: null }))}
      />
      {error ? <AuthAlert>{error}</AuthAlert> : null}
      <AuthSubmit busy={busy}>Create account</AuthSubmit>
    </form>
  );
}
