import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { createAuth } from "../../src/server/auth/config";
import type { AuthEmail } from "../../src/server/email/mailer";
import { getDb } from "../../src/server/db/client";

// Real Better Auth against a disposable PostgreSQL database. Email is captured
// in-process: no SMTP server, no external service, no real messages.
const sent: AuthEmail[] = [];
let auth: ReturnType<typeof createAuth>;

const TEST_DOMAIN = "auth-test.invalid";
const password = "correct-horse-battery";
let db: ReturnType<typeof getDb>;

function post(path: string, body: unknown, cookie?: string) {
  return auth.handler(
    new Request(`http://localhost:3000/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    }),
  );
}

function tokenFrom(email: AuthEmail | undefined): string {
  const url = new URL(email!.action.url);
  const token = url.searchParams.get("token") ?? url.pathname.split("/").pop();
  if (!token) throw new Error("no token in captured email link");
  return token;
}

function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie");
  if (!header) throw new Error("expected a session cookie");
  return header.split(";")[0];
}

async function signUp(email: string, name = "Auth Test") {
  return post("/sign-up/email", { name, email, password, callbackURL: "/verify-email?status=verified" });
}

beforeAll(async () => {
  if (!process.env.DATABASE_TEST_URL)
    throw new Error(
      "Set DATABASE_TEST_URL to a migrated disposable PostgreSQL database before running npm run test:db.",
    );
  vi.stubEnv("DATABASE_URL", process.env.DATABASE_TEST_URL);
  vi.stubEnv("APP_URL", "http://localhost:3000");
  vi.stubEnv("AUTH_SECRET", "auth-test-secret-value-that-is-long-enough");
  auth = createAuth(async (email) => {
    sent.push(email);
  });
  db = getDb();
});
afterAll(async () => {
  // This suite only ever runs against a disposable database (documented in
  // docs/authentication.md). Clean up everything it created: reset rows are keyed
  // by token and may reference an address that never existed, so they are removed
  // by identifier prefix as well as by user id.
  const users = await db.user.findMany({ where: { email: { endsWith: `@${TEST_DOMAIN}` } }, select: { id: true } });
  const ids = users.map((user) => user.id);
  await db.verification.deleteMany({
    where: { OR: [{ value: { in: ids } }, { identifier: { in: ids } }, { identifier: { startsWith: "reset-password:" } }] },
  });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
  vi.unstubAllEnvs();
});

describe("registration", () => {
  it("creates a real user with a hashed password and no session data faked", async () => {
    const email = `signup-${Date.now()}@${TEST_DOMAIN}`;
    const response = await signUp(email);
    expect(response.status).toBe(200);

    const user = await db.user.findUniqueOrThrow({ where: { email } });
    expect(user.emailVerified).toBe(false);
    expect(user.name).toBe("Auth Test");
    expect(user.status).toBe("ACTIVE");

    const account = await db.account.findFirstOrThrow({ where: { userId: user.id } });
    expect(account.providerId).toBe("credential");
    expect(account.password).toBeTruthy();
    expect(account.password).not.toContain(password);
    expect(account.password?.startsWith("$")).toBe(false);

    // Sign-up sends a verification link. In Better Auth 1.7 email verification
    // uses a signed, expiring token (not a stored row), so nothing is persisted
    // in `verifications` until a token is actually consumed by a reset flow.
    expect(sent.at(-1)?.to).toBe(email);
    const link = new URL(sent.at(-1)!.action.url);
    expect(link.pathname).toBe("/api/auth/verify-email");
    expect(link.searchParams.get("token")).toBeTruthy();
    const payload = JSON.parse(Buffer.from(link.searchParams.get("token")!.split(".")[1], "base64url").toString());
    expect(payload.email).toBe(email);
    expect(payload.exp).toBeGreaterThan(payload.iat);
    expect(await db.verification.count({ where: { identifier: { contains: email } } })).toBe(0);
  });

  it("rejects an invalid email address", async () => {
    const response = await signUp("not-an-email");
    expect(response.status).toBe(400);
  });

  it("rejects a password shorter than the configured minimum", async () => {
    const response = await post("/sign-up/email", {
      name: "Weak",
      email: `weak-${Date.now()}@${TEST_DOMAIN}`,
      password: "short",
    });
    expect(response.status).toBe(400);
  });

  it("rejects duplicate addresses, including case-only differences", async () => {
    const email = `duplicate-${Date.now()}@${TEST_DOMAIN}`;
    expect((await signUp(email)).status).toBe(200);
    const again = await signUp(email.toUpperCase());
    expect(again.status).toBe(422);
    expect((await again.json()).message).toMatch(/already exists/i);
  });
});

describe("login and sessions", () => {
  it("authenticates valid credentials and serves the session to its cookie only", async () => {
    const email = `login-${Date.now()}@${TEST_DOMAIN}`;
    await signUp(email);

    const failed = await post("/sign-in/email", { email, password: "wrong-password-value" });
    expect(failed.status).toBe(401);

    const signedIn = await post("/sign-in/email", { email: email.toUpperCase(), password });
    expect(signedIn.status).toBe(200);
    const cookie = cookieFrom(signedIn);

    const session = await auth.handler(new Request("http://localhost:3000/api/auth/get-session", { headers: { cookie } }));
    const body = await session.json();
    expect(body.user.email).toBe(email);
    expect(body.session.token).toBeTruthy();

    // The session row is real, bound to that user, and expires in the future.
    const stored = await db.session.findFirstOrThrow({ where: { userId: body.user.id } });
    expect(stored.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const anonymous = await auth.handler(new Request("http://localhost:3000/api/auth/get-session"));
    expect(await anonymous.json()).toBeNull();
  });
});

describe("email verification", () => {
  it("verifies a real token, ignores forged tokens, and never issues a session from reuse", async () => {
    const email = `verify-${Date.now()}@${TEST_DOMAIN}`;
    await signUp(email);
    const token = tokenFrom(sent.at(-1));

    const verify = (candidate: string) =>
      auth.handler(new Request(`http://localhost:3000/api/auth/verify-email?token=${candidate}`));

    expect((await verify("not-a-real-token")).status).toBe(401);
    const ok = await verify(token);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toContain("session_token");
    expect((await db.user.findUniqueOrThrow({ where: { email } })).emailVerified).toBe(true);

    // Replaying the same signed token stays idempotent for the same address and
    // cannot verify a different one.
    expect((await verify(token)).status).toBe(200);
    const other = await db.user.findFirstOrThrow({ where: { email: { startsWith: "login-" } } });
    expect(other.emailVerified).toBe(false);
  });

  it("refuses an expired verification token", async () => {
    const email = `expired-${Date.now()}@${TEST_DOMAIN}`;
    await signUp(email);

    // Same HS256 payload shape Better Auth signs, with an expiry in the past.
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const header = encode({ alg: "HS256" });
    const payload = encode({ email, iat: Math.floor(Date.now() / 1000) - 7200, exp: Math.floor(Date.now() / 1000) - 3600 });
    const signature = createHmac("sha256", "auth-test-secret-value-that-is-long-enough")
      .update(`${header}.${payload}`)
      .digest("base64url");

    const response = await auth.handler(
      new Request(`http://localhost:3000/api/auth/verify-email?token=${header}.${payload}.${signature}`),
    );
    expect(response.status).toBe(401);
    expect((await db.user.findUniqueOrThrow({ where: { email } })).emailVerified).toBe(false);
  });
});

describe("password reset", () => {
  it("does not reveal whether an address exists", async () => {
    const response = await post("/request-password-reset", { email: `unknown-${Date.now()}@${TEST_DOMAIN}` });
    expect(response.status).toBe(200);
    expect((await response.json()).message).toMatch(/if this email exists/i);
  });

  it("resets a password with a single-use token and invalidates the old one", async () => {
    const email = `reset-${Date.now()}@${TEST_DOMAIN}`;
    await signUp(email);

    const request = await post("/request-password-reset", { email, redirectTo: "/reset-password" });
    expect(request.status).toBe(200);
    const token = tokenFrom(sent.at(-1));
    expect(sent.at(-1)?.action.url).toContain("/api/auth/reset-password/");

    const forged = await post("/reset-password", { newPassword: "another-long-password", token: "invalid-token" });
    expect(forged.status).toBe(400);
    expect((await db.user.findUniqueOrThrow({ where: { email } })).emailVerified).toBe(false);

    const reset = await post("/reset-password", { newPassword: "another-long-password", token });
    expect(reset.status).toBe(200);

    expect((await post("/sign-in/email", { email, password })).status).toBe(401);
    expect((await post("/sign-in/email", { email, password: "another-long-password" })).status).toBe(200);
    // Single use: the consumed token no longer works, and the stored hash changed.
    const reuse = await post("/reset-password", { newPassword: "third-long-password", token });
    expect(reuse.status).toBe(400);
    expect((await post("/sign-in/email", { email, password: "third-long-password" })).status).toBe(401);
  });
});
