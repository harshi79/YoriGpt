import { expect, test } from "@playwright/test";
import {
  DATABASE_SKIP_REASON,
  conversationIdFromUrl,
  databaseUrl,
  removeTestAccounts,
  signUp,
} from "./support";

/**
 * Browser coverage for the signed-in conversation flow. These checks need the
 * disposable PostgreSQL database, so they are skipped unless DATABASE_TEST_URL
 * is set (locally, and in the CI database job).
 */
test.skip(!databaseUrl, DATABASE_SKIP_REASON);

test.afterAll(removeTestAccounts);

test("a new account starts with an empty conversation list", async ({ page }) => {
  const email = await signUp(page, "empty");

  const sidebar = page.locator(".desktop-sidebar");

  await page.goto("/");
  await expect(sidebar.getByText("No conversations yet")).toBeVisible();
  await expect(sidebar.getByText(email)).toBeVisible();
  // Real data replaces the signed-out static example.
  await expect(sidebar.getByText("UI examples")).toHaveCount(0);
});

test("New chat creates a real conversation, opens it, and lists it", async ({ page }) => {
  await signUp(page, "create");
  const created: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/api/conversations"))
      created.push(request.url());
  });

  await page.goto("/");
  await page.getByRole("button", { name: "New chat", exact: true }).click();

  await expect(page).toHaveURL(/\/chat\/[A-Za-z0-9_-]+$/);
  const conversationId = await conversationIdFromUrl(page);
  expect(created).toHaveLength(1);

  // The chat area shows the stored conversation, never invented messages.
  await expect(page.getByRole("heading", { level: 1, name: "New chat" })).toBeVisible();
  await expect(page.getByText("No messages yet.")).toBeVisible();
  await expect(page.getByRole("article", { name: "Assistant message" })).toHaveCount(0);

  // The sidebar lists the same conversation and marks it as current.
  const row = page.locator(".desktop-sidebar").getByRole("link", { name: /New chat/ });
  await expect(row).toHaveAttribute("href", `/chat/${conversationId}`);
  await expect(row).toHaveAttribute("aria-current", "page");

  // It survives a reload because it is stored, not local state.
  await page.reload();
  await expect(page.locator(".desktop-sidebar").getByRole("link", { name: /New chat/ })).toBeVisible();

  // And it is still there from the new-chat route.
  await page.goto("/");
  await expect(page.locator(".desktop-sidebar").getByRole("link", { name: /New chat/ })).toBeVisible();
});

test("deleting a conversation removes it from the sidebar and the API", async ({ page }) => {
  await signUp(page, "delete");

  await page.goto("/");
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(page).toHaveURL(/\/chat\/[A-Za-z0-9_-]+$/);
  const conversationId = await conversationIdFromUrl(page);

  const del = page.getByRole("button", { name: "Delete New chat" });
  await del.click();
  await page.getByRole("button", { name: "Confirm delete New chat" }).click();

  // The selected conversation is gone, so the shell returns to the empty state.
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator(".desktop-sidebar").getByText("No conversations yet")).toBeVisible();

  const response = await page.context().request.get(`/api/conversations/${conversationId}`);
  expect(response.status()).toBe(404);
});

test("another account cannot open or delete someone else's conversation", async ({
  page,
  browser,
}) => {
  await signUp(page, "owner");
  await page.goto("/");
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(page).toHaveURL(/\/chat\/[A-Za-z0-9_-]+$/);
  const foreignId = await conversationIdFromUrl(page);

  const other = await browser.newContext();
  const otherPage = await other.newPage();
  try {
    await signUp(otherPage, "intruder");

    const read = await otherPage.context().request.get(`/api/conversations/${foreignId}`);
    expect(read.status()).toBe(404);
    const removed = await otherPage.context().request.delete(`/api/conversations/${foreignId}`);
    expect(removed.status()).toBe(404);

    // The page reveals nothing about the other account's conversation.
    await otherPage.goto(`/chat/${foreignId}`);
    await expect(otherPage.getByRole("heading", { level: 1, name: "Not found" })).toBeVisible();
    await expect(otherPage.locator(".conversation-empty")).toHaveCount(0);

    // The owner can still open it.
    await page.goto(`/chat/${foreignId}`);
    await expect(page.getByRole("heading", { level: 1, name: "New chat" })).toBeVisible();
  } finally {
    await other.close();
  }
});
