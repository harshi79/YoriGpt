/**
 * Maps Better Auth error codes to short, non-enumerating messages. Unknown
 * codes fall back to the library's own message, which is already written to be
 * safe to display; raw server errors are never shown.
 */
const MESSAGES: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "That email and password combination is not valid.",
  USER_ALREADY_EXISTS: "An account with this email already exists. Try signing in instead.",
  EMAIL_NOT_VERIFIED: "Verify your email address before signing in. Check your inbox for the link.",
  INVALID_TOKEN: "This link is invalid or has expired. Request a new one.",
  TOKEN_EXPIRED: "This link has expired. Request a new one.",
  PASSWORD_TOO_SHORT: "That password is too short.",
  PASSWORD_TOO_LONG: "That password is too long.",
  INVALID_EMAIL: "Enter a valid email address.",
  RESET_PASSWORD_DISABLED: "Password reset is not available on this server.",
  FAILED_TO_CREATE_USER: "We could not create your account. Please try again.",
  FAILED_TO_SEND_VERIFICATION_EMAIL:
    "Your account was created, but the verification email could not be sent. This server may not have email delivery configured.",
  FAILED_TO_SEND_RESET_PASSWORD_EMAIL:
    "We could not send the reset email. This server may not have email delivery configured.",
  VERIFICATION_FAILED: "That verification link is invalid or has expired.",
  EMAIL_ALREADY_VERIFIED: "This email address is already verified.",
};

const NETWORK_MESSAGE = "We could not reach the server. Check your connection and try again.";

export function describeAuthError(error: {
  code?: string | undefined;
  message?: string | undefined;
  status?: number | undefined;
}): string {
  if (error.code && MESSAGES[error.code]) return MESSAGES[error.code];
  if (error.status === 0 || error.status === undefined) return NETWORK_MESSAGE;
  return error.message?.trim() || "Something went wrong. Please try again.";
}
