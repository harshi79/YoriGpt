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

  it("reports a missing or blank APP_URL as unset, not as an invalid URL", () => {
    // The production symptom: `next start` without a usable APP_URL (the file was
    // never copied, or a platform injected an empty value) surfaced as a bare
    // "Invalid URL", which names neither the variable nor the mistake.
    vi.stubEnv("APP_URL", undefined);
    expect(() => getServerEnv("app")).toThrow(/app.*APP_URL/);
    expect(() => getServerEnv("app")).toThrow(/APP_URL: is not set/);
    vi.stubEnv("APP_URL", "");
    expect(() => getServerEnv("app")).toThrow(/APP_URL: is blank/);
    vi.stubEnv("APP_URL", "   ");
    expect(() => getServerEnv("app")).toThrow(/APP_URL: is blank/);
  });

  it("names the expected format when APP_URL is not an absolute http(s) URL", () => {
    // A bare host is the common deployment mistake; it must not read as "Invalid URL".
    vi.stubEnv("APP_URL", "yorigpt.example.com");
    expect(() => getServerEnv("app")).toThrow(/APP_URL: must be an absolute http\(s\) URL/);
    expect(() => getServerEnv("app")).not.toThrow(/yorigpt\.example\.com/);
  });

  it("trims surrounding whitespace instead of rejecting a pasted value", () => {
    vi.stubEnv("APP_URL", "  http://localhost:3000  ");
    expect(getServerEnv("app")).toEqual({ APP_URL: "http://localhost:3000" });
    vi.stubEnv("DATABASE_URL", "  postgresql://user:secret@localhost:5432/yorigpt  ");
    expect(getServerEnv("database").DATABASE_URL).toBe(
      "postgresql://user:secret@localhost:5432/yorigpt",
    );
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

  it("ignores blank origin entries but still rejects a malformed origin", () => {
    vi.stubEnv("AUTH_SECRET", "a".repeat(48));
    vi.stubEnv("AUTH_TRUSTED_ORIGINS", "");
    expect(getServerEnv("auth").AUTH_TRUSTED_ORIGINS).toEqual([]);

    // A trailing comma or empty line in a deployment configuration means "none",
    // exactly like blank entries in an API key list.
    vi.stubEnv(
      "AUTH_TRUSTED_ORIGINS",
      " https://preview.example.com , ,https://*.e2b.app, ",
    );
    expect(getServerEnv("auth").AUTH_TRUSTED_ORIGINS).toEqual([
      "https://preview.example.com",
      "https://*.e2b.app",
    ]);

    // The failing entry is named by index, so a long list is still diagnosable.
    vi.stubEnv("AUTH_TRUSTED_ORIGINS", "https://ok.example,preview.example.com");
    expect(() => getServerEnv("auth")).toThrow(
      /AUTH_TRUSTED_ORIGINS\.1: must be an absolute http\(s\) origin/,
    );
  });

  it("reports a blank email configuration instead of an invalid URL", () => {
    vi.stubEnv("SMTP_URL", "");
    vi.stubEnv("EMAIL_FROM", "no-reply@example.invalid");
    expect(() => getServerEnv("email")).toThrow(/SMTP_URL: is blank/);

    vi.stubEnv("SMTP_URL", "smtp.example.invalid:587");
    expect(() => getServerEnv("email")).toThrow(/SMTP_URL: must be an smtp:\/\/ or smtps:\/\/ URL/);

    vi.stubEnv("SMTP_URL", "  smtps://user:password@smtp.example.invalid:465  ");
    vi.stubEnv("EMAIL_FROM", "  no-reply@example.invalid  ");
    expect(getServerEnv("email")).toEqual({
      SMTP_URL: "smtps://user:password@smtp.example.invalid:465",
      EMAIL_FROM: "no-reply@example.invalid",
    });
  });

  it("falls back to the documented provider URLs when they are blank", () => {
    // A stray `OPENROUTER_BASE_URL=` line means "not configured", never a crash.
    vi.stubEnv("OPENROUTER_API_KEYS", "openrouter-test-key");
    vi.stubEnv("OPENROUTER_BASE_URL", "");
    expect(getServerEnv("openrouter").OPENROUTER_BASE_URL).toBe(
      "https://openrouter.ai/api/v1",
    );
    vi.stubEnv("OPENROUTER_BASE_URL", "   ");
    expect(getServerEnv("openrouter").OPENROUTER_BASE_URL).toBe(
      "https://openrouter.ai/api/v1",
    );
    // A value that is present but unusable is still an error.
    vi.stubEnv("OPENROUTER_BASE_URL", "openrouter.ai/api/v1");
    expect(() => getServerEnv("openrouter")).toThrow(/OPENROUTER_BASE_URL/);
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

  it("reads NVIDIA credentials lazily, separately, and without leaking them in errors", () => {
    vi.stubEnv("OPENROUTER_API_KEYS", "openrouter-test-key-not-a-secret");
    vi.stubEnv("NVIDIA_API_KEYS", undefined);
    // Configuring only OpenRouter still works. The NVIDIA scope is not validated
    // while importing adapters, listing catalog models, or answering through the
    // incumbent provider.
    expect(getServerEnv("openrouter").OPENROUTER_API_KEYS).toEqual([
      "openrouter-test-key-not-a-secret",
    ]);
    expect(() => getServerEnv("nvidia")).toThrow(/NVIDIA_API_KEYS/);

    vi.stubEnv("OPENROUTER_API_KEYS", undefined);
    vi.stubEnv("NVIDIA_API_KEYS", "  nvidia-first-test-key  , , nvidia-second-test-key ,");
    vi.stubEnv("NVIDIA_BASE_URL", undefined);
    expect(getServerEnv("nvidia")).toEqual({
      NVIDIA_API_KEYS: ["nvidia-first-test-key", "nvidia-second-test-key"],
      NVIDIA_BASE_URL: "https://integrate.api.nvidia.com/v1",
    });

    vi.stubEnv("NVIDIA_BASE_URL", "invalid-url-with-private-value");
    expect(() => getServerEnv("nvidia")).toThrow(/NVIDIA_BASE_URL/);
    expect(() => getServerEnv("nvidia")).not.toThrow(/private-value/);
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
