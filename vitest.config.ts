import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Mirrors the `@/*` path alias from tsconfig.json so tests can import the same
// modules the Next.js build resolves.
const srcAlias = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  resolve: { alias: { "@": srcAlias } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    clearMocks: true,
    restoreMocks: true,
  },
});
