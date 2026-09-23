import { expect, test, type Page } from "@playwright/test";
import {
  DATABASE_SKIP_REASON,
  conversationIdFromUrl,
  databaseUrl,
  removeTestAccounts,
  signUp,
} from "./support";

/**
 * Browser coverage for assistant replies. The production server under test is
 * pointed at the deterministic OpenRouter-compatible stub (tests/e2e/
 * mock-openrouter.mjs), so no real provider call or API key is involved.
 */
test.skip(!databaseUrl, DATABASE_SKIP_REASON);

test.afterAll(removeTestAccounts);

async function openNewConversation(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(page).toHaveURL(/\/chat\/[A-Za-z0-9_-]+$/);
  return conversationIdFromUrl(page);
}

async function send(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Message YoriGPT" }).fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
}

function userMessages(page: Page) {
  return page.locator(".conversation-messages").getByRole("article", { name: "User message" });
}

function assistantMessages(page: Page) {
  return page.locator(".conversation-messages").getByRole("article", { name: "Assistant message" });
}

/**
 * Only replies that are stored. The in-progress streaming bubble shares the same
 * accessible name, so completion is asserted against the stored rows instead.
 */
function storedReplies(page: Page) {
  return page
    .locator(".conversation-messages")
    .locator('article[aria-label="Assistant message"]:not([data-stream-state="streaming"])');
}

/** The reply status region; Next.js renders its own alert for route changes. */
function replyNotice(page: Page) {
  return page.locator(".reply-notice");
}

function assistantReplyTo(page: Page, text: string) {
  return assistantMessages(page).filter({ hasText: text });
}

test("a user message is answered by a stored assistant reply", async ({ page }) => {
  await signUp(page, "reply");
  const conversationId = await openNewConversation(page);

  await send(page, "Where does curiosity start?");

  // The stored user message appears immediately, the reply once it is stored.
  await expect(userMessages(page)).toHaveCount(1);
  await expect(storedReplies(page)).toHaveCount(1);
  await expect(assistantReplyTo(page, "Mock reply: Where does curiosity start?")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
  await expect(page.getByText("Generating a reply…")).toHaveCount(0);

  // Both rows are stored, in order, and nothing was invented client-side.
  const response = await page.context().request.get(`/api/conversations/${conversationId}/messages`);
  expect(response.status()).toBe(200);
  const body = (await response.json()) as {
    messages: { role: string; content: string; position: number }[];
  };
  expect(body.messages.map(({ role, content, position }) => ({ role, content, position }))).toEqual([
    { role: "USER", content: "Where does curiosity start?", position: 0 },
    { role: "ASSISTANT", content: "Mock reply: Where does curiosity start?", position: 1 },
  ]);

  // A reload shows the same exchange from the database.
  await page.reload();
  await expect(userMessages(page).filter({ hasText: "Where does curiosity start?" })).toHaveCount(1);
  await expect(assistantReplyTo(page, "Mock reply: Where does curiosity start?")).toHaveCount(1);
});

test("multiple turns keep the user, assistant, user, assistant order", async ({ page }) => {
  await signUp(page, "turns");
  const conversationId = await openNewConversation(page);

  await send(page, "First question");
  await expect(assistantReplyTo(page, "Mock reply: First question")).toHaveCount(1);
  await expect(storedReplies(page)).toHaveCount(1);
  await send(page, "Second question");
  await expect(assistantReplyTo(page, "Mock reply: Second question")).toHaveCount(1);
  await expect(storedReplies(page)).toHaveCount(2);

  await page.reload();
  const messages = page.locator(".conversation-messages article");
  await expect(messages).toHaveCount(4);
  expect(await messages.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")))).toEqual([
    "User message",
    "Assistant message",
    "User message",
    "Assistant message",
  ]);
  expect(await messages.allInnerTexts()).toEqual([
    expect.stringContaining("First question"),
    expect.stringContaining("Mock reply: First question"),
    expect.stringContaining("Second question"),
    expect.stringContaining("Mock reply: Second question"),
  ]);

  const response = await page.context().request.get(`/api/conversations/${conversationId}/messages`);
  const body = (await response.json()) as { messages: { role: string; position: number }[] };
  expect(body.messages.map((message) => message.position)).toEqual([0, 1, 2, 3]);
});

test("a provider failure shows a truthful error, keeps the user message, and retries", async ({
  page,
}) => {
  await signUp(page, "failure");
  const conversationId = await openNewConversation(page);

  // The stub fails once for this text, then succeeds — so the retry recovers.
  await send(page, "[flaky] please answer this");

  await expect(userMessages(page)).toHaveCount(1);
  await expect(storedReplies(page)).toHaveCount(0);
  await expect(replyNotice(page)).toHaveClass(/is-error/);
  await expect(replyNotice(page)).toContainText("could not be generated");
  await expect(replyNotice(page).getByRole("button", { name: "Try again" })).toBeVisible();
  // Progress is a status line, never a fake assistant bubble.
  await expect(page.getByRole("article", { name: "Assistant message" })).toHaveCount(0);

  // Nothing was stored for the failed attempt.
  const afterFailure = await page.context().request.get(`/api/conversations/${conversationId}/messages`);
  const storedBefore = (await afterFailure.json()) as { messages: { role: string }[] };
  expect(storedBefore.messages.map((message) => message.role)).toEqual(["USER"]);

  await replyNotice(page).getByRole("button", { name: "Try again" }).click();
  await expect(storedReplies(page)).toHaveCount(1);
  await expect(assistantReplyTo(page, "Mock reply: [flaky] please answer this")).toHaveCount(1);
  await expect(replyNotice(page)).toHaveCount(0);

  // An empty provider answer is also refused rather than stored.
  await page.reload();
  await send(page, "[empty] nothing back please");
  await expect(replyNotice(page)).toContainText("could not be generated");
  await expect(storedReplies(page)).toHaveCount(1);
});

test("another account cannot generate a reply for someone else's conversation", async ({
  page,
  browser,
}) => {
  await signUp(page, "reply-owner");
  const conversationId = await openNewConversation(page);
  await send(page, "Owner question");
  await expect(storedReplies(page)).toHaveCount(1);

  const other = await browser.newContext();
  const otherPage = await other.newPage();
  try {
    await signUp(otherPage, "reply-intruder");

    const attempt = await otherPage.context().request.post(
      `/api/conversations/${conversationId}/reply`,
      { data: {} },
    );
    expect(attempt.status()).toBe(404);
    const unknown = await otherPage.context().request.post(
      "/api/conversations/cmunknownconversationid00/reply",
      { data: {} },
    );
    expect(await attempt.json()).toEqual(await unknown.json());

    await otherPage.goto(`/chat/${conversationId}`);
    await expect(otherPage.getByRole("heading", { level: 1, name: "Not found" })).toBeVisible();
  } finally {
    await other.close();
  }

  // The owner's conversation is unchanged: one message and one reply.
  await page.reload();
  await expect(page.locator(".conversation-messages article")).toHaveCount(2);
});

test("a signed-out visitor cannot generate a reply", async ({ page }) => {
  await signUp(page, "reply-signout");
  const conversationId = await openNewConversation(page);

  await page.context().clearCookies();
  const response = await page.context().request.post(`/api/conversations/${conversationId}/reply`, {
    data: {},
  });
  expect(response.status()).toBe(401);
  expect(await response.json()).toEqual({
    error: { code: "UNAUTHENTICATED", message: "Sign in to continue." },
  });

  await page.goto(`/chat/${conversationId}`);
  await expect(page).toHaveURL(/\/login$/);
});

test("a repeated generation request never stores a second reply", async ({ page }) => {
  await signUp(page, "duplicate");
  const conversationId = await openNewConversation(page);
  await send(page, "Answer me once");
  await expect(storedReplies(page)).toHaveCount(1);

  const first = await page.context().request.post(`/api/conversations/${conversationId}/reply`, {
    data: {},
  });
  expect(first.status()).toBe(400);

  const messages = await page.context().request.get(
    `/api/conversations/${conversationId}/messages`,
  );
  const body = (await messages.json()) as { messages: { role: string }[] };
  expect(body.messages.map((message) => message.role)).toEqual(["USER", "ASSISTANT"]);
});
