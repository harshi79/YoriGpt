import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

vi.mock("server-only", () => ({}));

const {
  DEFAULT_MODEL_KEY,
  MODEL_CATALOG,
  defaultModelKey,
  findCatalogModel,
  isSelectableModelKey,
  listSelectableModels,
  resetCatalogWarnings,
  resolveCatalogIdentifier,
  resolveStoredModelKey,
} = await import("../src/server/ai/models/catalog");

afterEach(() => {
  resetCatalogWarnings();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Silences and captures the warn-once messages the catalog writes. */
function captureWarnings() {
  const lines: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return lines;
}

describe("model catalog", () => {
  it("has unique, consistent entries and a selectable default", () => {
    const keys = MODEL_CATALOG.map((model) => model.key);
    const identifiers = MODEL_CATALOG.map((model) => model.modelIdentifier);

    expect(new Set(keys).size).toBe(MODEL_CATALOG.length);
    expect(new Set(identifiers).size).toBe(MODEL_CATALOG.length);
    for (const model of MODEL_CATALOG) {
      expect(model.key).toMatch(/^[a-z0-9][a-z0-9.-]*$/);
      // Every identifier is an OpenRouter one, never a bare model name.
      expect(model.modelIdentifier).toMatch(/^[a-z0-9-]+\/[A-Za-z0-9.:_-]+$/);
      expect(model.name.trim().length).toBeGreaterThan(0);
      expect(model.description.trim().length).toBeGreaterThan(0);
    }

    const fallback = findCatalogModel(DEFAULT_MODEL_KEY);
    expect(fallback).not.toBeNull();
    expect(fallback?.active).toBe(true);
  });

  it("resolves a known key to its OpenRouter identifier", () => {
    for (const model of MODEL_CATALOG.filter((entry) => entry.active)) {
      expect(resolveCatalogIdentifier(model.key)).toBe(model.modelIdentifier);
    }
  });

  it("rejects unknown and inactive keys instead of guessing", () => {
    const inactive = MODEL_CATALOG.find((model) => !model.active);
    expect(inactive, "the catalog should keep one retired model").toBeDefined();

    expect(() => resolveCatalogIdentifier("not-a-model")).toThrow(/Unknown or inactive/);
    expect(() => resolveCatalogIdentifier(inactive!.key)).toThrow(/Unknown or inactive/);
    // A raw provider identifier is not a catalog key, so it is refused too.
    expect(() => resolveCatalogIdentifier(inactive!.modelIdentifier)).toThrow(
      /Unknown or inactive/,
    );
    expect(() => resolveCatalogIdentifier("")).toThrow(/Unknown or inactive/);
    expect(() => resolveCatalogIdentifier(undefined)).toThrow(/Unknown or inactive/);
  });

  it("only reports active models as selectable", () => {
    for (const model of MODEL_CATALOG) {
      expect(isSelectableModelKey(model.key), model.key).toBe(model.active);
    }
    for (const value of ["", "gpt-4o-mini ", 42, null, undefined, {}]) {
      expect(isSelectableModelKey(value), String(value)).toBe(false);
    }

    const selectable = listSelectableModels();
    expect(selectable.length).toBe(MODEL_CATALOG.filter((m) => m.active).length);
    expect(selectable.every((model) => model.active)).toBe(true);
  });

  it("maps a known model to itself and reports no fallback", () => {
    expect(resolveStoredModelKey("gpt-4o")).toEqual({ key: "gpt-4o", usedFallback: false });
    // No preference at all is the default, and not a fallback worth logging.
    expect(resolveStoredModelKey(null)).toEqual({ key: DEFAULT_MODEL_KEY, usedFallback: false });
    expect(resolveStoredModelKey(undefined)).toEqual({
      key: DEFAULT_MODEL_KEY,
      usedFallback: false,
    });
  });

  it("falls back to the default when a stored preference is unknown or retired", () => {
    const inactive = MODEL_CATALOG.find((model) => !model.active)!;

    expect(resolveStoredModelKey("removed-model")).toEqual({
      key: DEFAULT_MODEL_KEY,
      usedFallback: true,
    });
    expect(resolveStoredModelKey(inactive.key)).toEqual({
      key: DEFAULT_MODEL_KEY,
      usedFallback: true,
    });
    // An identifier stored by mistake (an older client, a hand-edited row) is not
    // silently upgraded into a selection either.
    expect(resolveStoredModelKey("openai/gpt-4o-mini").usedFallback).toBe(true);
  });
});

describe("default model", () => {
  it("uses the catalog default when nothing is configured", () => {
    vi.stubEnv("OPENROUTER_MODEL", "");
    expect(defaultModelKey()).toBe(DEFAULT_MODEL_KEY);
    vi.stubEnv("OPENROUTER_MODEL", "   ");
    expect(defaultModelKey()).toBe(DEFAULT_MODEL_KEY);
  });

  it("honours OPENROUTER_MODEL when it names a catalog model", () => {
    const target = MODEL_CATALOG.find((model) => model.active && model.key !== DEFAULT_MODEL_KEY)!;

    vi.stubEnv("OPENROUTER_MODEL", target.modelIdentifier);
    expect(defaultModelKey()).toBe(target.key);

    // The key itself works too, which keeps a deployment configuration readable.
    vi.stubEnv("OPENROUTER_MODEL", target.key);
    expect(defaultModelKey()).toBe(target.key);
  });

  it("ignores a configured name that is not an active catalog model, and says so once", () => {
    const warnings = captureWarnings();
    vi.stubEnv("OPENROUTER_MODEL", "mock/yori-test");

    expect(defaultModelKey()).toBe(DEFAULT_MODEL_KEY);
    expect(defaultModelKey()).toBe(DEFAULT_MODEL_KEY);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("OPENROUTER_MODEL");
    // The warning names the configured value, never a credential.
    expect(warnings[0]).toContain("mock/yori-test");
  });

  it("ignores a retired catalog model configured as the default", () => {
    const inactive = MODEL_CATALOG.find((model) => !model.active)!;
    captureWarnings();
    vi.stubEnv("OPENROUTER_MODEL", inactive.modelIdentifier);

    expect(defaultModelKey()).toBe(DEFAULT_MODEL_KEY);
  });
});

describe("seeded catalog rows", () => {
  it("mirror the code catalog, so preferences can reference every model", () => {
    const migrations = readdirSync("prisma/migrations").filter((dir) =>
      dir.includes("seed_ai_models"),
    );
    expect(migrations).toHaveLength(1);

    const sql = readFileSync(
      join("prisma/migrations", migrations[0], "migration.sql"),
      "utf8",
    );

    for (const model of MODEL_CATALOG) {
      // id (the catalog key), provider, identifier, display name, and active flag.
      const row = new RegExp(
        `\\('${model.key}'\\s*,\\s*'OPENROUTER'\\s*,\\s*'${model.modelIdentifier.replace(/[/.]/g, "\\$&")}'\\s*,\\s*'${model.name.replace(/'/g, "''")}'\\s*,\\s*${model.active}`,
      );
      expect(sql, `seed row for ${model.key}`).toMatch(row);
    }
  });
});
