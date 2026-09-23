import type { Metadata } from "next";
import Link from "next/link";
import { ResetPasswordForm } from "@/features/auth/components/reset-password-form";

export const metadata: Metadata = { title: "Choose a new password · YoriGPT" };

// Better Auth's reset link redirects here with `?token=`; an invalid or expired
// link arrives without a token (or with an `?error=` code) and the form reports
// that state instead of pretending the password was changed.
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token = "" } = await searchParams;

  return (
    <>
      <h1>Choose a new password</h1>
      <p className="auth-lead">Reset links expire after one hour and can only be used once.</p>
      <ResetPasswordForm token={token} />
      <div className="auth-links">
        <Link href="/forgot-password">Request a new link</Link>
        <Link href="/login">Back to sign in</Link>
      </div>
    </>
  );
}
