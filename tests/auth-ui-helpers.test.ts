import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

describe("auth form validation", () => {
  it("accepts well-formed input", async () => {
    const { validateEmail, validateName, validatePassword, validatePasswordConfirmation, validateResetToken } =
      await import("../src/features/auth/validation");
    expect(validateName("Ada")).toBeNull();
    expect(validateEmail("ada@example.com")).toBeNull();
    expect(validatePassword("long-enough-password")).toBeNull();
    expect(validatePasswordConfirmation("a-long-password", "a-long-password")).toBeNull();
    expect(validateResetToken("token-value")).toBeNull();
  });

  it("explains what is wrong without leaking server behaviour", async () => {
    const { validateEmail, validateName, validatePassword, validatePasswordConfirmation, validateResetToken } =
      await import("../src/features/auth/validation");
    expect(validateName("   ")).toMatch(/name/i);
    expect(validateEmail("")).toMatch(/email/i);
    expect(validateEmail("not-an-email")).toMatch(/valid email/i);
    expect(validatePassword("short")).toMatch(/at least 8/i);
    expect(validatePassword("x".repeat(129))).toMatch(/longer/i);
    expect(validatePasswordConfirmation("one-password", "two-password")).toMatch(/do not match/i);
    expect(validateResetToken("  ")).toMatch(/token/i);
  });
});

describe("auth error messages", () => {
  it("maps library codes to short human messages", async () => {
    const { describeAuthError } = await import("../src/features/auth/errors");
    expect(describeAuthError({ code: "INVALID_EMAIL_OR_PASSWORD", status: 401 })).toMatch(/not valid/i);
    expect(describeAuthError({ code: "USER_ALREADY_EXISTS", status: 422 })).toMatch(/already exists/i);
    expect(describeAuthError({ code: "INVALID_TOKEN", status: 400 })).toMatch(/invalid or has expired/i);
    expect(describeAuthError({ code: "UNKNOWN_CODE", message: "Library message", status: 400 })).toBe("Library message");
    expect(describeAuthError({ code: "UNKNOWN_CODE", status: 0 })).toMatch(/could not reach/i);
    expect(describeAuthError({})).toMatch(/could not reach|something went wrong/i);
  });
});
