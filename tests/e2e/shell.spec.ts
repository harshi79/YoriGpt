import { expect, test } from "@playwright/test";

for (const width of [320, 375, 768, 1024, 1440]) {
  test(`shell fits a ${width}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(
      page.getByRole("heading", {
        name: "Where will your curiosity take you?",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Message YoriGPT" }),
    ).toBeVisible();
    const dimensions = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
      height: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
    }));
    expect(dimensions.width).toBeLessThanOrEqual(dimensions.viewport);
    expect(dimensions.height).toBeLessThanOrEqual(dimensions.viewportHeight);
    const composer = await page
      .getByRole("form", { name: "Message composer" })
      .boundingBox();
    expect(composer!.y + composer!.height).toBeLessThanOrEqual(900);
    if (width < 768) {
      await expect(
        page.getByRole("button", { name: "Open sidebar" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "New chat", exact: true }),
      ).toBeHidden();
    } else {
      await expect(
        page.getByRole("button", { name: "Collapse sidebar" }),
      ).toBeVisible();
    }
  });
}

test("local UI interactions do not send messages or perform backend requests", async ({
  page,
}) => {
  const errors: string[] = [];
  const requests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.method() !== "GET") requests.push(request.url());
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore an idea — add a draft" })
    .click();
  const draft = page.getByRole("textbox", { name: "Message YoriGPT" });
  await expect(draft).toBeFocused();
  await expect(draft).toHaveValue(/explore a new idea/);
  await expect(
    page.getByRole("button", { name: "Sending unavailable in this preview" }),
  ).toBeDisabled();
  // Signed out the real catalog is listed, with the default shown and no request
  // made for it — asserted by the empty request list below.
  const model = page.getByRole("combobox", { name: "Reply model" });
  await expect(model).toHaveValue("gpt-4o-mini");
  await expect(model.locator("option").first()).toHaveText("GPT-4o mini");
  await page
    .getByRole("button", {
      name: "A little inspiration Static conversation preview",
    })
    .click();
  await expect(
    page.getByRole("article", { name: "Assistant message" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Static examples of message styling. Not a live conversation.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(
    page.getByRole("button", { name: "Expand sidebar" }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(
    page.getByRole("button", { name: "Collapse sidebar" }),
  ).toBeFocused();
  await page
    .getByRole("searchbox", { name: "Search conversations" })
    .fill("not a match");
  await expect(page.getByText("No examples found.")).toBeVisible();
  await page.reload();
  await expect(draft).toHaveValue("");
  // The catalog default is re-rendered by the server; nothing was stored.
  await expect(page.getByRole("combobox", { name: "Reply model" })).toHaveValue("gpt-4o-mini");
  expect(errors).toEqual([]);
  expect(requests).toEqual([]);
});

test("signed-out visitors are sent to sign in instead of creating a conversation", async ({
  page,
}) => {
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method()))
      mutations.push(`${request.method()} ${request.url()}`);
  });

  await page.goto("/");
  // Both the desktop sidebar and the (closed) mobile dialog render this note, so
  // the assertion is scoped to the visible copy.
  await expect(
    page.locator(".desktop-sidebar").getByText("Sign in to keep your conversations."),
  ).toBeVisible();
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  expect(mutations).toEqual([]);
});

test("a conversation URL requires signing in and reveals nothing to visitors", async ({
  page,
}) => {
  await page.goto("/chat/cmunknownconversationid00");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByText(/Conversation not found/i)).toHaveCount(0);
});

test("mobile dialog contains focus, closes on Escape, and adapts to desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Open sidebar" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Chat navigation" });
  await expect(dialog).toBeVisible();
  for (let index = 0; index < 8; index++) {
    await page.keyboard.press("Tab");
    expect(
      await dialog.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    ).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await dialog
    .getByRole("button", {
      name: "A little inspiration Static conversation preview",
    })
    .click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "A little inspiration" }),
  ).toBeVisible();
  await trigger.click();
  await page.setViewportSize({ width: 1024, height: 900 });
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("combobox", { name: "Reply model" })).toBeFocused();
});

test("a long draft stays usable in a narrow, short viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 540 });
  await page.goto("/");
  const draft = page.getByRole("textbox", { name: "Message YoriGPT" });
  await draft.fill("A long local draft.\n".repeat(30));
  const inputBounds = await draft.boundingBox();
  expect(inputBounds!.height).toBeLessThanOrEqual(160);
  await expect(
    page.getByRole("button", { name: "Sending unavailable in this preview" }),
  ).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
