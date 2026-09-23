import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth, type AuthSession, type AuthUser } from "./index";

export type { AuthSession, AuthUser };

/**
 * Reads the Better Auth session for the current request. Returns null when the
 * caller is not authenticated. Memoized per request so several components can
 * ask without repeating the lookup.
 */
export const getSession = cache(async (): Promise<AuthSession | null> => {
  const requestHeaders = await headers();
  return getAuth().api.getSession({ headers: requestHeaders });
});

/** The authenticated user, or null. Never throws for anonymous visitors. */
export async function getCurrentUser(): Promise<AuthUser | null> {
  return (await getSession())?.user ?? null;
}

export async function isAuthenticated(): Promise<boolean> {
  return (await getSession()) !== null;
}

/**
 * Server-side guard for future authenticated routes and services. Redirects
 * anonymous visitors instead of rendering protected data. Ownership checks for
 * specific records (conversations, messages) remain the responsibility of the
 * server services that load them.
 */
export async function requireUser(redirectTo = "/login"): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (!user) redirect(redirectTo);
  return user;
}

/** Keeps authenticated users away from pages that only make sense when signed out. */
export async function requireAnonymous(redirectTo = "/"): Promise<void> {
  if (await isAuthenticated()) redirect(redirectTo);
}
