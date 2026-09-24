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
  resolveCatalogEntry,
  resolveCatalogIdentifier,
  resolveStoredModelKey,
} = await import("../src/server/ai/models/catalog");

/** The providers the catalog is allowed to name; each one has an adapter. */
const KNOWN_PROVIDERS = ["openrouter", "nvidia"] as const;

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
    const providerIdentifiers = MODEL_CATALOG.map(
      (model) => `${model.provider}\u0000${model.modelIdentifier}`,
    );

    expect(new Set(keys).size).toBe(MODEL_CATALOG.length);
    // The database schema enforces uniqueness per provider, not globally: two
    // providers may host the same underlying model identifier independently.
    expect(new Set(providerIdentifiers).size).toBe(MODEL_CATALOG.length);
    for (const model of MODEL_CATALOG) {
      expect(model.key).toMatch(/^[a-z0-9][a-z0-9.-]*$/);
      // Every entry names the provider that serves it, and only a provider this
      // deployment has an adapter for.
      expect(KNOWN_PROVIDERS, model.key).toContain(model.provider);
      // Every identifier is a provider-scoped one (author/model), never a bare name.
      expect(model.modelIdentifier).toMatch(/^[a-z0-9-]+\/[A-Za-z0-9.:_-]+$/);
      expect(model.name.trim().length).toBeGreaterThan(0);
      expect(model.description.trim().length).toBeGreaterThan(0);
    }

    // A provider may offer several models, but every provider that appears in the
    // catalog has to offer at least one selectable model.
    for (const provider of new Set(MODEL_CATALOG.map((model) => model.provider))) {
      expect(
        MODEL_CATALOG.some((model) => model.provider === provider && model.active),
        `${provider} has no active model`,
      ).toBe(true);
    }

    const fallback = findCatalogModel(DEFAULT_MODEL_KEY);
    expect(fallback).not.toBeNull();
    expect(fallback?.active).toBe(true);
  });

  it("resolves a known key to the identifier of its own provider", () => {
    for (const model of MODEL_CATALOG.filter((entry) => entry.active)) {
      expect(resolveCatalogIdentifier(model.key, model.provider)).toBe(model.modelIdentifier);
      expect(resolveCatalogEntry(model.key)).toEqual(model);
    }
  });

  it("refuses to hand one provider the model of another", () => {
    const foreign = MODEL_CATALOG.find((model) => model.provider !== "openrouter" && model.active)!;
    expect(foreign, "the catalog should offer a second provider").toBeDefined();

    // The provider argument defaults to OpenRouter, so an adapter that forgets to
    // name itself fails loudly instead of borrowing another provider's model.
    expect(() => resolveCatalogIdentifier(foreign.key)).toThrow(/served by another provider/);
    expect(() => resolveCatalogIdentifier(foreign.key, "openrouter")).toThrow(
      /served by another provider/,
    );
    expect(() => resolveCatalogIdentifier("gpt-4o-mini", "nvidia")).toThrow(
      /served by another provider/,
    );
  });

  it("rejects unknown and inactive keys instead of guessing", () => {
    const inactive = MODEL_CATALOG.find((model) => !model.active);
    expect(inactive, "the catalog should keep one retired model").toBeDefined();

    expect(() => resolveCatalogEntry("not-a-model")).toThrow(/Unknown or inactive/);
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
  /** Every migration that writes `ai_models` rows, oldest first, with its SQL. */
  function seedMigrations() {
    return readdirSync("prisma/migrations")
      .filter((dir) => dir.includes("seed"))
      .sort()
      .map((dir) => ({
        dir,
        sql: readFileSync(join("prisma/migrations", dir, "migration.sql"), "utf8"),
      }))
      .filter(({ sql }) => sql.includes('INSERT INTO "ai_models"'));
  }

  it("mirror the code catalog, so preferences can reference every model", () => {
    const migrations = seedMigrations();
    // The first seed wrote the OpenRouter catalog; a later one added NVIDIA. Both
    // are required, because `user_preferences.preferredModelId` references the rows.
    expect(migrations.map((entry) => entry.dir)).toContain("20260923020000_seed_ai_models");
    expect(migrations.some((entry) => entry.dir.includes("nvidia"))).toBe(true);

    for (const model of MODEL_CATALOG) {
      // id (the catalog key), provider, identifier, display name, and active flag.
      const row = new RegExp(
        `\\('${model.key}'\\s*,\\s*'${model.provider.toUpperCase()}'\\s*,\\s*'${model.modelIdentifier.replace(/[/.]/g, "\\$&")}'\\s*,\\s*'${model.name.replace(/'/g, "''")}'\\s*,\\s*${model.active}`,
      );
      const seededBy = migrations.filter((entry) => row.test(entry.sql));
      // Exactly one migration owns each row, with the provider the catalog names —
      // never the incumbent provider by default.
      expect(seededBy.map((entry) => entry.dir), `seed row for ${model.key}`).toHaveLength(1);
    }

    // Re-applying a seed must update the row rather than fail on its primary key.
    for (const { dir, sql } of migrations) {
      expect(sql, dir).toMatch(/ON CONFLICT \("id"\) DO UPDATE/);
    }
  });
});
