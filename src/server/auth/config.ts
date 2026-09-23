import "server-only";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { getDb } from "../db/client";
import { getServerEnv } from "../env";
import { deliverAuthEmail, type AuthEmail } from "../email/mailer";

/** Injected so tests can capture messages instead of contacting SMTP. */
export type AuthEmailSender = (email: AuthEmail) => Promise<void>;

function verificationEmail(email: string, url: string): AuthEmail {
  return {
    to: email,
    subject: "Verify your YoriGPT email address",
    heading: "Confirm your email address",
    paragraphs: [
      "Welcome to YoriGPT. Confirm this address to finish setting up your account.",
    ],
    action: { label: "Verify email", url },
    expiresInMinutes: 60,
  };
}

function passwordResetEmail(email: string, url: string): AuthEmail {
  return {
    to: email,
    subject: "Reset your YoriGPT password",
    heading: "Reset your password",
    paragraphs: ["A password reset was requested for your YoriGPT account."],
    action: { label: "Choose a new password", url },
    expiresInMinutes: 60,
  };
}

/**
 * Builds the Better Auth instance. Nothing here runs at import time: environment
 * variables and the database client are resolved when the caller invokes this
 * function, so builds and unrelated tests never require auth configuration.
 */
export function createAuth(sendEmail: AuthEmailSender = deliverAuthEmail) {
  const { APP_URL } = getServerEnv("app");
  const { AUTH_SECRET, AUTH_TRUSTED_ORIGINS } = getServerEnv("auth");

  return betterAuth({
    appName: "YoriGPT",
    baseURL: APP_URL,
    secret: AUTH_SECRET,
    // APP_URL is always trusted; extra deployment origins are opt-in via env.
    trustedOrigins: AUTH_TRUSTED_ORIGINS,
    database: prismaAdapter(getDb(), { provider: "postgresql", transaction: true }),
    emailAndPassword: {
      enabled: true,
      // Better Auth's recommended default. Accounts are usable before
      // verification; set true (after mail delivery works) to require it.
      requireEmailVerification: false,
      // Passwords are hashed by Better Auth (Scrypt). We never hash our own.
      sendResetPassword: async ({ user, url }) => {
        await sendEmail(passwordResetEmail(user.email, url));
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await sendEmail(verificationEmail(user.email, url));
      },
    },
    advanced: {
      cookiePrefix: "yorigpt",
    },
    session: {
      // Library defaults, stated explicitly: 7-day sessions refreshed daily.
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
  });
}
