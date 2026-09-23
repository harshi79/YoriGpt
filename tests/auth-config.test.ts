import type { BetterAuthOptions } from "better-auth";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const SECRET = "auth-test-secret-value-that-is-long-enough";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("auth server configuration", () => {
  it("imports without reading environment variables", async () => {
    vi.stubEnv("AUTH_SECRET", undefined);
    vi.stubEnv("APP_URL", undefined);
    vi.stubEnv("DATABASE_URL", undefined);
    await expect(import("../src/server/auth")).resolves.toBeDefined();
  });

  it("reports missing configuration only when an instance is requested", async () => {
    vi.stubEnv("AUTH_SECRET", undefined);
    vi.stubEnv("APP_URL", "http://localhost:3000");
    const { getAuth } = await import("../src/server/auth");
    expect(() => getAuth()).toThrow(/APP_URL|AUTH_SECRET|auth/i);
  });

  it("uses Better Auth defaults for credentials, sessions, and cookies", async () => {
    vi.stubEnv("AUTH_SECRET", SECRET);
    vi.stubEnv("APP_URL", "http://localhost:3000");
    vi.stubEnv("DATABASE_URL", "postgresql://validation:validation@localhost:5432/validation");
    vi.stubEnv("AUTH_TRUSTED_ORIGINS", "https://preview.example, https://staging.example");
    const { getAuth } = await import("../src/server/auth");
    // Read through the library's own option type so the assertions describe the
    // exact configuration Better Auth resolves.
    const options = getAuth().options as BetterAuthOptions;

    expect(options.emailAndPassword?.enabled).toBe(true);
    expect(options.emailAndPassword?.requireEmailVerification).toBe(false);
    // Password hashing stays inside Better Auth: no custom hash/verify functions.
    expect(options.emailAndPassword?.password).toBeUndefined();
    expect(typeof options.emailAndPassword?.sendResetPassword).toBe("function");
    expect(typeof options.emailVerification?.sendVerificationEmail).toBe("function");
    expect(options.emailVerification?.sendOnSignUp).toBe(true);
    expect(options.emailVerification?.expiresIn).toBeUndefined();
    expect(options.emailAndPassword?.resetPasswordTokenExpiresIn).toBeUndefined();
    expect(options.advanced?.cookiePrefix).toBe("yorigpt");
    expect(options.baseURL).toBe("http://localhost:3000");
    expect(options.secret).toBe(SECRET);
    expect(options.trustedOrigins).toEqual(["https://preview.example", "https://staging.example"]);
    expect(options.socialProviders).toBeUndefined();
    expect(getAuth()).toBe(getAuth());
  });
});

describe("authentication email", () => {
  it("reports that delivery is unconfigured instead of pretending to send", async () => {
    vi.stubEnv("SMTP_URL", undefined);
    vi.stubEnv("EMAIL_FROM", undefined);
    const { deliverAuthEmail, EmailDeliveryNotConfiguredError, isEmailDeliveryConfigured } = await import(
      "../src/server/email/mailer"
    );
    expect(isEmailDeliveryConfigured()).toBe(false);
    await expect(
      deliverAuthEmail({
        to: "person@example.invalid",
        subject: "Subject",
        heading: "Heading",
        paragraphs: ["Body"],
        action: { label: "Act", url: "http://localhost:3000/api/auth/verify-email?token=x" },
        expiresInMinutes: 60,
      }),
    ).rejects.toBeInstanceOf(EmailDeliveryNotConfiguredError);
  });

  it("refuses to email a link that leaves the configured application origin", async () => {
    vi.stubEnv("SMTP_URL", "smtps://user:password@smtp.example.invalid:465");
    vi.stubEnv("EMAIL_FROM", "no-reply@example.invalid");
    vi.stubEnv("APP_URL", "http://localhost:3000");
    const { deliverAuthEmail } = await import("../src/server/email/mailer");
    await expect(
      deliverAuthEmail({
        to: "person@example.invalid",
        subject: "Subject",
        heading: "Heading",
        paragraphs: ["Body"],
        action: { label: "Act", url: "https://attacker.invalid/steal?token=x" },
        expiresInMinutes: 60,
      }),
    ).rejects.toThrow(/outside APP_URL/);
  });

  it("escapes interpolated content in the HTML part", async () => {
    const { renderAuthEmail } = await import("../src/server/email/mailer");
    const { html, text } = renderAuthEmail({
      to: "person@example.invalid",
      subject: "Subject",
      heading: "<b>Hello</b>",
      paragraphs: ['Click <script>alert("x")</script>'],
      action: { label: "Act", url: "http://localhost:3000/api/auth/verify-email?token=x&callbackURL=y" },
      expiresInMinutes: 60,
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("token=x&amp;callbackURL=y");
    expect(text).toContain("60 minutes");
  });
});

describe("client/server boundary for authentication", () => {
  async function collect(directory: string): Promise<string[]> {
    const { readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const found: string[] = [];
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) found.push(...(await collect(path)));
      else found.push(path);
    }
    return found;
  }

  it("keeps the browser-facing auth feature free of server configuration", async () => {
    const { readFileSync } = await import("node:fs");
    const files = await collect("src/features/auth");
    expect(files.length).toBeGreaterThan(8);

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const forbidden of ["AUTH_SECRET", "DATABASE_URL", "SMTP_URL", "process.env", "getServerEnv", "@prisma/client", "NEXT_PUBLIC_"]) {
        expect(source, `${file} must not reference ${forbidden}`).not.toContain(forbidden);
      }
      expect(source, `${file} must not import server-only modules`).not.toMatch(/from "\.\.\/\.\.\/server|from "@\/server/);
    }
    expect(readFileSync("src/features/auth/client.ts", "utf8")).toContain('"use client"');
  });

  it("keeps auth pages server-rendered and the auth instance server-only", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of await collect("src/app/(auth)")) {
      const source = readFileSync(file, "utf8");
      expect(source, `${file} must stay a server component`).not.toContain('"use client"');
      expect(source).not.toContain("NEXT_PUBLIC_");
    }
    for (const file of ["src/server/auth/config.ts", "src/server/auth/index.ts", "src/server/auth/session.ts", "src/server/email/mailer.ts"]) {
      expect(readFileSync(file, "utf8").startsWith('import "server-only"'), `${file} must be server-only`).toBe(true);
    }
  });
});
