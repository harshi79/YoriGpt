import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Opt-in integration tests against a disposable PostgreSQL database. They write
// real users and conversations there and clean them up afterwards. Never part of
// the no-database suite, and never pointed at a production database.
const srcAlias = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  resolve: { alias: { "@": srcAlias } },
  test: {
    environment: "node",
    include: ["tests/database/**/*.integration.ts"],
    fileParallelism: false,
  },
});
