import { expect, test, type Page } from "@playwright/test";
import {
  DATABASE_SKIP_REASON,
  conversationIdFromUrl,
  databaseUrl,
  removeTestAccounts,
  signUp,
} from "./support";

/**
 * Browser coverage for *streaming* assistant replies. The production server under
 * test is pointed at the deterministic OpenRouter-compatible stub
 * (tests/e2e/mock-openrouter.mjs), which emits several small deltas per answer, so
 * no real provider call or API key is involved and the incremental rendering can
 * be observed directly.
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

function conversationMessages(page: Page) {
  return page.locator(".conversation-messages");
}

function userMessages(page: Page) {
  return conversationMessages(page).getByRole("article", { name: "User message" });
}

function assistantMessages(page: Page) {
  return conversationMessages(page).getByRole("article", { name: "Assistant message" });
}

/**
 * Only the replies that are actually stored. The provisional streaming bubble
 * carries the same accessible name, so completion is never asserted against it.
 */
function storedAssistantMessages(page: Page) {
  return conversationMessages(page).locator(
    'article[aria-label="Assistant message"]:not([data-stream-state="streaming"])',
  );
}

/** The provisional bubble that is rendered from provider deltas. */
function streamingBubble(page: Page) {
  return conversationMessages(page).locator('article[data-stream-state="streaming"]');
}

/** The reply status region; Next.js renders its own alert for route changes. */
function replyNotice(page: Page) {
  return page.locator(".reply-notice");
}

async function storedMessages(page: Page, conversationId: string) {
  const response = await page.context().request.get(
    `/api/conversations/${conversationId}/messages`,
  );
  expect(response.status()).toBe(200);
  return (await response.json()) as {
    messages: { id: string; role: string; content: string; position: number }[];
  };
}

test("assistant text is rendered from real deltas and reconciled with the stored reply", async ({
  page,
}) => {
  await signUp(page, "stream");
  const conversationId = await openNewConversation(page);

  // Record every provisional render the browser makes while the answer streams, so
  // the test proves incremental delivery from what was actually displayed instead
  // of racing the stream with assertions.
  await page.evaluate(() => {
    const holder = window as unknown as {
      __streamSnapshots?: { text: string; chunks: number }[];
    };
    holder.__streamSnapshots = [];
    const record = () => {
      const article = document.querySelector('article[data-stream-state="streaming"]');
      const content = article?.querySelector(".message-content");
      if (!article || !content) return;
      holder.__streamSnapshots?.push({
        text: content.textContent ?? "",
        chunks: Number(article.getAttribute("data-chunks") ?? "0"),
      });
    };
    new MutationObserver(record).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    record();
  });

  // The stub pauses after its first delta for this text, so the stream is
  // observably in progress while the reply is still being produced.
  await send(page, "[slow] Explain streaming");

  // While it is streaming: a marked, provisional assistant bubble plus the honest
  // status line, and no second submission. The stub holds the answer open long
  // enough for these states to be observed rather than raced.
  await expect(streamingBubble(page)).toBeVisible();
  await expect(page.getByText("Generating a reply…")).toBeVisible();
  await expect(conversationMessages(page).locator(".message-streaming h2 span")).toHaveText(
    "Streaming",
  );
  // The composer reports the busy state and refuses a second submission: while a
  // reply is streaming the send button is the disabled "Sending message" one.
  await expect(page.getByRole("button", { name: "Sending message" })).toBeDisabled();

  const complete = "Mock reply: [slow] Explain streaming";
  // The remaining deltas arrive and the stored row replaces the provisional bubble.
  // The paused stub needs longer than the default assertion budget for this step.
  await expect(storedAssistantMessages(page)).toHaveCount(1, { timeout: 15_000 });
  await expect(storedAssistantMessages(page).first()).toContainText(complete);
  await expect(streamingBubble(page)).toHaveCount(0);
  await expect(replyNotice(page)).toHaveCount(0);
  // The composer is back to its idle state (empty draft, so still not submittable).
  await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();

  // What the browser rendered: several successive deltas, each one a strict prefix
  // of the final answer, starting short and growing to exactly the stored text.
  const snapshots = await page.evaluate(() => {
    const holder = window as unknown as {
      __streamSnapshots?: { text: string; chunks: number }[];
    };
    return holder.__streamSnapshots ?? [];
  });
  expect(snapshots.length).toBeGreaterThanOrEqual(3);
  expect(Math.max(...snapshots.map((snapshot) => snapshot.chunks))).toBeGreaterThanOrEqual(3);
  for (const snapshot of snapshots) expect(complete.startsWith(snapshot.text)).toBe(true);
  expect(snapshots[0].text.length).toBeGreaterThan(0);
  expect(snapshots[0].text).not.toBe(complete);
  expect(snapshots.at(-1)?.text).toBe(complete);
  for (let index = 1; index < snapshots.length; index += 1)
    expect(snapshots[index].text.length).toBeGreaterThanOrEqual(snapshots[index - 1].text.length);

  // The stored row is the complete answer, with a server-assigned role/position.
  const { messages } = await storedMessages(page, conversationId);
  expect(messages.map(({ role, content, position }) => ({ role, content, position }))).toEqual([
    { role: "USER", content: "[slow] Explain streaming", position: 0 },
    { role: "ASSISTANT", content: complete, position: 1 },
  ]);

  // A reload shows the same exchange from the database, with no provisional state.
  await page.reload();
  await expect(storedAssistantMessages(page)).toHaveCount(1);
  await expect(conversationMessages(page).locator(".message-streaming")).toHaveCount(0);
});

test("a stream that dies mid-answer leaves no partial reply behind", async ({ page }) => {
  await signUp(page, "streamfail");
  const conversationId = await openNewConversation(page);

  // The stub sends two deltas and then drops the connection, once per text.
  await send(page, "[streamfail] cut this off");

  // The provisional text is shown while it arrives, then removed.
  await expect(replyNotice(page)).toHaveClass(/is-error/);
  await expect(streamingBubble(page)).toHaveCount(0);
  await expect(assistantMessages(page)).toHaveCount(0);
  await expect(replyNotice(page)).toContainText("could not be generated");
  await expect(replyNotice(page).getByRole("button", { name: "Try again" })).toBeVisible();
  // The user's own message survived the failure.
  await expect(userMessages(page)).toHaveCount(1);

  const failed = await storedMessages(page, conversationId);
  expect(failed.messages.map((message) => message.role)).toEqual(["USER"]);

  // Retrying streams the same turn again and stores one reply.
  await replyNotice(page).getByRole("button", { name: "Try again" }).click();
  await expect(storedAssistantMessages(page)).toHaveCount(1);
  await expect(storedAssistantMessages(page).first()).toContainText(
    "Mock reply: [streamfail] cut this off",
  );
  await expect(replyNotice(page)).toHaveCount(0);

  const retried = await storedMessages(page, conversationId);
  expect(retried.messages.map((message) => message.role)).toEqual(["USER", "ASSISTANT"]);
});

test("an empty stream is refused instead of storing a blank reply", async ({ page }) => {
  await signUp(page, "streamempty");
  const conversationId = await openNewConversation(page);

  await send(page, "[empty] say nothing");

  await expect(replyNotice(page)).toHaveClass(/is-error/);
  await expect(assistantMessages(page)).toHaveCount(0);
  await expect(streamingBubble(page)).toHaveCount(0);

  const stored = await storedMessages(page, conversationId);
  expect(stored.messages.map((message) => message.role)).toEqual(["USER"]);
});

test("a refused key is replaced by another configured key", async ({ page }) => {
  await signUp(page, "streamkeys");
  const conversationId = await openNewConversation(page);

  // The stub refuses the first attempt for this text with 429 whatever key it used
  // — the way a rate-limited or revoked key behaves — and answers the retry.
  await send(page, "[rotate] answer with the second key");

  await expect(storedAssistantMessages(page)).toHaveCount(1, { timeout: 15_000 });
  await expect(storedAssistantMessages(page).first()).toContainText("(fallback key)");
  await expect(replyNotice(page)).toHaveCount(0);

  // What the provider saw: one attempt was refused, and the key that answered it is
  // a different configured key. Which key the rotation happened to start with
  // depends on earlier requests in the same server process, so the assertion is that
  // the two differ — never that a specific key was used. The browser itself never
  // receives either value, only the reply text.
  const observed = (await (
    await page.context().request.get("http://127.0.0.1:3210/rotation")
  ).json()) as { rejected: string | null; accepted: string | null };
  expect(observed.rejected).not.toBeNull();
  expect(observed.accepted).not.toBeNull();
  expect(observed.accepted).not.toBe(observed.rejected);

  // The reply is a normal, stored assistant turn: one user message, one answer.
  const stored = await storedMessages(page, conversationId);
  expect(stored.messages.map((message) => message.role)).toEqual(["USER", "ASSISTANT"]);
  expect(stored.messages[1].content).toContain("(fallback key)");
});

test("several streamed turns keep the user, assistant, user, assistant order", async ({ page }) => {
  await signUp(page, "streamturns");
  const conversationId = await openNewConversation(page);

  await send(page, "First streamed question");
  await expect(storedAssistantMessages(page)).toHaveCount(1);
  await send(page, "Second streamed question");
  await expect(storedAssistantMessages(page)).toHaveCount(2);

  await page.reload();
  const messages = conversationMessages(page).locator("article");
  await expect(messages).toHaveCount(4);
  expect(
    await messages.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label"))),
  ).toEqual(["User message", "Assistant message", "User message", "Assistant message"]);

  const { messages: stored } = await storedMessages(page, conversationId);
  expect(stored.map((message) => message.position)).toEqual([0, 1, 2, 3]);
});

test("a reply stream cannot be started for another account's conversation", async ({
  page,
  browser,
}) => {
  await signUp(page, "stream-owner");
  const conversationId = await openNewConversation(page);
  await send(page, "Owner question");
  await expect(storedAssistantMessages(page)).toHaveCount(1);

  const other = await browser.newContext();
  const otherPage = await other.newPage();
  try {
    await signUp(otherPage, "stream-intruder");

    const foreign = await otherPage.context().request.post(
      `/api/conversations/${conversationId}/reply`,
      { headers: { accept: "text/event-stream" }, data: {} },
    );
    const unknown = await otherPage.context().request.post(
      "/api/conversations/cmunknownconversationid00/reply",
      { headers: { accept: "text/event-stream" }, data: {} },
    );

    // A foreign conversation streams nothing and answers exactly like an unknown id.
    expect(foreign.status()).toBe(404);
    expect(foreign.headers()["content-type"]).toContain("application/json");
    expect(await foreign.json()).toEqual(await unknown.json());
  } finally {
    await other.close();
  }

  // The owner's conversation is unchanged: one message and one reply.
  await page.reload();
  await expect(conversationMessages(page).locator("article")).toHaveCount(2);
});

test("a signed-out visitor cannot start or read a reply stream", async ({ page }) => {
  await signUp(page, "stream-signout");
  const conversationId = await openNewConversation(page);

  await page.context().clearCookies();
  const response = await page.context().request.post(
    `/api/conversations/${conversationId}/reply`,
    { headers: { accept: "text/event-stream" }, data: {} },
  );

  expect(response.status()).toBe(401);
  expect(response.headers()["content-type"]).toContain("application/json");
  expect(await response.json()).toEqual({
    error: { code: "UNAUTHENTICATED", message: "Sign in to continue." },
  });

  await page.goto(`/chat/${conversationId}`);
  await expect(page).toHaveURL(/\/login$/);
});

test("the chat companion reacts to the real stream phases and settles again", async ({ page }) => {
  await signUp(page, "petstream");
  await openNewConversation(page);

  const companion = page.locator(".chat-companion");
  // The companion is part of an open conversation, and it starts at rest.
  await expect(companion).toBeVisible();
  await expect(companion).toHaveAttribute("data-state", "idle");

  // Record every state the companion actually shows, so the sequence is read back
  // from what the browser rendered instead of being raced against the stream.
  await page.evaluate(() => {
    const holder = window as unknown as { __petStates?: string[] };
    holder.__petStates = [];
    const record = () => {
      const state = document.querySelector(".chat-companion")?.getAttribute("data-state");
      const previous = holder.__petStates?.[(holder.__petStates?.length ?? 1) - 1];
      if (state && state !== previous) holder.__petStates?.push(state);
    };
    new MutationObserver(record).observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ["data-state"],
    });
    record();
  });

  // The stub pauses after its first delta for this text, so generation is observably
  // in progress rather than over before an assertion can look at it.
  await send(page, "[slow] Explain streaming");

  await expect(companion).toHaveAttribute("data-state", "thinking");
  await expect(page.getByText("Generating a reply…")).toBeVisible();

  await expect(storedAssistantMessages(page)).toHaveCount(1, { timeout: 15_000 });

  // A completed reply is a positive reaction for the default calm companion, and it
  // settles back on its own: nothing about it is persisted or announced.
  await expect(companion).toHaveAttribute("data-state", "happy");
  await expect(companion).toHaveAttribute("data-state", "idle", { timeout: 10_000 });

  const states = await page.evaluate(() => {
    const holder = window as unknown as { __petStates?: string[] };
    return holder.__petStates ?? [];
  });
  expect(states).toContain("thinking");
  expect(states).toContain("happy");
  expect(states[states.length - 1]).toBe("idle");
});
