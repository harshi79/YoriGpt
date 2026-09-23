import "server-only";
import { getServerEnv } from "../env";

/** Thrown when SMTP is not configured, so callers never pretend mail was sent. */
export class EmailDeliveryNotConfiguredError extends Error {
  readonly code = "EMAIL_NOT_CONFIGURED";

  constructor() {
    super("SMTP_URL and EMAIL_FROM must be configured before authentication email can be sent.");
    this.name = "EmailDeliveryNotConfiguredError";
  }
}

export type AuthEmail = {
  to: string;
  subject: string;
  heading: string;
  /** Plain sentences rendered in both the text and HTML parts. */
  paragraphs: string[];
  action: { label: string; url: string };
  expiresInMinutes: number;
};

/** Presence check only; full validation happens when a message is actually sent. */
export function isEmailDeliveryConfigured(): boolean {
  return Boolean(process.env.SMTP_URL?.trim() && process.env.EMAIL_FROM?.trim());
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Auth links must point at the configured application origin. Prisma/Better Auth
 * build these URLs from APP_URL, so a mismatch means a misconfiguration or a
 * tampered redirect target and the message is refused instead of delivered.
 */
function assertTrustedLink(url: string, appUrl: string): void {
  let link: URL;
  try {
    link = new URL(url);
  } catch {
    throw new Error("Refusing to send authentication email with an unparseable link.");
  }
  if (link.origin !== new URL(appUrl).origin) {
    throw new Error("Refusing to send authentication email with a link outside APP_URL.");
  }
}

export function renderAuthEmail(email: AuthEmail): { text: string; html: string } {
  const expires = `This link expires in ${email.expiresInMinutes} minutes and can only be used once.`;
  const text = [
    email.heading,
    "",
    ...email.paragraphs,
    "",
    `${email.action.label}: ${email.action.url}`,
    "",
    expires,
    "",
    "If you did not request this, you can ignore this message.",
  ].join("\n");

  const paragraphs = [...email.paragraphs, expires, "If you did not request this, you can ignore this message."]
    .map((paragraph) => `<p style="margin:0 0 16px;color:#3f463f">${escapeHtml(paragraph)}</p>`)
    .join("");

  const html = `<!doctype html>
<html lang="en"><body style="margin:0;background:#f4f6f3;font-family:Arial,Helvetica,sans-serif">
<div style="max-width:520px;margin:0 auto;padding:32px 24px">
  <h1 style="font-size:20px;color:#171919;margin:0 0 16px">${escapeHtml(email.heading)}</h1>
  ${paragraphs}
  <p style="margin:0 0 24px"><a href="${escapeHtml(email.action.url)}" style="background:#171919;color:#eeefec;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block">${escapeHtml(email.action.label)}</a></p>
  <p style="margin:0;color:#79837c;font-size:13px;word-break:break-all">${escapeHtml(email.action.url)}</p>
</div></body></html>`;

  return { text, html };
}

/**
 * Server-only SMTP delivery. Fails loudly when unconfigured rather than
 * reporting success; callers run inside Better Auth's background-task wrapper,
 * which logs the failure without claiming to the user that mail was delivered.
 */
export async function deliverAuthEmail(email: AuthEmail): Promise<void> {
  if (!isEmailDeliveryConfigured()) throw new EmailDeliveryNotConfiguredError();
  const { SMTP_URL, EMAIL_FROM } = getServerEnv("email");
  assertTrustedLink(email.action.url, getServerEnv("app").APP_URL);

  const { default: nodemailer } = await import("nodemailer");
  // Bounded timeouts so a misconfigured mail host cannot hold a request open.
  const transport = nodemailer.createTransport({
    // nodemailer accepts a connection URL in transport options, but its bundled
    // types do not declare the property.
    ...({ url: SMTP_URL } as { url: string }),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  try {
    await transport.sendMail({ from: EMAIL_FROM, to: email.to, subject: email.subject, ...renderAuthEmail(email) });
  } finally {
    transport.close();
  }
}
