import { expect, test, type Page } from "@playwright/test";
import {
  DATABASE_SKIP_REASON,
  clearRequestedModels,
  conversationIdFromUrl,
  databaseUrl,
  removeTestAccounts,
  requestedModels,
  signUp,
} from "./support";

/**
 * Browser coverage for the model selector and for the model a reply actually uses.
 * The server under test is pointed at the deterministic OpenRouter-compatible stub,
 * which records the model identifier of every request it receives — so "the selected
 * model reached the provider" is asserted against the wire, not against the UI.
 */
test.skip(!databaseUrl, DATABASE_SKIP_REASON);

test.afterAll(removeTestAccounts);

/** The catalog as the server owns it: display names the selector must offer. */
const ACTIVE_NAMES = [
  "GPT-4o mini",
  "GPT-4o",
  "Claude 3.5 Haiku",
  "Claude 3.7 Sonnet",
  "Llama 3.3 70B",
];
const RETIRED_NAME = "Llama 3.1 70B";

function selector(page: Page) {
  return page.getByRole("combobox", { name: "Reply model" });
}

/** The header's model control — the only one the shell renders. */
function selectorOptions(page: Page) {
  return page.locator(".chat-header").getByRole("combobox", { name: "Reply model" });
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

/** The single stored reply that quotes `text`, proving this turn was answered. */
function storedReplyTo(page: Page, text: string) {
  return storedReplies(page).filter({ hasText: text });
}

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

const ORIGIN = "http://127.0.0.1:3100";

test("the selector lists the server's catalog, and hides retired models", async ({ page }) => {
  // Signed out: the catalog is real data from the server, showing the default.
  await page.goto("/");
  const anonymous = selectorOptions(page);
  await expect(anonymous).toBeVisible();
  await expect(anonymous.locator("option")).toHaveText(ACTIVE_NAMES);
  await expect(anonymous).toHaveValue("gpt-4o-mini");
  await expect(page.getByText("Sign in to choose a model")).toBeVisible();

  // And the API itself refuses an anonymous visitor, read or write.
  expect((await page.context().request.get("/api/models")).status()).toBe(401);
  const anonymousWrite = await page.context().request.fetch("/api/models", {
    method: "PUT",
    data: { modelKey: "gpt-4o" },
    headers: { origin: ORIGIN },
  });
  expect(anonymousWrite.status()).toBe(401);

  // The same catalog, with the stored selection, for a signed-in user.
  await signUp(page, "models-list");
  await page.goto("/");
  await expect(selectorOptions(page)).toBeEnabled();
  await expect(selectorOptions(page).locator("option")).toHaveText(ACTIVE_NAMES);
  await expect(selectorOptions(page)).toHaveValue("gpt-4o-mini");
  expect(ACTIVE_NAMES).not.toContain(RETIRED_NAME);

  // The API agrees with the UI, and never exposes a provider identifier.
  const response = await page.context().request.get("/api/models");
  expect(response.status()).toBe(200);
  const body = (await response.json()) as {
    models: { key: string; name: string }[];
    selectedModelKey: string;
  };
  expect(body.selectedModelKey).toBe("gpt-4o-mini");
  expect(body.models.map((model) => model.name)).toEqual(ACTIVE_NAMES);
  expect(body.models.map((model) => model.key)).toContain("nvidia-llama-3.3-70b");
  expect(body.models.map((model) => model.key)).not.toContain("llama-3.1-70b");
  // Only catalog keys cross this boundary, never provider identifiers.
  expect(JSON.stringify(body)).not.toMatch(/openai\/|anthropic\/|meta\//);
});

test("a signed-out choice sends the visitor to sign in and stores nothing", async ({ page }) => {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method()))
      writes.push(`${request.method()} ${request.url()}`);
  });

  await page.goto("/");
  await selectorOptions(page).selectOption("gpt-4o");

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  // No preference was written for anyone, and none was even attempted.
  expect(writes).toEqual([]);
});

test("a chosen model is stored, survives a reload, and outlives the conversation", async ({
  page,
}) => {
  await signUp(page, "models-persist");
  await openNewConversation(page);

  await selectorOptions(page).selectOption("claude-3.7-sonnet");
  await expect(selectorOptions(page)).toHaveValue("claude-3.7-sonnet");
  await expect(page.getByText("Used for new replies")).toBeVisible();

  // Stored server-side, not just remembered in the tab.
  const stored = await page.context().request.get("/api/models");
  expect(((await stored.json()) as { selectedModelKey: string }).selectedModelKey).toBe(
    "claude-3.7-sonnet",
  );

  await page.reload();
  await expect(selectorOptions(page)).toHaveValue("claude-3.7-sonnet");

  // A different conversation still shows, and uses, the same choice.
  await openNewConversation(page);
  await expect(selectorOptions(page)).toHaveValue("claude-3.7-sonnet");
});

test("the selected model is the one the provider is asked for", async ({ page }) => {
  await signUp(page, "models-used");
  await openNewConversation(page);
  await clearRequestedModels(page);

  // The documented default, with no preference stored.
  await send(page, "Which model answers this?");
  await expect(storedReplies(page)).toHaveCount(1, { timeout: 30_000 });
  await expect(storedReplyTo(page, "Mock reply: Which model answers this?")).toHaveCount(1);
  expect(await requestedModels(page)).toEqual(["openai/gpt-4o-mini"]);

  // A different model, chosen in the header, on the next turn.
  await clearRequestedModels(page);
  await selectorOptions(page).selectOption("gpt-4o");
  await send(page, "And now?");
  await expect(storedReplies(page)).toHaveCount(2, { timeout: 30_000 });
  await expect(storedReplyTo(page, "Mock reply: And now?")).toHaveCount(1);
  // Only the identifier the server resolved — never the bare catalog key.
  expect(await requestedModels(page)).toEqual(["openai/gpt-4o"]);

  // History is untouched: both turns remain, and no stored row records a model.
  const conversationId = await conversationIdFromUrl(page);
  let stored = { messages: [] as { role: string; content: string }[] };
  await expect
    .poll(async () => {
      const response = await page.context().request.get(
        `/api/conversations/${conversationId}/messages`,
      );
      stored = (await response.json()) as typeof stored;
      return stored.messages.map((message) => message.role);
    })
    .toEqual(["USER", "ASSISTANT", "USER", "ASSISTANT"]);
  expect(JSON.stringify(stored)).not.toContain("gpt-4o");

  // Switching back is reflected in the next request too.
  await clearRequestedModels(page);
  await selectorOptions(page).selectOption("claude-3.5-haiku");
  await send(page, "One more?");
  await expect(storedReplies(page)).toHaveCount(3, { timeout: 30_000 });
  expect(await requestedModels(page)).toEqual(["anthropic/claude-3.5-haiku"]);
});

test("a streaming reply uses the selected model, with rotation unchanged", async ({ page }) => {
  await signUp(page, "models-stream");
  await openNewConversation(page);

  await selectorOptions(page).selectOption("claude-3.5-haiku");
  await expect(selectorOptions(page)).toHaveValue("claude-3.5-haiku");
  await clearRequestedModels(page);

  await send(page, "[rotate] Stream me an answer");
  await expect(storedReplies(page)).toHaveCount(1, { timeout: 30_000 });

  // The answer came from the fallback key (the first key was refused), and every
  // attempt — whichever key carried it — asked for the selected model.
  const rotation = await page.context().request.get("http://127.0.0.1:3210/rotation");
  const labels = (await rotation.json()) as { rejected: string | null; accepted: string | null };
  expect(labels.rejected).not.toBeNull();
  expect(labels.accepted).not.toBeNull();
  expect(labels.accepted).not.toBe(labels.rejected);
  expect(await requestedModels(page)).toEqual([
    "anthropic/claude-3.5-haiku",
    "anthropic/claude-3.5-haiku",
  ]);
});

test("one user's model choice never affects another user's", async ({ browser, page }) => {
  const first = await signUp(page, "models-owner-a");
  await openNewConversation(page);
  await selectorOptions(page).selectOption("claude-3.7-sonnet");
  await expect(selectorOptions(page)).toHaveValue("claude-3.7-sonnet");

  // A second, independent browser context: another account, its own cookies.
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  try {
    const second = await signUp(other, "models-owner-b");
    expect(second).not.toBe(first);
    await other.goto("/");
    await expect(selectorOptions(other)).toHaveValue("gpt-4o-mini");

    await selectorOptions(other).selectOption("gpt-4o");
    await expect(selectorOptions(other)).toHaveValue("gpt-4o");

    // Neither account sees the other's choice.
    const firstStored = await page.context().request.get("/api/models");
    expect(((await firstStored.json()) as { selectedModelKey: string }).selectedModelKey).toBe(
      "claude-3.7-sonnet",
    );
    const secondStored = await other.context().request.get("/api/models");
    expect(((await secondStored.json()) as { selectedModelKey: string }).selectedModelKey).toBe(
      "gpt-4o",
    );

    // And each one's next reply is generated with its own model.
    await openNewConversation(other);
    await clearRequestedModels(other);
    await send(other, "Whose model is this?");
    await expect(storedReplies(other)).toHaveCount(1, { timeout: 30_000 });
    expect(await requestedModels(other)).toEqual(["openai/gpt-4o"]);
  } finally {
    await otherContext.close();
  }
});

test("a browser cannot install a model the server does not offer", async ({ page }) => {
  await signUp(page, "models-reject");
  await page.goto("/");

  const origin = ORIGIN;
  for (const modelKey of [
    "openai/gpt-4o", // a raw provider identifier
    "llama-3.1-70b", // a real row, retired
    "not-a-model",
  ]) {
    const response = await page.context().request.fetch("/api/models", {
      method: "PUT",
      data: { modelKey },
      headers: { origin },
    });
    expect(response.status(), modelKey).toBe(400);
    expect(JSON.stringify(await response.json())).not.toContain(modelKey.split("/")[0]);
  }

  // Unexpected fields are refused too, so nothing extra can ride along.
  const extra = await page.context().request.fetch("/api/models", {
    method: "PUT",
    data: { modelKey: "gpt-4o", modelIdentifier: "openai/gpt-4o" },
    headers: { origin },
  });
  expect(extra.status()).toBe(400);

  // Nothing was stored, and the UI still shows the catalog default.
  const stored = await page.context().request.get("/api/models");
  expect(((await stored.json()) as { selectedModelKey: string }).selectedModelKey).toBe(
    "gpt-4o-mini",
  );
  await expect(selectorOptions(page)).toHaveValue("gpt-4o-mini");
  await expect(selector(page)).toBeVisible();
});
