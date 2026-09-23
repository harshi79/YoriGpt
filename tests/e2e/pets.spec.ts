import { expect, test, type Page } from "@playwright/test";
import {
  DATABASE_SKIP_REASON,
  databaseUrl,
  removeTestAccounts,
  signUp,
} from "./support";

/**
 * Browser coverage for the pet framework's playground, `/pets`.
 *
 * The page is public and reads no user data, so the anonymous checks need no account
 * and no database. The signed-in checks drive the real persistence path (a real
 * session writing `user_preferences.selectedPetKey`) and are skipped without a
 * disposable database. Every check drives the real rendered page: the catalog it
 * offers, the renderer's `data-pet` and `data-state`, and the computed animation
 * state under reduced motion. No AI or OpenRouter call is involved.
 */

test.afterAll(removeTestAccounts);

function renderer(page: Page) {
  return page.locator(".pets-stage .pet-renderer");
}

async function storedPet(page: Page): Promise<string> {
  const response = await page.context().request.get("/api/settings/pet");
  expect(response.status()).toBe(200);
  return ((await response.json()) as { pet: string }).pet;
}

async function storedAppearance(page: Page): Promise<string> {
  const response = await page.context().request.get("/api/settings/pet/appearance");
  expect(response.status()).toBe(200);
  return ((await response.json()) as { appearance: string }).appearance;
}

async function storedPersonality(page: Page): Promise<string> {
  const response = await page.context().request.get("/api/settings/pet/personality");
  expect(response.status()).toBe(200);
  return ((await response.json()) as { personality: string }).personality;
}

test("the playground loads and lists only the available pets", async ({ page }) => {
  await page.goto("/pets");

  await expect(page.getByRole("heading", { level: 1, name: "Pet Playground" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Companions" })).toBeVisible();

  // The two available pets are offered; the unavailable placeholder is not.
  await expect(page.getByRole("button", { name: /Yori/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Ember/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Pip/ })).toHaveCount(0);

  // A labelled renderer is on the page, starting from the first available pet, idle.
  await expect(renderer(page)).toHaveAttribute("data-state", "idle");
  await expect(renderer(page)).toHaveAttribute("data-pet", "yori-cat");
  await expect(renderer(page)).toHaveAttribute("aria-label", "Yori, a cat");
});

test("selecting another pet changes the renderer", async ({ page }) => {
  await page.goto("/pets");
  await expect(renderer(page)).toHaveAttribute("data-pet", "yori-cat");

  await page.getByRole("button", { name: /Ember/ }).click();

  await expect(renderer(page)).toHaveAttribute("data-pet", "ember-fox");
  await expect(renderer(page)).toHaveAttribute("aria-label", "Ember, a fox");
  await expect(page.getByRole("button", { name: /Ember/ })).toHaveAttribute("aria-pressed", "true");
});

test("changing the state changes the rendered state and caption", async ({ page }) => {
  await page.goto("/pets");
  await expect(renderer(page)).toHaveAttribute("data-state", "idle");

  await page.getByRole("button", { name: "Thinking", exact: true }).click();
  await expect(renderer(page)).toHaveAttribute("data-state", "thinking");

  await page.getByRole("button", { name: "Sleeping", exact: true }).click();
  await expect(renderer(page)).toHaveAttribute("data-state", "sleeping");

  // The caption names the state in text, so meaning never rests on the animation.
  await expect(page.locator(".pets-caption")).toContainText("is sleeping");

  // And the pressed button exposes the selection to assistive technology.
  await expect(page.getByRole("button", { name: "Sleeping", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("keyboard users can operate the controls", async ({ page }) => {
  await page.goto("/pets");

  // Move to a control with the keyboard and activate it with Enter.
  await page.getByRole("button", { name: "Happy", exact: true }).focus();
  await page.keyboard.press("Enter");

  await expect(renderer(page)).toHaveAttribute("data-state", "happy");

  // Arrow-free: Tab to the next control in the state group and activate it.
  await page.keyboard.press("Tab"); // Thinking
  await page.keyboard.press("Enter");
  await expect(renderer(page)).toHaveAttribute("data-state", "thinking");
});

test("changing the size changes the rendered size", async ({ page }) => {
  await page.goto("/pets");
  // The playground starts at the documented default size.
  await expect(renderer(page)).toHaveClass(/pet-renderer--md/);

  await page.getByRole("button", { name: "Small", exact: true }).click();
  await expect(renderer(page)).toHaveClass(/pet-renderer--sm/);

  await page.getByRole("button", { name: "Large", exact: true }).click();
  await expect(renderer(page)).toHaveClass(/pet-renderer--lg/);
});

test("reduced motion removes the movement but keeps the pose", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/pets");

  // With motion allowed the idle pet would run the breathe keyframe; ask for the
  // computed animation so we prove what the stylesheet actually applies.
  const animateUnderReduce = await renderer(page)
    .locator(".pet-figure")
    .evaluate((node) => getComputedStyle(node).animationName);
  expect(animateUnderReduce).toBe("none");

  // A static pose is still drawn: sleeping closes the eyes even without motion.
  await page.getByRole("button", { name: "Sleeping", exact: true }).click();
  await expect(renderer(page)).toHaveAttribute("data-state", "sleeping");
  // scaleY(0.12) → matrix(1,0,0,0.12,…): the pose survives, it just does not move.
  // Polled because the style recalculation can land a tick after the attribute.
  await expect
    .poll(() =>
      renderer(page)
        .locator(".pet-eye")
        .first()
        .evaluate((node) => getComputedStyle(node).transform),
    )
    .toContain("0.12");

  // And the page still works: controls respond, the renderer still carries the state.
  await expect(renderer(page)).toHaveAttribute("data-state", "sleeping");
});

test("the chat empty state shows the companion pet", async ({ page }) => {
  await page.goto("/");
  // The renderer coexists with the welcome mark and does not disturb the shell.
  await expect(page.locator(".welcome-figure .pet-renderer")).toHaveAttribute(
    "aria-label",
    "Yori, a cat",
  );
  await expect(page.locator(".welcome-figure .pet-renderer")).toHaveAttribute(
    "data-state",
    "idle",
  );
  // The layout still fits a narrow viewport with the pet present.
  await page.setViewportSize({ width: 375, height: 800 });
  const dims = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(dims.width).toBeLessThanOrEqual(dims.viewport);
});

test("a signed-in user's pet choice is persisted and survives a reload", async ({ page }) => {
  test.skip(!databaseUrl, DATABASE_SKIP_REASON);
  await signUp(page, "pets-persist");
  await page.goto("/pets");

  // The signed-in playground says the choice is saved to the account.
  await expect(page.locator(".settings-hint")).toContainText("saved to your account");
  await expect(renderer(page)).toHaveAttribute("data-pet", "yori-cat");

  // Choosing another pet draws it immediately and stores it.
  await page.getByRole("button", { name: /Ember/ }).click();
  await expect(renderer(page)).toHaveAttribute("data-pet", "ember-fox");
  await expect.poll(() => storedPet(page)).toBe("ember-fox");

  // A reload re-reads the stored preference from the server.
  await page.reload();
  await expect(renderer(page)).toHaveAttribute("data-pet", "ember-fox");
  await expect(page.getByRole("button", { name: /Ember/ })).toHaveAttribute("aria-pressed", "true");

  // State and size remain local demo controls with a stored pet.
  await page.getByRole("button", { name: "Happy", exact: true }).click();
  await expect(renderer(page)).toHaveAttribute("data-state", "happy");
  await expect(storedPet(page)).resolves.toBe("ember-fox");
});

test("an anonymous visitor's choice stays local and never touches the database", async ({
  page,
}) => {
  await page.goto("/pets");

  // The anonymous playground offers the local-only note and never claims a save.
  await expect(page.locator(".settings-hint")).toContainText("Sign in to keep your companion");

  await page.getByRole("button", { name: /Ember/ }).click();
  await expect(renderer(page)).toHaveAttribute("data-pet", "ember-fox");

  // The API refuses an anonymous reader, so nothing was stored.
  expect((await page.context().request.get("/api/settings/pet")).status()).toBe(401);

  // A reload discards the local choice.
  await page.reload();
  await expect(renderer(page)).toHaveAttribute("data-pet", "yori-cat");
});

test("the chat companion follows the signed-in user's stored pet", async ({ page }) => {
  test.skip(!databaseUrl, DATABASE_SKIP_REASON);
  await signUp(page, "pets-companion");
  await page.goto("/pets");
  await page.getByRole("button", { name: /Ember/ }).click();
  await expect(renderer(page)).toHaveAttribute("data-pet", "ember-fox");

  // The empty-state companion in the chat reflects the stored selection.
  await page.goto("/");
  await expect(page.locator(".welcome-figure .pet-renderer")).toHaveAttribute(
    "data-pet",
    "ember-fox",
  );
  await expect(page.locator(".welcome-figure .pet-renderer")).toHaveAttribute(
    "aria-label",
    "Ember, a fox",
  );
});

test("appearance controls re-tint the pet and reset when the pet changes", async ({ page }) => {
  await page.goto("/pets");
  const appearanceGroup = page.getByRole("group", { name: "Choose an appearance" });

  // The cat starts on its default appearance, and its own options are offered.
  await expect(renderer(page)).toHaveAttribute("data-appearance", "classic");
  await expect(appearanceGroup.getByRole("button", { name: "Night" })).toBeVisible();

  // Picking an appearance re-tints the same pet and exposes the choice.
  await appearanceGroup.getByRole("button", { name: "Moss" }).click();
  await expect(renderer(page)).toHaveAttribute("data-appearance", "moss");
  await expect(appearanceGroup.getByRole("button", { name: "Moss" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // Switching to the fox drops the cat-only appearance back to the fox's default.
  await page.getByRole("button", { name: /Ember/ }).click();
  await expect(renderer(page)).toHaveAttribute("data-pet", "ember-fox");
  await expect(renderer(page)).toHaveAttribute("data-appearance", "classic");

  // Anonymous: nothing was written.
  expect((await page.context().request.get("/api/settings/pet/appearance")).status()).toBe(401);
});

test("a signed-in user's appearance is persisted and reaches the chat companion", async ({
  page,
}) => {
  test.skip(!databaseUrl, DATABASE_SKIP_REASON);
  await signUp(page, "pets-appearance");
  await page.goto("/pets");
  const appearanceGroup = page.getByRole("group", { name: "Choose an appearance" });

  await expect(renderer(page)).toHaveAttribute("data-appearance", "classic");
  await appearanceGroup.getByRole("button", { name: "Night" }).click();
  await expect(renderer(page)).toHaveAttribute("data-appearance", "night");
  await expect.poll(() => storedAppearance(page)).toBe("night");

  // A reload re-reads the stored appearance from the server.
  await page.reload();
  await expect(renderer(page)).toHaveAttribute("data-appearance", "night");
  await expect(appearanceGroup.getByRole("button", { name: "Night" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // The chat companion uses the persisted pet and appearance.
  await page.goto("/");
  await expect(page.locator(".welcome-figure .pet-renderer")).toHaveAttribute(
    "data-appearance",
    "night",
  );
});

test("personality controls change the selection and reset when the pet changes", async ({
  page,
}) => {
  await page.goto("/pets");
  const personalityGroup = page.getByRole("group", { name: "Choose a personality" });

  // The cat starts on its declared default, and its own options are offered.
  await expect(renderer(page)).toHaveAttribute("data-personality", "calm");
  await expect(personalityGroup.getByRole("button", { name: "Sleepy" })).toBeVisible();
  await expect(personalityGroup.getByRole("button", { name: "Calm" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // Picking one is exposed both in the data and in the pressed state.
  await personalityGroup.getByRole("button", { name: "Sleepy" }).click();
  await expect(renderer(page)).toHaveAttribute("data-personality", "sleepy");
  await expect(personalityGroup.getByRole("button", { name: "Sleepy" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // The fox does not offer "sleepy", so switching resolves to the fox's own default.
  await page.getByRole("button", { name: /Ember/ }).click();
  await expect(renderer(page)).toHaveAttribute("data-pet", "ember-fox");
  await expect(renderer(page)).toHaveAttribute("data-personality", "curious");
  await expect(personalityGroup.getByRole("button", { name: "Sleepy" })).toHaveCount(0);

  // Anonymous: nothing was written.
  expect((await page.context().request.get("/api/settings/pet/personality")).status()).toBe(401);
});

test("keyboard users can choose a personality", async ({ page }) => {
  await page.goto("/pets");
  const personalityGroup = page.getByRole("group", { name: "Choose a personality" });

  await personalityGroup.getByRole("button", { name: "Curious" }).focus();
  await page.keyboard.press("Enter");

  await expect(renderer(page)).toHaveAttribute("data-personality", "curious");
  await expect(personalityGroup.getByRole("button", { name: "Curious" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("the playground still fits a narrow viewport with the personality controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/pets");

  await expect(page.getByRole("group", { name: "Choose a personality" })).toBeVisible();
  const dims = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(dims.width).toBeLessThanOrEqual(dims.viewport);
});

test("the existing pet, appearance, state, and size controls still work", async ({ page }) => {
  await page.goto("/pets");

  await page.getByRole("button", { name: /Ember/ }).click();
  await expect(renderer(page)).toHaveAttribute("data-pet", "ember-fox");

  await page
    .getByRole("group", { name: "Choose an appearance" })
    .getByRole("button", { name: "Flame" })
    .click();
  await expect(renderer(page)).toHaveAttribute("data-appearance", "ember");

  await page.getByRole("button", { name: "Thinking", exact: true }).click();
  await expect(renderer(page)).toHaveAttribute("data-state", "thinking");

  await page.getByRole("button", { name: "Small", exact: true }).click();
  await expect(renderer(page)).toHaveClass(/pet-renderer--sm/);

  // None of those disturbed the personality, which stays on the fox's default.
  await expect(renderer(page)).toHaveAttribute("data-personality", "curious");
});

test("a signed-in user's personality is persisted and reaches the chat companion", async ({
  page,
}) => {
  test.skip(!databaseUrl, DATABASE_SKIP_REASON);
  await signUp(page, "pets-personality");
  await page.goto("/pets");
  const personalityGroup = page.getByRole("group", { name: "Choose a personality" });

  await expect(renderer(page)).toHaveAttribute("data-personality", "calm");
  await personalityGroup.getByRole("button", { name: "Sleepy" }).click();
  await expect(renderer(page)).toHaveAttribute("data-personality", "sleepy");
  await expect.poll(() => storedPersonality(page)).toBe("sleepy");

  // A reload re-reads the stored personality from the server.
  await page.reload();
  await expect(renderer(page)).toHaveAttribute("data-personality", "sleepy");
  await expect(personalityGroup.getByRole("button", { name: "Sleepy" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // The personality write left the stored pet and appearance exactly as they were.
  await expect.poll(() => storedPet(page)).toBe("yori-cat");
  await expect.poll(() => storedAppearance(page)).toBe("classic");

  // The chat companion carries the persisted personality.
  await page.goto("/");
  await expect(page.locator(".welcome-figure .pet-renderer")).toHaveAttribute(
    "data-personality",
    "sleepy",
  );
});

test("the reaction demo renders and a button changes the pet state", async ({ page }) => {
  await page.goto("/pets");
  const demo = page.getByRole("group", { name: "Reaction demo" });

  await expect(demo).toBeVisible();
  await expect(demo.getByRole("button", { name: "User Message" })).toBeVisible();
  await expect(demo.getByRole("button", { name: "Response Error" })).toBeVisible();
  await expect(demo.getByRole("button", { name: "Reset" })).toBeVisible();

  await expect(renderer(page)).toHaveAttribute("data-state", "idle");

  await demo.getByRole("button", { name: "Start Thinking" }).click();
  await expect(renderer(page)).toHaveAttribute("data-state", "thinking");
  // The note names the event and the state it produced, so the mapping is visible.
  await expect(demo.locator(".pets-reaction-note")).toContainText("Start Thinking → Thinking");

  await demo.getByRole("button", { name: "Reset" }).click();
  await expect(renderer(page)).toHaveAttribute("data-state", "idle");
});

test("a temporary reaction settles back to idle on its own", async ({ page }) => {
  await page.goto("/pets");
  const demo = page.getByRole("group", { name: "Reaction demo" });

  await demo.getByRole("button", { name: "Response Complete" }).click();
  await expect(renderer(page)).toHaveAttribute("data-state", "happy");

  // No further click: the controller's own timer settles the pet.
  await expect(renderer(page)).toHaveAttribute("data-state", "idle", { timeout: 5_000 });
});

test("different personalities react differently to the same event", async ({ page }) => {
  await page.goto("/pets");
  const demo = page.getByRole("group", { name: "Reaction demo" });

  // The cat, calm by default, is merely pleased.
  await demo.getByRole("button", { name: "Response Complete" }).click();
  await expect(renderer(page)).toHaveAttribute("data-state", "happy");

  // The fox with the playful personality cannot sit still.
  await page.getByRole("button", { name: /Ember/ }).click();
  await page
    .getByRole("group", { name: "Choose a personality" })
    .getByRole("button", { name: "Playful" })
    .click();

  await demo.getByRole("button", { name: "Response Complete" }).click();
  await expect(renderer(page)).toHaveAttribute("data-state", "excited");
});

test("reaction controls work from the keyboard", async ({ page }) => {
  await page.goto("/pets");
  const demo = page.getByRole("group", { name: "Reaction demo" });

  await demo.getByRole("button", { name: "Response Error" }).focus();
  await page.keyboard.press("Enter");

  await expect(renderer(page)).toHaveAttribute("data-state", "sad");
  await expect(renderer(page)).toHaveClass(/pet-pose-sad/);
});

test("reactions still change state under reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/pets");
  const demo = page.getByRole("group", { name: "Reaction demo" });

  // The state change and the pose still arrive; only the CSS movement is suppressed.
  await demo.getByRole("button", { name: "Start Thinking" }).click();
  await expect(renderer(page)).toHaveAttribute("data-state", "thinking");
  await expect(renderer(page)).toHaveClass(/pet-pose-thinking/);

  // And a temporary reaction still settles, so nothing depends on motion.
  await demo.getByRole("button", { name: "Response Complete" }).click();
  await expect(renderer(page)).toHaveAttribute("data-state", "happy");
  await expect(renderer(page)).toHaveAttribute("data-state", "idle", { timeout: 5_000 });
});

test("the reaction demo keeps the mobile layout intact", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/pets");

  await expect(page.getByRole("group", { name: "Reaction demo" })).toBeVisible();
  const dims = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(dims.width).toBeLessThanOrEqual(dims.viewport);
});
