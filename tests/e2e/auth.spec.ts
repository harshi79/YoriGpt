import { expect, test } from "@playwright/test";

const pages = [
  { path: "/register", heading: "Create your account", submit: "Create account" },
  { path: "/login", heading: "Sign in", submit: "Sign in" },
  { path: "/forgot-password", heading: "Reset your password", submit: "Send reset link" },
  { path: "/verify-email", heading: "Verify your email", submit: "Resend verification email" },
  { path: "/reset-password?token=e2e-preview-token", heading: "Choose a new password", submit: "Update password" },
];

for (const viewport of [
  { name: "mobile", width: 375, height: 812 },
  { name: "desktop", width: 1440, height: 900 },
]) {
  test(`auth pages render with usable form controls on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const current of pages) {
      await page.goto(current.path);
      await expect(page.getByRole("heading", { level: 1, name: current.heading })).toBeVisible();
      await expect(page.getByRole("button", { name: current.submit })).toBeVisible();
      const dimensions = await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
      }));
      expect(dimensions.width, `${current.path} must not scroll horizontally`).toBeLessThanOrEqual(dimensions.viewport);
    }

    // Password fields are never rendered as plain text and offer autofill hints.
    await page.goto("/register");
    const password = page.getByLabel("Password");
    await expect(password).toHaveAttribute("type", "password");
    await expect(password).toHaveAttribute("autocomplete", "new-password");
    await expect(page.getByLabel("Email")).toHaveAttribute("autocomplete", "email");
  });
}

test("register form validates locally, without contacting the auth API", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/auth")) requests.push(request.url());
  });

  await page.goto("/register");
  await page.getByLabel("Name").fill("Ada Lovelace");
  await page.getByLabel("Email").fill("not-an-email");
  await page.getByLabel("Password").fill("short");
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page.getByText("Enter a valid email address.")).toBeVisible();
  await expect(page.getByText("Use at least 8 characters.")).toBeVisible();
  await expect(page.getByLabel("Email")).toHaveAttribute("aria-invalid", "true");
  expect(requests, "local validation must not call the auth API").toHaveLength(0);
});

test("keyboard users can move through the sign-in form", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").focus();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Password")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeFocused();
});

test("reset password explains an invalid or missing token without faking success", async ({ page }) => {
  for (const path of ["/reset-password", "/reset-password?error=INVALID_TOKEN", "/reset-password?token="]) {
    await page.goto(path);
    await expect(page.getByText("This reset link is invalid or has expired.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Update password" })).toHaveCount(0);
    await expect(page.getByText(/password has been updated/i)).toHaveCount(0);
  }
});

test("auth pages disclose when email delivery is not configured", async ({ page }) => {
  await page.goto("/forgot-password");
  await expect(page.getByText(/Email delivery is not configured on this server/)).toBeVisible();
});

test("the chat shell still renders and auth pages link back to it", async ({ page }) => {
  await page.goto("/register");
  await page.getByRole("link", { name: "Back to chat" }).click();
  await expect(page.getByRole("heading", { name: "Where will your curiosity take you?" })).toBeVisible();
});
