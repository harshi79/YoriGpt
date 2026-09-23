import { expect, type Page } from "@playwright/test";
import { Client } from "pg";

/**
 * Shared helpers for the database-backed browser checks. Every account created
 * here uses a reserved test domain and is deleted afterwards; conversations and
 * messages cascade, so the disposable database keeps no application rows.
 */
export const databaseUrl = process.env.DATABASE_TEST_URL;

export const DATABASE_SKIP_REASON =
  "Set DATABASE_TEST_URL to a disposable PostgreSQL database to run the signed-in checks.";

export const TEST_DOMAIN = "conversation-e2e.invalid";
export const password = "correct-horse-battery";

export async function signUp(page: Page, label: string) {
  const email = `conversation-e2e-${label}-${Date.now()}-${Math.round(Math.random() * 1e6)}@${TEST_DOMAIN}`;

  for (let attempt = 1; ; attempt += 1) {
    const response = await page.context().request.post("/api/auth/sign-up/email", {
      data: { name: `E2E ${label}`, email, password },
    });
    if (response.status() === 200) return email;
    expect(
      response.status() === 429 && attempt < 4,
      `sign-up failed for ${email} with ${response.status()}`,
    ).toBe(true);

    // Better Auth allows three sign-ups per ten seconds and reports the wait in
    // X-Retry-After. The suite signs up several accounts, so it waits instead of
    // failing (production keeps the limit; nothing is disabled for the tests).
    const retryAfter = Number(response.headers()["x-retry-after"] ?? "1");
    const wait = Math.min(Math.max(retryAfter, 1), 15) * 1000 + 250;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/** Model identifiers the OpenRouter stub was asked for, newest last. */
export async function requestedModels(page: Page): Promise<string[]> {
  const response = await page.context().request.get("http://127.0.0.1:3210/model-log");
  expect(response.status()).toBe(200);
  return ((await response.json()) as { models: string[] }).models;
}

export async function clearRequestedModels(page: Page): Promise<void> {
  const response = await page.context().request.post("http://127.0.0.1:3210/model-log/clear");
  expect(response.status()).toBe(200);
}

export async function conversationIdFromUrl(page: Page) {
  const match = new URL(page.url()).pathname.match(/^\/chat\/(.+)$/);
  expect(match, `expected a conversation URL, got ${page.url()}`).not.toBeNull();
  return match![1];
}

export async function removeTestAccounts() {
  if (!databaseUrl) return;
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query("DELETE FROM users WHERE email LIKE $1", [`%@${TEST_DOMAIN}`]);
  await client.end();
}
