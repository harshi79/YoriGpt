import type { Metadata } from "next";
import Link from "next/link";
import { LoginForm } from "@/features/auth/components/login-form";
import { requireAnonymous } from "@/server/auth/session";

export const metadata: Metadata = { title: "Sign in · YoriGPT" };

export default async function LoginPage() {
  await requireAnonymous();

  return (
    <>
      <h1>Sign in</h1>
      <p className="auth-lead">Welcome back. Sign in to continue where you left off.</p>
      <LoginForm />
      <div className="auth-links">
        <Link href="/forgot-password">Forgot your password?</Link>
        <Link href="/register">Create an account</Link>
      </div>
    </>
  );
}
