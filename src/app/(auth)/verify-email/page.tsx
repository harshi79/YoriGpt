import type { Metadata } from "next";
import Link from "next/link";
import { VerifyEmailPanel } from "@/features/auth/components/verify-email-panel";
import { getSession } from "@/server/auth/session";

export const metadata: Metadata = { title: "Verify email · YoriGPT" };

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const [{ status }, session] = await Promise.all([searchParams, getSession()]);

  return (
    <>
      <h1>Verify your email</h1>
      <VerifyEmailPanel
        email={session?.user.email}
        verified={session?.user.emailVerified ?? false}
        signedIn={Boolean(session)}
        status={status}
      />
      <div className="auth-links">
        <Link href="/login">Go to sign in</Link>
        <Link href="/">Back to chat</Link>
      </div>
    </>
  );
}
