import "server-only";
import { getServerEnv } from "../env";

/**
 * Small helpers shared by the JSON API routes: one response envelope, and the
 * same-origin check that protects cookie-authenticated writes (Better Auth's own
 * endpoints enforce this internally; route handlers must do it explicitly).
 */

export function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export function errorResponse(code: string, message: string, status: number): Response {
  return jsonResponse({ error: { code, message } }, status);
}

export const unauthenticatedResponse = () =>
  errorResponse("UNAUTHENTICATED", "Sign in to continue.", 401);

export const forbiddenOriginResponse = () =>
  errorResponse("FORBIDDEN_ORIGIN", "This request came from an untrusted origin.", 403);

export const notFoundResponse = () =>
  errorResponse("NOT_FOUND", "Conversation not found.", 404);

export const invalidRequestResponse = (message: string) =>
  errorResponse("INVALID_REQUEST", message, 400);

export const serverErrorResponse = () =>
  errorResponse("INTERNAL_ERROR", "Something went wrong. Try again.", 500);

/**
 * AI replies need provider credentials at runtime, not at build time. A server
 * without them answers a controlled error instead of failing to start.
 */
export const aiNotConfiguredResponse = () =>
  errorResponse("AI_NOT_CONFIGURED", "AI replies are not configured on this server.", 500);

/** A configured provider failed; the stored conversation is untouched. */
export const aiGenerationFailedResponse = () =>
  errorResponse(
    "INTERNAL_ERROR",
    "The assistant reply could not be generated. Try again.",
    500,
  );

/** Origins allowed to call the API: the app origin plus configured extras. */
export function trustedOrigins(): string[] {
  const { APP_URL } = getServerEnv("app");
  const { AUTH_TRUSTED_ORIGINS } = getServerEnv("auth");
  const origins = [originOf(APP_URL), ...AUTH_TRUSTED_ORIGINS.map(originOf)];
  return origins.filter((origin): origin is string => Boolean(origin));
}

function originOf(value: string): string | null {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (trimmed === "") return null;
  if (trimmed.includes("*")) return trimmed.toLowerCase();
  try {
    const url = new URL(trimmed);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return null;
  }
}

function matchesTrustedOrigin(candidate: string, trusted: string): boolean {
  if (!trusted.includes("*")) return candidate === trusted;
  // `*` matches any characters except a path separator, so `https://*.example.com`
  // covers deployed sub-domains and preview hosts.
  const pattern = new RegExp(
    `^${trusted.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`,
  );
  return pattern.test(candidate);
}

/**
 * True when a state-changing request may proceed. Browsers send `Origin` for
 * cross-site writes (and `Sec-Fetch-Site`), so an untrusted or cross-site value
 * is rejected; non-browser callers (scripts, tests) send neither and are allowed,
 * because they cannot be driven by another site's page.
 */
export function isTrustedRequestOrigin(request: Request): boolean {
  const origins = trustedOrigins();
  const origin = request.headers.get("origin");
  if (origin) {
    const candidate = origin.toLowerCase();
    return origins.some((trusted) => matchesTrustedOrigin(candidate, trusted));
  }
  const site = request.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  return true;
}
