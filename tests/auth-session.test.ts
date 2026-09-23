import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Unit coverage for the session-helper contract: which helper answers what when
 * the request is anonymous or authenticated. The helper's real, database-backed
 * behavior (session rows, cookies, expiry) is verified against PostgreSQL in
 * tests/database/auth.integration.ts; here the auth instance is stubbed so the
 * guards' control flow can be asserted without a live request.
 */
const sessionHolder: { value: { user: unknown; session: unknown } | null } = { value: null };
const getSession = vi.fn(async () => sessionHolder.value);

vi.mock("../src/server/auth", () => ({
  getAuth: () => ({ api: { getSession } }),
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers({ cookie: "yorigpt.session_token=fake" }) }));

vi.mock("next/navigation", () => ({
  redirect: (target: string) => {
    throw new Error(`REDIRECT:${target}`);
  },
}));

const { getCurrentUser, getSession: readSession, isAuthenticated, requireAnonymous, requireUser } = await import(
  "../src/server/auth/session"
);

const user = { id: "user_1", email: "person@example.com", name: "Person", emailVerified: false };

describe("server session helpers", () => {
  it("reports an anonymous request without throwing", async () => {
    sessionHolder.value = null;
    expect(await readSession()).toBeNull();
    expect(await getCurrentUser()).toBeNull();
    expect(await isAuthenticated()).toBe(false);
    // The helper asks Better Auth with the incoming request headers only.
    expect(getSession).toHaveBeenCalled();
  });

  it("returns the authenticated user and session for a signed-in request", async () => {
    sessionHolder.value = { user, session: { token: "token_1" } };
    expect(await isAuthenticated()).toBe(true);
    expect(await getCurrentUser()).toMatchObject({ id: "user_1", email: "person@example.com" });
  });

  it("redirects anonymous visitors away from protected helpers", async () => {
    sessionHolder.value = null;
    await expect(requireUser()).rejects.toThrow("REDIRECT:/login");
    await expect(requireUser("/onboarding")).rejects.toThrow("REDIRECT:/onboarding");
  });

  it("keeps signed-in users away from sign-in-only pages", async () => {
    sessionHolder.value = { user, session: { token: "token_1" } };
    await expect(requireAnonymous()).rejects.toThrow("REDIRECT:/");

    sessionHolder.value = null;
    await expect(requireAnonymous()).resolves.toBeUndefined();
  });
});
