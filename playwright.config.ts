import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3100",
    browserName: "chromium",
    // Pinned so the suite keeps exercising the palette it was written against.
    // The application default theme is `system`, and a fresh Playwright context
    // reports a light device preference; the settings spec emulates each scheme
    // explicitly instead (see tests/e2e/settings.spec.ts).
    colorScheme: "dark",
    // Optional local browser path for restricted development environments.
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? {
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
          args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote"],
        }
      : undefined,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "npm run start -- --port 3100",
      url: "http://127.0.0.1:3100",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      // Throwaway values so auth pages can render without a local .env. No real
      // secret, database, mail server, or AI provider is used: the OpenRouter
      // variables below point the reply endpoint at the local stub started by the
      // second entry. Point DATABASE_TEST_URL at a disposable PostgreSQL database
      // to enable the signed-in checks; the rest of the suite needs no database.
      env: {
        APP_URL: "http://127.0.0.1:3100",
        AUTH_SECRET: "playwright-only-secret-value-not-used-in-production",
        DATABASE_URL:
          process.env.DATABASE_TEST_URL ??
          "postgresql://validation:validation@127.0.0.1:5432/validation?schema=public",
        SMTP_URL: "",
        EMAIL_FROM: "",
        // Two stub keys so the browser suite can exercise key rotation: the first
        // one is refused by the stub for "[rotate]" messages (see the mock's header).
        OPENROUTER_API_KEYS: "playwright-stub-key-one-not-a-secret,playwright-stub-key-two-not-a-secret",
        OPENROUTER_BASE_URL: "http://127.0.0.1:3210/api/v1",
        // Left unset on purpose: with no configured name, the server catalog decides
        // the default (and the browser suite asserts the identifier that arrives at
        // the stub). A name that is not a catalog model would be ignored anyway.
        OPENROUTER_MODEL: "",
      },
    },
    {
      // Deterministic OpenRouter-compatible stub: no network, no API key.
      command: "node tests/e2e/mock-openrouter.mjs",
      url: "http://127.0.0.1:3210/health",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
