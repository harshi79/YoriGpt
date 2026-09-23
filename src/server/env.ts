import "server-only";
import { z } from "zod";

// No validation at import time: a static build needs none of these services.
// Never re-export this module through a client-facing barrel or NEXT_PUBLIC_*.
const required = z.string().trim().min(1, "must not be empty");
const secret = required.refine(
  (value) => !/^(change[-_]?me|replace[-_]?me|your[-_]|example)/i.test(value),
  "must be replaced with a real runtime credential",
);
const httpUrl = z.url({ protocol: /^https?$/ });
// A comma-separated key list. Blank entries (a trailing comma, a stray line in a
// deployment configuration) are ignored instead of failing validation, but a list
// with no usable key still fails — so a missing credential keeps its existing
// AI_NOT_CONFIGURED behavior. The order is preserved: the adapter rotates in it.
const apiKeys = secret
  .transform((value) =>
    value
      .split(",")
      .map((key) => key.trim())
      .filter((key) => key.length > 0),
  )
  .pipe(z.array(secret).min(1));

/**
 * The optional default model *name*. It is not a credential, so it is parsed with
 * its own tiny schema and can be read before provider keys exist (the chat header
 * shows the default model on pages that never generate anything). Which model that
 * name selects, and whether it is acceptable at all, is decided by the server-owned
 * catalog in `server/ai/models/catalog.ts` — never by this value alone.
 */
const optionalModelName = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  required.optional(),
);

/** The trimmed value of OPENROUTER_MODEL, or `undefined` when it is blank/missing. */
export function getConfiguredModelName(): string | undefined {
  const parsed = optionalModelName.safeParse(process.env.OPENROUTER_MODEL);
  return parsed.success ? parsed.data : undefined;
}

const databaseUrl = z.url({ protocol: /^postgres(ql)?$/ }).pipe(
  z.string().superRefine((value, context) => {
    // The pipe ensures malformed URLs fail before new URL(), avoiding raw errors.
    const url = new URL(value);
    if (!url.hostname || url.pathname.length <= 1) {
      context.addIssue({
        code: "custom",
        message: "must include a PostgreSQL host and database name",
      });
    }
    const schema = url.searchParams.get("schema");
    if (schema !== null && !schema.trim()) {
      context.addIssue({
        code: "custom",
        message: "schema must not be empty when provided",
      });
    }
  }),
);

// Comma-separated extra origins (for example a preview or staging host) that may
// call the auth API and the conversation API. Every entry must be an absolute
// http(s) URL; a `*` host label (https://*.example.com) covers preview hosts.
const originList = z
  .string()
  .trim()
  .default("")
  .transform((value) => (value ? value.split(",").map((origin) => origin.trim()) : []))
  .pipe(z.array(httpUrl));

const schemas = {
  app: z.object({ APP_URL: httpUrl }),
  database: z.object({ DATABASE_URL: databaseUrl }),
  auth: z.object({
    AUTH_SECRET: secret.pipe(
      z.string().min(32, "must contain at least 32 characters"),
    ),
    AUTH_TRUSTED_ORIGINS: originList,
  }),
  email: z.object({
    SMTP_URL: z.url({ protocol: /^smtps?$/ }),
    EMAIL_FROM: z.email(),
  }),
  openrouter: z.object({
    // Comma-separated; the adapter rotates through them (see server/ai/key-pool).
    OPENROUTER_API_KEYS: apiKeys,
    OPENROUTER_BASE_URL: httpUrl.default("https://openrouter.ai/api/v1"),
    // Optional. Blank (or missing) means the catalog default; a value that names
    // no active catalog model falls back to that default as well.
    OPENROUTER_MODEL: optionalModelName,
  }),
  nvidia: z.object({
    NVIDIA_API_KEYS: apiKeys,
    NVIDIA_BASE_URL: httpUrl.default("https://integrate.api.nvidia.com/v1"),
  }),
};

type Scope = keyof typeof schemas;

/** Call inside the relevant server service, not at module scope or from layouts. */
export function getServerEnv<S extends Scope>(
  scope: S,
): z.output<(typeof schemas)[S]> {
  const result = schemas[scope].safeParse(process.env);
  if (!result.success) {
    // Report field names and validation messages, never values/credentials.
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(
      `Invalid server configuration (${scope}): ${details}. See .env.example.`,
    );
  }
  return result.data as z.output<(typeof schemas)[S]>;
}
