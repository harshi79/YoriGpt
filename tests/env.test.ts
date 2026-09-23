import { afterEach, describe, expect, it, vi } from "vitest";

// Next enforces this import boundary at build time; Vitest runs outside Next.
vi.mock("server-only", () => ({}));
import { getServerEnv } from "../src/server/env";

afterEach(() => vi.unstubAllEnvs());

describe("server environment configuration", () => {
  it("validates only the requested scope", () => {
    vi.stubEnv("APP_URL", "https://yorigpt.example");
    vi.stubEnv("DATABASE_URL", undefined);
    vi.stubEnv("AUTH_SECRET", undefined);
    expect(getServerEnv("app")).toEqual({ APP_URL: "https://yorigpt.example" });
  });

  it("reports missing database configuration when requested", () => {
    vi.stubEnv("DATABASE_URL", undefined);
    expect(() => getServerEnv("database")).toThrow(/database.*DATABASE_URL/);
  });

  it("rejects invalid URLs without leaking credentials", () => {
    vi.stubEnv(
      "DATABASE_URL",
      "https://private-user:private-password@example.com",
    );
    expect(() => getServerEnv("database")).toThrow(/DATABASE_URL/);
    expect(() => getServerEnv("database")).not.toThrow(/private-password/);
  });

  it.each([
    "not-a-url-private-value",
    "postgresql://localhost",
    "postgresql://localhost/database?schema=",
  ])(
    "rejects malformed database configuration without leaking values (%#)",
    (value) => {
      vi.stubEnv("DATABASE_URL", value);
      expect(() => getServerEnv("database")).toThrow(/database.*DATABASE_URL/);
      expect(() => getServerEnv("database")).not.toThrow(value);
    },
  );

  it("rejects weak authentication secrets", () => {
    vi.stubEnv("AUTH_SECRET", "too-short");
    expect(() => getServerEnv("auth")).toThrow(/32 characters/);
  });

  it("parses provider configuration without performing any requests", () => {
    vi.stubEnv("OPENROUTER_API_KEYS", "test-key-one, test-key-two");
    vi.stubEnv("OPENROUTER_BASE_URL", undefined);
    expect(getServerEnv("openrouter")).toEqual({
      OPENROUTER_API_KEYS: ["test-key-one", "test-key-two"],
      OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
      // No model is configured here: the variable is simply absent, and the model
      // catalog supplies the default (see the model catalog tests).
      OPENROUTER_MODEL: undefined,
    });

    // Whitespace is trimmed and blank entries are ignored, so a stray comma or an
    // empty line in a deploy configuration cannot take replies down. Order is kept:
    // the key pool rotates in exactly this order.
    vi.stubEnv("OPENROUTER_API_KEYS", "  first-key ,,  second-key  ,");
    expect(getServerEnv("openrouter").OPENROUTER_API_KEYS).toEqual([
      "first-key",
      "second-key",
    ]);

    vi.stubEnv("OPENROUTER_MODEL", "  anthropic/claude-3.5-haiku  ");
    expect(getServerEnv("openrouter").OPENROUTER_MODEL).toBe("anthropic/claude-3.5-haiku");

    // A blank line in .env is a common mistake and is treated as "not configured",
    // so the catalog default applies rather than an empty model name.
    vi.stubEnv("OPENROUTER_MODEL", "");
    expect(getServerEnv("openrouter").OPENROUTER_MODEL).toBeUndefined();
    vi.stubEnv("OPENROUTER_MODEL", "   ");
    expect(getServerEnv("openrouter").OPENROUTER_MODEL).toBeUndefined();

    // The declared option never invents a default, and only a string is accepted.
    vi.stubEnv("OPENROUTER_MODEL", undefined);
    expect(getServerEnv("openrouter").OPENROUTER_MODEL).toBeUndefined();
  });

  it("rejects a key list with no usable entry and unchanged placeholders", () => {
    // Blank entries are ignored, so a trailing comma alone is not an error.
    vi.stubEnv("NVIDIA_API_KEYS", "test-key,");
    expect(getServerEnv("nvidia").NVIDIA_API_KEYS).toEqual(["test-key"]);

    // A list that contains no key at all still fails, field name only.
    vi.stubEnv("NVIDIA_API_KEYS", " , ,");
    expect(() => getServerEnv("nvidia")).toThrow(/NVIDIA_API_KEYS/);

    vi.stubEnv("NVIDIA_API_KEYS", "replace_me");
    expect(() => getServerEnv("nvidia")).toThrow(/runtime credential/);
  });
});
