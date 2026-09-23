// Client-side feedback only. Better Auth validates again on the server, and the
// server is always authoritative; these rules mirror documented defaults.
export const MIN_PASSWORD_LENGTH = 8;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateName(value: string): string | null {
  return value.trim().length > 0 ? null : "Enter your name.";
}

export function validateEmail(value: string): string | null {
  const email = value.trim();
  if (!email) return "Enter your email address.";
  return EMAIL_PATTERN.test(email) ? null : "Enter a valid email address.";
}

export function validatePassword(value: string): string | null {
  if (!value) return "Enter a password.";
  if (value.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (value.length > 128) return "Passwords cannot be longer than 128 characters.";
  return null;
}

export function validatePasswordConfirmation(password: string, confirmation: string): string | null {
  return password === confirmation ? null : "Passwords do not match.";
}

export function validateResetToken(token: string): string | null {
  return token.trim().length > 0 ? null : "This reset link is missing its token.";
}
