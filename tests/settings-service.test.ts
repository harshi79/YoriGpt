import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * The settings service against a fake `user_preferences` table, so the read
 * arguments, the written columns, and the user scoping can be inspected directly.
 * Real PostgreSQL behavior (the enum column, cascade, isolation) is covered by
 * tests/database/settings.integration.ts.
 */
const fake = vi.hoisted(() => {
  const state = {
    rows: new Map<string, { userId: string; theme: string }>(),
    upserts: [] as {
      where: { userId: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }[],
    failWith: null as unknown,
  };
  return {
    state,
    db: {
      userPreferences: {
        findUnique: async (args: { where: { userId: string }; select: Record<string, boolean> }) => {
          if (state.failWith) throw state.failWith;
          return state.rows.get(args.where.userId) ?? null;
        },
        upsert: async (args: {
          where: { userId: string };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          state.upserts.push(args);
          if (state.failWith) throw state.failWith;
          const existing = state.rows.get(args.where.userId);
          state.rows.set(args.where.userId, {
            userId: args.where.userId,
            theme: (args.update.theme as string) ?? (args.create.theme as string) ?? existing?.theme ?? "SYSTEM",
          });
          return { userId: args.where.userId };
        },
      },
    },
  };
});

vi.mock("../src/server/db/client", () => ({ getDb: () => fake.db }));

const { getTheme, resolveTheme, saveTheme } = await import("../src/server/settings/service");
const { DEFAULT_STORED_THEME, toStoredTheme, toThemeValue } = await import(
  "../src/server/settings/theme"
);
const { DEFAULT_THEME, THEME_VALUES } = await import("../src/features/settings/types");

const userId = "cmuser00000000000000001";
const otherUserId = "cmuser00000000000000002";

beforeEach(() => {
  fake.state.rows.clear();
  fake.state.upserts = [];
  fake.state.failWith = null;
  vi.restoreAllMocks();
});

describe("the theme vocabulary", () => {
  it("offers exactly the three values of the existing Prisma enum", () => {
    expect(THEME_VALUES).toEqual(["system", "dark", "light"]);
    for (const value of THEME_VALUES) expect(toStoredTheme(value)).toBe(value.toUpperCase());
    expect(toStoredTheme("DARK")).toBeNull();
    expect(toStoredTheme("solarized")).toBeNull();
    expect(toStoredTheme("")).toBeNull();
    // A prototype key resolves to nothing instead of an inherited member.
    expect(toStoredTheme("__proto__")).toBeNull();
    expect(toStoredTheme("constructor")).toBeNull();
  });

  it("documents the schema's own default, so creating a row changes nothing", () => {
    expect(DEFAULT_THEME).toBe("system");
    expect(DEFAULT_STORED_THEME).toBe("SYSTEM");
    expect(toStoredTheme(DEFAULT_THEME)).toBe(DEFAULT_STORED_THEME);
  });

  it("resolves a stored value back to the wire value, and an unknown one to the default", () => {
    expect(toThemeValue("DARK")).toBe("dark");
    expect(toThemeValue("LIGHT")).toBe("light");
    expect(toThemeValue("SYSTEM")).toBe("system");
    // No row, and a value this build does not know, are both the default.
    expect(toThemeValue(null)).toBe(DEFAULT_THEME);
    expect(toThemeValue(undefined)).toBe(DEFAULT_THEME);
    expect(toThemeValue("SEPIA" as never)).toBe(DEFAULT_THEME);
  });
});

describe("reading the settings", () => {
  it("reports the documented default when the user has no preferences row", async () => {
    await expect(getTheme(userId)).resolves.toBe(DEFAULT_THEME);
  });

  it("reads the stored preference", async () => {
    fake.state.rows.set(userId, { userId, theme: "DARK" });
    await expect(getTheme(userId)).resolves.toBe("dark");
  });

  it("keeps one user's preference out of another user's read", async () => {
    fake.state.rows.set(userId, { userId, theme: "LIGHT" });
    fake.state.rows.set(otherUserId, { userId: otherUserId, theme: "DARK" });

    await expect(getTheme(userId)).resolves.toBe("light");
    await expect(getTheme(otherUserId)).resolves.toBe("dark");
    await expect(getTheme("cmuser00000000000000003")).resolves.toBe(DEFAULT_THEME);
  });

  it("answers the default instead of throwing when the read fails", async () => {
    const warnings = vi.spyOn(console, "error").mockImplementation(() => {});
    // resolveTheme is what the root layout uses, so a database outage degrades to
    // the documented default rather than failing the page.
    fake.state.failWith = new Error("connection lost");
    await expect(resolveTheme(userId)).resolves.toBe(DEFAULT_THEME);
    expect(warnings.mock.calls.some((call) => String(call[0]).includes("theme preference"))).toBe(
      true,
    );
  });
});

describe("storing the settings", () => {
  it("stores a theme for the signed-in user", async () => {
    await expect(saveTheme(userId, "dark")).resolves.toEqual({ ok: true, theme: "dark" });

    expect(fake.state.upserts).toHaveLength(1);
    // Scoped to the caller's own row, and the theme is the only column written.
    expect(fake.state.upserts[0].where).toEqual({ userId });
    expect(fake.state.upserts[0].create).toEqual({ userId, theme: "DARK" });
    expect(fake.state.upserts[0].update).toEqual({ theme: "DARK" });
    await expect(getTheme(userId)).resolves.toBe("dark");
  });

  it("stores every supported value as the matching enum member", async () => {
    for (const theme of THEME_VALUES) {
      await expect(saveTheme(userId, theme)).resolves.toEqual({ ok: true, theme });
    }
    expect(fake.state.upserts.map((entry) => entry.update.theme)).toEqual([
      "SYSTEM",
      "DARK",
      "LIGHT",
    ]);
  });

  it("updates the existing row instead of adding another", async () => {
    fake.state.rows.set(userId, { userId, theme: "DARK" });

    await saveTheme(userId, "light");
    await expect(getTheme(userId)).resolves.toBe("light");
    expect(fake.state.upserts).toHaveLength(1);
  });

  it("keeps one user's choice out of another user's row", async () => {
    await saveTheme(userId, "dark");
    await saveTheme(otherUserId, "light");

    await expect(getTheme(userId)).resolves.toBe("dark");
    await expect(getTheme(otherUserId)).resolves.toBe("light");
    expect(fake.state.upserts.map((entry) => entry.where.userId)).toEqual([userId, otherUserId]);
  });

  it("refuses an invalid theme without writing anything", async () => {
    for (const theme of ["DARK", "solarized", "", "  dark  ", "__proto__", 42, null]) {
      await expect(saveTheme(userId, theme as never)).resolves.toEqual({
        ok: false,
        reason: "invalid-theme",
      });
    }
    expect(fake.state.upserts).toEqual([]);
    await expect(getTheme(userId)).resolves.toBe(DEFAULT_THEME);
  });

  it("lets an unexpected database failure surface instead of hiding it", async () => {
    fake.state.failWith = new Error("connection lost");
    await expect(saveTheme(userId, "dark")).rejects.toThrow("connection lost");
  });
});
