import type { Metadata } from "next";
import Link from "next/link";
import { RegisterForm } from "@/features/auth/components/register-form";
import { requireAnonymous } from "@/server/auth/session";

export const metadata: Metadata = { title: "Create account · YoriGPT" };

export default async function RegisterPage() {
  await requireAnonymous();

  return (
    <>
      <h1>Create your account</h1>
      <p className="auth-lead">One account keeps your conversations together.</p>
      <RegisterForm />
      <div className="auth-links">
        <Link href="/login">Already have an account? Sign in</Link>
      </div>
    </>
  );
}
