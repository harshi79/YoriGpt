import type { Metadata } from "next";
import Link from "next/link";
import { YoriMark } from "@/components/ui/icon";
import { isEmailDeliveryConfigured } from "@/server/email/mailer";

export const metadata: Metadata = {
  title: "Account · YoriGPT",
  description: "Sign in or create a YoriGPT account.",
};

// Auth pages read the session cookie and configuration per request; they must
// never be prerendered at build time (which would require auth configuration).
export const dynamic = "force-dynamic";

export default function AuthLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const emailConfigured = isEmailDeliveryConfigured();

  return (
    <div className="auth-shell">
      <header className="auth-topbar">
        <Link className="brand" href="/">
          <YoriMark />
          <span>
            Yori<span className="brand-light">GPT</span>
          </span>
        </Link>
        <Link className="auth-topbar-link" href="/">
          Back to chat
        </Link>
      </header>
      <main className="auth-main">
        <div className="auth-card">{children}</div>
        {emailConfigured ? null : (
          <p className="auth-config-note">
            Email delivery is not configured on this server, so verification and password reset emails
            cannot be sent yet. Accounts and sessions still work; set <code>SMTP_URL</code> and{" "}
            <code>EMAIL_FROM</code> to enable mail.
          </p>
        )}
      </main>
    </div>
  );
}
