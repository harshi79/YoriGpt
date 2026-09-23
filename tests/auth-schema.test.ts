import { readFileSync } from "node:fs";
import { getAuthTables } from "better-auth/db";
import type { DBFieldAttribute } from "better-auth";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Guards the Prisma schema against the installed Better Auth version's core
 * schema: every table and field the library writes must exist with a compatible
 * type. Re-run after any Better Auth upgrade (see docs/authentication.md).
 * The schema file is parsed directly because the Rust-free runtime data model
 * omits per-field nullability and uniqueness metadata.
 */
const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");

type Field = { name: string; type: string; required: boolean; unique: boolean; hasDefault: boolean; line: string };

function parseModel(modelName: string): Field[] {
  const block = schema.match(new RegExp(`model ${modelName} \\{([\\s\\S]*?)\\n\\}`));
  if (!block) throw new Error(`Prisma model ${modelName} not found`);
  return block[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//") && !line.startsWith("@@"))
    .map((line) => {
      const [name = "", rawType = "", ...attributes] = line.split(/\s+/);
      return {
        name,
        type: rawType.replace("?", ""),
        required: !rawType.endsWith("?"),
        unique: attributes.includes("@unique"),
        hasDefault: attributes.some((attribute) => attribute.startsWith("@default")),
        line,
      };
    });
}

function blockBody(modelName: string): string {
  return schema.match(new RegExp(`model ${modelName} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";
}

const TYPE_MAP: Record<string, string> = { string: "String", boolean: "Boolean", date: "DateTime", number: "Int" };
const PATTERN_BY_TYPE: Record<string, RegExp> = {
  string: /^[A-Za-z]+(\[\])?$|^String$/,
  boolean: /^Boolean$/,
  date: /^DateTime$/,
  number: /^Int$/,
};
const coreTables = getAuthTables({});

describe("Better Auth core schema matches the Prisma schema", () => {
  it.each(Object.entries(coreTables))("provides %s with every field the library writes", (key, table) => {
    const modelName = key.charAt(0).toUpperCase() + key.slice(1);
    const fields = parseModel(modelName);
    const required = table.fields as Record<string, DBFieldAttribute>;

    for (const [field, attribute] of Object.entries(required)) {
      const column = fields.find((candidate) => candidate.name === field);
      expect(column, `${modelName}.${field} is missing from the Prisma schema`).toBeDefined();
      // Multi-value attributes are stored as strings in this schema.
      const expectedType = Array.isArray(attribute.type) ? "string" : attribute.type;
      expect(column!.type, `${modelName}.${field} has an incompatible type`).toMatch(PATTERN_BY_TYPE[expectedType]);
      if (attribute.required) expect(column!.required, `${modelName}.${field} must be required`).toBe(true);
      if (attribute.unique) expect(column!.unique, `${modelName}.${field} must be unique`).toBe(true);
      if (!attribute.required) expect(column!.required, `${modelName}.${field} must be optional`).toBe(false);
    }

    // Nothing required may be left unwritten by the library unless the database
    // supplies a default (for example the app-owned `users.status` column).
    const scalarTypes = new Set(["String", "Boolean", "DateTime", "Int", "Json", "Float", "Decimal", "BigInt", "Bytes"]);
    for (const column of fields) {
      if (!scalarTypes.has(column.type)) continue; // relation field, not a column
      if (["id", "createdAt", "updatedAt"].includes(column.name) || !column.required) continue;
      expect(
        Object.keys(required).includes(column.name) || column.hasDefault,
        `${modelName}.${column.name} is required but neither Better Auth-managed nor defaulted`,
      ).toBe(true);
    }
  });

  it("keeps the identity uniqueness and cascade rules the adapter relies on", () => {
    expect(parseModel("User").find((field) => field.name === "email")!.unique).toBe(true);
    expect(parseModel("Session").find((field) => field.name === "token")!.unique).toBe(true);
    expect(blockBody("Account")).toContain("@@unique([providerId, accountId])");
    expect(blockBody("Session")).toContain("@@map(\"sessions\")");
    expect(blockBody("Verification")).toContain("@@map(\"verifications\")");

    for (const model of ["Session", "Account"]) {
      const user = parseModel(model).find((field) => field.name === "user")!;
      expect(user.line, `${model}.user must cascade`).toContain("onDelete: Cascade");
      expect(user.line).toContain("references: [id]");
    }
    expect(TYPE_MAP.string).toBe("String");
  });

  it("preserves the existing application models and ownership rules", () => {
    for (const name of ["Conversation", "Message", "AiModel", "UserPreferences"]) {
      expect(parseModel(name).length).toBeGreaterThan(0);
    }
    expect(parseModel("Conversation").find((field) => field.name === "userId")!.required).toBe(true);
    expect(parseModel("Message").find((field) => field.name === "conversationId")!.required).toBe(true);
  });
});
