import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { resolveReplyProvider } = await import("../src/server/ai/providers");
const { nvidiaProvider } = await import("../src/server/ai/providers/nvidia");
const { openRouterProvider } = await import("../src/server/ai/providers/openrouter");
const {
  DEFAULT_MODEL_KEY,
  MODEL_CATALOG,
  defaultModelKey,
  resetCatalogWarnings,
  resolveCatalogEntry,
  resolveCatalogIdentifier,
} = await import("../src/server/ai/models/catalog");

const NVIDIA = MODEL_CATALOG.find((entry) => entry.active && entry.provider === "nvidia")!;
const OPENROUTER = MODEL_CATALOG.find((entry) => entry.active && entry.provider === "openrouter")!;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetCatalogWarnings();
});

describe("provider selection by the trusted catalog", () => {
  it("maps every active model key to the adapter named by its catalog entry", () => {
    for (const entry of MODEL_CATALOG.filter((model) => model.active)) {
      expect(resolveReplyProvider(entry.key).name, entry.key).toBe(entry.provider);
      expect(resolveCatalogEntry(entry.key)).toBe(entry);
      expect(resolveCatalogIdentifier(entry.key, entry.provider)).toBe(entry.modelIdentifier);
    }
    expect(resolveReplyProvider(OPENROUTER.key)).toBe(openRouterProvider);
    expect(resolveReplyProvider(NVIDIA.key)).toBe(nvidiaProvider);
  });

  it("keeps OpenRouter as the default, even when NVIDIA keys are configured", () => {
    vi.stubEnv("OPENROUTER_MODEL", "");
    vi.stubEnv("OPENROUTER_API_KEYS", "");
    vi.stubEnv("NVIDIA_API_KEYS", "test-key-not-a-secret");

    expect(defaultModelKey()).toBe(DEFAULT_MODEL_KEY);
    expect(resolveReplyProvider()).toBe(openRouterProvider);
    expect(resolveReplyProvider(DEFAULT_MODEL_KEY)).toBe(openRouterProvider);
  });

  it("uses a NVIDIA model as a default only if the operator explicitly names it", () => {
    vi.stubEnv("OPENROUTER_MODEL", NVIDIA.key);
    expect(defaultModelKey()).toBe(NVIDIA.key);
    expect(resolveReplyProvider()).toBe(nvidiaProvider);

    vi.stubEnv("OPENROUTER_MODEL", NVIDIA.modelIdentifier);
    expect(defaultModelKey()).toBe(NVIDIA.key);
    expect(resolveReplyProvider()).toBe(nvidiaProvider);
  });

  it("rejects raw provider identifiers, retired models, and arbitrary strings", () => {
    const retired = MODEL_CATALOG.find((entry) => !entry.active)!;
    // No credential is configured: a rejected key must fail *before* the dispatch
    // has any reason to read provider configuration or touch a key pool.
    for (const key of [
      NVIDIA.modelIdentifier,
      OPENROUTER.modelIdentifier,
      "some-arbitrary-nvidia-model",
      retired.key,
      "",
    ]) {
      expect(() => resolveReplyProvider(key), key).toThrow(/Unknown or inactive model key/);
    }
  });

  it("does not accept a client-specified provider separate from a catalog key", () => {
    // The only parameter is a catalog key. An object with a different `provider`
    // field is not a model key, so it cannot pick NVIDIA for an OpenRouter entry.
    const forged = { modelKey: OPENROUTER.key, provider: "nvidia" };
    expect(() => resolveReplyProvider(forged as unknown as string)).toThrow(/Unknown or inactive/);
    expect(resolveReplyProvider(OPENROUTER.key)).toBe(openRouterProvider);
    expect(() => resolveCatalogIdentifier(OPENROUTER.key, "nvidia")).toThrow(
      /served by another provider/,
    );
    expect(() => resolveCatalogIdentifier(NVIDIA.key, "openrouter")).toThrow(
      /served by another provider/,
    );
  });
});
