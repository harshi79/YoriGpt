import type { Metadata } from "next";
import Link from "next/link";
import { ForgotPasswordForm } from "@/features/auth/components/forgot-password-form";
import { requireAnonymous } from "@/server/auth/session";

export const metadata: Metadata = { title: "Reset password · YoriGPT" };

export default async function ForgotPasswordPage() {
  await requireAnonymous();

  return (
    <>
      <h1>Reset your password</h1>
      <p className="auth-lead">Enter your email address and we will send a reset link.</p>
      <ForgotPasswordForm />
      <div className="auth-links">
        <Link href="/login">Back to sign in</Link>
      </div>
    </>
  );
}
