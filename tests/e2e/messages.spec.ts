import { expect, test, type Page } from "@playwright/test";
import {
  DATABASE_SKIP_REASON,
  conversationIdFromUrl,
  databaseUrl,
  removeTestAccounts,
  signUp,
} from "./support";

/**
 * Browser coverage for stored user messages: writing one in the composer, seeing
 * it in the conversation, and finding it again after a reload. Only the disposable
 * PostgreSQL database makes these checks meaningful, so they are skipped without
 * DATABASE_TEST_URL. The reply that follows a user message is covered by
 * replies.spec.ts; these checks stay focused on the user's own rows.
 */
test.skip(!databaseUrl, DATABASE_SKIP_REASON);

test.afterAll(removeTestAccounts);

/** A fresh conversation opened in the browser, with its empty state shown. */
async function openNewConversation(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(page).toHaveURL(/\/chat\/[A-Za-z0-9_-]+$/);
  await expect(page.getByText("No messages yet.")).toBeVisible();
  return conversationIdFromUrl(page);
}

async function send(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Message YoriGPT" }).fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
}

function storedMessages(page: Page) {
  return page.locator(".conversation-messages").getByRole("article", { name: "User message" });
}

/** Replies that are actually stored; the streaming bubble is not one of them. */
function storedReplies(page: Page) {
  return page
    .locator(".conversation-messages")
    .locator('article[aria-label="Assistant message"]:not([data-stream-state="streaming"])');
}

test("a signed-in owner sends a message and it is stored in the conversation", async ({ page }) => {
  await signUp(page, "send");
  const conversationId = await openNewConversation(page);

  await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
  await send(page, "Where does curiosity start?");

  // The stored message appears in the conversation and the composer is ready again.
  await expect(storedMessages(page)).toHaveCount(1);
  await expect(storedMessages(page).filter({ hasText: "Where does curiosity start?" })).toHaveCount(1);
  await expect(page.getByText("No messages yet.")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message YoriGPT" })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();

  // Stored rows are never labelled as examples.
  await expect(page.getByText("Copy example message")).toHaveCount(0);
  await expect(page.getByText("Example", { exact: true })).toHaveCount(0);

  // The API returns what was stored, in ascending position order: the user's own
  // message first, then the reply the server generated for it.
  const response = await page.context().request.get(`/api/conversations/${conversationId}/messages`);
  expect(response.status()).toBe(200);
  const body = (await response.json()) as {
    messages: { content: string; role: string; position: number }[];
  };
  expect(body.messages[0]).toEqual({
    id: expect.any(String),
    role: "USER",
    content: "Where does curiosity start?",
    position: 0,
    createdAt: expect.any(String),
    updatedAt: expect.any(String),
  });
  expect(body.messages[1]).toMatchObject({ role: "ASSISTANT", position: 1 });
});

test("a reload keeps the messages and their order", async ({ page }) => {
  await signUp(page, "reload");
  const conversationId = await openNewConversation(page);

  const contents = ["First thought", "Second thought", "Third thought"];
  for (const [index, text] of contents.entries()) {
    await send(page, text);
    await expect(storedMessages(page)).toHaveCount(index + 1);
    await expect(storedMessages(page).filter({ hasText: text })).toHaveCount(1);
    // Each send is answered: wait for the reply to be *stored* (the provisional
    // streaming bubble has the same accessible name but is not a stored row).
    await expect(storedReplies(page)).toHaveCount(index + 1);
  }

  await page.reload();
  await expect(storedMessages(page)).toHaveCount(3);
  expect(await storedMessages(page).allInnerTexts()).toEqual([
    expect.stringContaining("First thought"),
    expect.stringContaining("Second thought"),
    expect.stringContaining("Third thought"),
  ]);

  // The stored rows keep their order across a fresh read as well: each user
  // message is followed by the reply to it.
  const response = await page.context().request.get(`/api/conversations/${conversationId}/messages`);
  const body = (await response.json()) as { messages: { role: string; position: number }[] };
  expect(body.messages.map((message) => message.role)).toEqual([
    "USER",
    "ASSISTANT",
    "USER",
    "ASSISTANT",
    "USER",
    "ASSISTANT",
  ]);
  expect(body.messages.map((message) => message.position)).toEqual([0, 1, 2, 3, 4, 5]);
});

test("another account can neither read nor write someone else's messages", async ({
  page,
  browser,
}) => {
  await signUp(page, "message-owner");
  const conversationId = await openNewConversation(page);
  await send(page, "Private thought");
  await expect(storedMessages(page)).toHaveCount(1);

  const other = await browser.newContext();
  const otherPage = await other.newPage();
  try {
    await signUp(otherPage, "message-intruder");

    const read = await otherPage.context().request.get(`/api/conversations/${conversationId}/messages`);
    expect(read.status()).toBe(404);
    const write = await otherPage.context().request.post(
      `/api/conversations/${conversationId}/messages`,
      { data: { content: "Injected" } },
    );
    expect(write.status()).toBe(404);

    // The page shows the same not-found state as an unknown conversation.
    await otherPage.goto(`/chat/${conversationId}`);
    await expect(otherPage.getByRole("heading", { level: 1, name: "Not found" })).toBeVisible();
    await expect(otherPage.getByText("Private thought")).toHaveCount(0);
  } finally {
    await other.close();
  }

  // The owner still has exactly one message.
  await expect(storedMessages(page)).toHaveCount(1);
  await expect(storedMessages(page).filter({ hasText: "Private thought" })).toHaveCount(1);
});

test("a signed-out visitor cannot submit or read messages", async ({ page }) => {
  await signUp(page, "message-signout");
  const conversationId = await openNewConversation(page);

  await page.context().clearCookies();
  const write = await page.context().request.post(`/api/conversations/${conversationId}/messages`, {
    data: { content: "Anonymous" },
  });
  expect(write.status()).toBe(401);
  expect(await write.json()).toEqual({
    error: { code: "UNAUTHENTICATED", message: "Sign in to continue." },
  });
  expect(
    (await page.context().request.get(`/api/conversations/${conversationId}/messages`)).status(),
  ).toBe(401);

  // The conversation page has no composer for a signed-out visitor at all.
  await page.goto(`/chat/${conversationId}`);
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("textbox", { name: "Message YoriGPT" })).toHaveCount(0);
});
