import { expect, test, type Page } from "@playwright/test";
import {
  DATABASE_SKIP_REASON,
  conversationIdFromUrl,
  databaseUrl,
  removeTestAccounts,
  signUp,
} from "./support";

/**
 * Browser coverage for the settings page and the persistent theme preference.
 *
 * The palette is asserted from the document itself — the preference attribute, the
 * palette the inline script resolved, and the background colour actually painted —
 * so "the choice is applied" is checked against the rendered page, not against the
 * control's value alone. Everything runs against the local server and the local
 * OpenRouter stub; no external service is contacted.
 */
test.skip(!databaseUrl, DATABASE_SKIP_REASON);

test.afterAll(removeTestAccounts);

const ORIGIN = "http://127.0.0.1:3100";
const THEME_LABELS = ["System", "Dark", "Light"];
/** The two palette backgrounds from src/app/globals.css. */
const DARK_BACKGROUND = "rgb(23, 25, 25)";
const LIGHT_BACKGROUND = "rgb(245, 246, 244)";

function themeSelect(page: Page) {
  return page.getByRole("combobox", { name: "Theme preference" });
}

/** What the document says about the theme, and the colour it is painted with. */
function themeState(page: Page) {
  return page.evaluate(() => ({
    preference: document.documentElement.getAttribute("data-theme"),
    scheme: document.documentElement.getAttribute("data-color-scheme"),
    background: getComputedStyle(document.body).backgroundColor,
  }));
}

async function storedTheme(page: Page): Promise<string> {
  const response = await page.context().request.get("/api/settings");
  expect(response.status()).toBe(200);
  return ((await response.json()) as { theme: string }).theme;
}

/** Saves a theme through the page, and waits for the server to confirm it. */
async function chooseTheme(page: Page, theme: "system" | "dark" | "light") {
  await themeSelect(page).selectOption(theme);
  await expect(page).toHaveURL(/\/settings$/);
  await expect.poll(() => storedTheme(page)).toBe(theme);
}

/**
 * Changes the emulated device preference and waits for the page to see it. The
 * new value reaches `matchMedia` before the queued media-query change event runs,
 * so the palette is only asserted once both the value and the event have been
 * processed — otherwise a correct implementation can look late.
 */
async function devicePrefers(page: Page, light: boolean) {
  await page.emulateMedia({ colorScheme: light ? "light" : "dark" });
  await expect
    .poll(() => page.evaluate(() => window.matchMedia("(prefers-color-scheme: light)").matches))
    .toBe(light);
  await page.evaluate(
    () => new Promise<void>((resolve) => setTimeout(() => requestAnimationFrame(() => resolve()), 0)),
  );
}

async function openNewConversation(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(page).toHaveURL(/\/chat\/[A-Za-z0-9_-]+$/);
  return conversationIdFromUrl(page);
}

test("a signed-in user can open /settings and see the stored theme", async ({ page }) => {
  const email = await signUp(page, "settings-open");

  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();

  // The current theme is displayed, with every choice offered.
  await expect(themeSelect(page)).toBeVisible();
  await expect(themeSelect(page).locator("option")).toHaveText(THEME_LABELS);
  await expect(themeSelect(page)).toHaveValue("system");
  await expect(page.getByText("Follow this device’s appearance")).toBeVisible();

  // Read-only account details.
  await expect(page.getByText("E2E settings-open")).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();
  await expect(page.getByText("Not verified")).toBeVisible();

  // Nothing sensitive is in the document or in the API's answer.
  await expect(page.getByRole("link", { name: "Back to chat" })).toHaveAttribute("href", "/");
  const body = (await (await page.context().request.get("/api/settings")).json()) as {
    theme: string;
    account: { email: string; emailVerified: boolean };
  };
  expect(body.theme).toBe("system");
  expect(body.account.email).toBe(email);
  expect(body.account.emailVerified).toBe(false);
  const serialized = JSON.stringify(body);
  expect(serialized).not.toContain("password");
  expect(serialized).not.toContain("session_token");
  expect(serialized).not.toContain("preferredModelId");
});

test("choosing a theme applies it, stores it, and survives a reload", async ({ page }) => {
  await signUp(page, "settings-persist");
  await page.goto("/settings");

  // The documented default on a dark-preferring device.
  expect(await themeState(page)).toEqual({
    preference: "system",
    scheme: "dark",
    background: DARK_BACKGROUND,
  });

  await chooseTheme(page, "light");
  expect(await themeState(page)).toEqual({
    preference: "light",
    scheme: "light",
    background: LIGHT_BACKGROUND,
  });

  // A reload re-reads the stored preference from the server.
  await page.reload();
  await expect(themeSelect(page)).toHaveValue("light");
  expect(await themeState(page)).toEqual({
    preference: "light",
    scheme: "light",
    background: LIGHT_BACKGROUND,
  });

  // …and it applies on every page, including one reached by navigation.
  await page.getByRole("link", { name: "Back to chat" }).click();
  await expect(page).toHaveURL(/\/$/);
  expect((await themeState(page)).background).toBe(LIGHT_BACKGROUND);

  await page.goto("/settings");
  await expect(themeSelect(page)).toHaveValue("light");
  expect((await themeState(page)).background).toBe(LIGHT_BACKGROUND);
});

test("dark, light, and system each paint their palette", async ({ page }) => {
  await signUp(page, "settings-palettes");
  await page.goto("/settings");

  await chooseTheme(page, "dark");
  expect(await themeState(page)).toEqual({
    preference: "dark",
    scheme: "dark",
    background: DARK_BACKGROUND,
  });

  // An explicit choice ignores the device.
  await devicePrefers(page, true);
  expect(await themeState(page)).toEqual({
    preference: "dark",
    scheme: "dark",
    background: DARK_BACKGROUND,
  });
  await devicePrefers(page, false);

  await chooseTheme(page, "light");
  expect((await themeState(page)).background).toBe(LIGHT_BACKGROUND);
  await devicePrefers(page, true);
  expect(await themeState(page)).toEqual({
    preference: "light",
    scheme: "light",
    background: LIGHT_BACKGROUND,
  });
  await devicePrefers(page, false);

  // System follows the device, live, without a reload.
  await chooseTheme(page, "system");
  expect(await themeState(page)).toEqual({
    preference: "system",
    scheme: "dark",
    background: DARK_BACKGROUND,
  });
  await devicePrefers(page, true);
  expect(await themeState(page)).toEqual({
    preference: "system",
    scheme: "light",
    background: LIGHT_BACKGROUND,
  });
  await devicePrefers(page, false);
  expect(await themeState(page)).toEqual({
    preference: "system",
    scheme: "dark",
    background: DARK_BACKGROUND,
  });
});

test("each account keeps its own theme preference", async ({ browser, page }) => {
  await signUp(page, "settings-owner-a");
  await page.goto("/settings");
  await chooseTheme(page, "dark");

  // A second, independent browser context: another account, its own cookies.
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  try {
    await signUp(other, "settings-owner-b");
    await other.goto("/settings");

    // The second account starts on the documented default, not on Alice's choice.
    await expect(themeSelect(other)).toHaveValue("system");
    expect((await themeState(other)).background).toBe(DARK_BACKGROUND);

    await chooseTheme(other, "light");
    expect((await themeState(other)).background).toBe(LIGHT_BACKGROUND);

    // Neither account sees the other's choice.
    expect(await storedTheme(page)).toBe("dark");
    expect(await storedTheme(other)).toBe("light");
    expect((await themeState(page)).background).toBe(DARK_BACKGROUND);
  } finally {
    await otherContext.close();
  }
});

test("signed-out access follows the existing authentication behavior", async ({ page }) => {
  await page.goto("/settings");

  // The same redirect the conversation routes use: no settings data is rendered.
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Theme preference" })).toHaveCount(0);

  // And the API refuses an anonymous visitor, read or write.
  expect((await page.context().request.get("/api/settings")).status()).toBe(401);
  const write = await page.context().request.fetch("/api/settings", {
    method: "PUT",
    data: { theme: "dark" },
    headers: { origin: ORIGIN },
  });
  expect(write.status()).toBe(401);

  // The signed-out shell offers no settings link.
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Settings" })).toHaveCount(0);
});

test("the settings API refuses an untrusted origin, and every invalid body", async ({ page }) => {
  await signUp(page, "settings-reject");
  await page.goto("/settings");
  await chooseTheme(page, "dark");

  const send = (data: string, headers: Record<string, string> = {}) =>
    page.context().request.fetch("/api/settings", {
      method: "PUT",
      data,
      headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
    });

  expect((await send(JSON.stringify({ theme: "dark" }), { origin: "https://evil.example" })).status()).toBe(403);

  for (const [label, body] of [
    ["unknown theme", JSON.stringify({ theme: "solarized" })],
    ["stored enum spelling", JSON.stringify({ theme: "DARK" })],
    ["missing theme", "{}"],
    ["malformed JSON", "{not json"],
    ["an array", "[]"],
    ["a supplied user id", JSON.stringify({ theme: "light", userId: "cmuser00000000000000002" })],
    ["an unexpected field", JSON.stringify({ theme: "light", pet: "cat" })],
    ["an oversized body", JSON.stringify({ theme: `dark${"x".repeat(5000)}` })],
  ] as [string, string][]) {
    const response = await send(body);
    expect(response.status(), label).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code, label).toBe(
      "INVALID_REQUEST",
    );
  }

  // Not JSON at all is refused before the body is parsed.
  const notJson = await send("{}", { "content-type": "text/plain" });
  expect(notJson.status()).toBe(400);

  // Nothing was stored, and the page still shows the saved theme.
  expect(await storedTheme(page)).toBe("dark");
  await expect(themeSelect(page)).toHaveValue("dark");
});

test("the chat and model features still work with a stored theme", async ({ page }) => {
  await signUp(page, "settings-chat");
  await page.goto("/settings");
  await chooseTheme(page, "light");

  // The shell renders in the chosen palette, with the catalog and its default.
  await openNewConversation(page);
  expect((await themeState(page)).background).toBe(LIGHT_BACKGROUND);
  // The sidebar keeps offering the settings page.
  await expect(page.locator(".desktop-sidebar").getByRole("link", { name: "Settings" })).toHaveAttribute(
    "href",
    "/settings",
  );
  const model = page.locator(".chat-header").getByRole("combobox", { name: "Reply model" });
  await expect(model).toHaveValue("gpt-4o-mini");

  // A model change still stores, next to the theme preference.
  await model.selectOption("claude-3.7-sonnet");
  await expect(model).toHaveValue("claude-3.7-sonnet");

  // And a message still gets a stored reply.
  await page.getByRole("textbox", { name: "Message YoriGPT" }).fill("Still working?");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(
    page
      .locator(".conversation-messages")
      .locator('article[aria-label="Assistant message"]:not([data-stream-state="streaming"])'),
  ).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByText("Mock reply: Still working?")).toBeVisible();

  // The theme is untouched by any of it, and is still there after a reload.
  expect(await storedTheme(page)).toBe("light");
  await page.reload();
  expect((await themeState(page)).background).toBe(LIGHT_BACKGROUND);
  await expect(model).toHaveValue("claude-3.7-sonnet");
});

test("the settings link is reachable from the mobile sidebar", async ({ page }) => {
  await signUp(page, "settings-mobile");
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/");

  await page.getByRole("button", { name: "Open sidebar" }).click();
  const dialog = page.locator(".mobile-sidebar-dialog");
  await expect(dialog).toBeVisible();

  await dialog.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(themeSelect(page)).toBeVisible();

  // The page stays usable at a narrow width.
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(dimensions.width).toBeLessThanOrEqual(dimensions.viewport);
});
