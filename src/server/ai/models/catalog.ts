import "server-only";
import { getConfiguredModelName } from "../../env";

/**
 * The server-owned model catalog: the only place that decides which models exist,
 * which are offered, which provider serves each one, and what provider identifier
 * each one maps to.
 *
 * The browser never names a provider model, and it never names a provider either.
 * It sends a catalog **key**; the server checks that key against this list, the
 * entry's `provider` selects the adapter, and the identifier that reaches that
 * provider is read from here — so an arbitrary model string cannot be smuggled into
 * a request, a client cannot aim a request at a provider of its own choosing, and a
 * model can be retired by flipping `active` without touching the UI or the database.
 *
 * The keys are also the `ai_models.id` values the seed migrations insert, which is
 * what `user_preferences.preferredModelId` references. Keeping the catalog in code
 * (rather than reading the table) means the application boots, renders, and replies
 * with its configured default without a database round trip for model metadata.
 */

/**
 * The providers this deployment can answer with, in code terms. Each one has an
 * adapter under `src/server/ai/providers`, and the value is the lowercase form of
 * the `ModelProvider` enum the seeded rows store.
 */
export type ModelProviderName = "openrouter" | "nvidia";

export type CatalogModel = {
  /** Stable internal key: used by the API, by preferences, and as the seeded row id. */
  key: string;
  /** Which provider serves this entry; the dispatcher maps it to an adapter. */
  provider: ModelProviderName;
  /** The provider's model identifier. Only this module may produce one. */
  modelIdentifier: string;
  /** Display name shown in the selector. */
  name: string;
  /** One short line describing when to pick this model. */
  description: string;
  /** Inactive models are kept for stored preferences but can never be selected. */
  active: boolean;
};

/**
 * Small and explicit: the models this deployment offers. Adding one is a code
 * change plus a seeded row (see `prisma/migrations/*_seed_ai_models*`), never a
 * client-supplied identifier. Entries of one provider are grouped together, and a
 * new provider's models are appended after the incumbent ones so that lookups that
 * scan the catalog in order keep returning the same entry they always did.
 */
export const MODEL_CATALOG: readonly CatalogModel[] = [
  {
    key: "gpt-4o-mini",
    provider: "openrouter",
    modelIdentifier: "openai/gpt-4o-mini",
    name: "GPT-4o mini",
    description: "Fast and inexpensive; the default for everyday replies.",
    active: true,
  },
  {
    key: "gpt-4o",
    provider: "openrouter",
    modelIdentifier: "openai/gpt-4o",
    name: "GPT-4o",
    description: "Stronger general reasoning for longer or trickier questions.",
    active: true,
  },
  {
    key: "claude-3.5-haiku",
    provider: "openrouter",
    modelIdentifier: "anthropic/claude-3.5-haiku",
    name: "Claude 3.5 Haiku",
    description: "Quick, concise answers with a different writing style.",
    active: true,
  },
  {
    key: "claude-3.7-sonnet",
    provider: "openrouter",
    modelIdentifier: "anthropic/claude-3.7-sonnet",
    name: "Claude 3.7 Sonnet",
    description: "Careful, detailed answers for harder problems.",
    active: true,
  },
  {
    key: "llama-3.1-70b",
    provider: "openrouter",
    modelIdentifier: "meta-llama/llama-3.1-70b-instruct",
    name: "Llama 3.1 70B",
    description: "No longer offered; kept only so a stored preference can be resolved.",
    active: false,
  },
  {
    // NVIDIA NIM hosts this model under Meta's namespace. Deliberately the only
    // NVIDIA entry: a small catalog that is verified against NVIDIA's published
    // endpoint list beats a dump of every identifier they advertise.
    key: "nvidia-llama-3.3-70b",
    provider: "nvidia",
    modelIdentifier: "meta/llama-3.3-70b-instruct",
    name: "Llama 3.3 70B",
    description: "Open-weight instruction model for everyday replies.",
    active: true,
  },
];

/**
 * Used when nothing is configured and no preference exists. Must stay in the
 * catalog, and stays an OpenRouter model so an existing deployment keeps answering
 * through the provider it was configured with.
 */
export const DEFAULT_MODEL_KEY = "gpt-4o-mini";

const byKey = new Map(MODEL_CATALOG.map((model) => [model.key, model]));
// An identifier may be hosted by two providers. `OPENROUTER_MODEL` predates that
// choice, so the first (incumbent) entry wins if an identifier is shared; a newer
// provider can always be selected unambiguously by its own catalog key.
const byIdentifier = new Map<string, CatalogModel>();
for (const model of MODEL_CATALOG) {
  if (!byIdentifier.has(model.modelIdentifier)) byIdentifier.set(model.modelIdentifier, model);
}

/** The catalog entry for a key, active or not; `null` when the key is unknown. */
export function findCatalogModel(key: unknown): CatalogModel | null {
  return typeof key === "string" ? (byKey.get(key) ?? null) : null;
}

/** A model the current user is allowed to select and generate with. */
export function isSelectableModelKey(key: unknown): boolean {
  return findCatalogModel(key)?.active === true;
}

/** The active models a signed-in user can choose, in catalog order. */
export function listSelectableModels(): CatalogModel[] {
  return MODEL_CATALOG.filter((model) => model.active);
}

/**
 * The active catalog entry behind a key. Unknown and retired keys throw, so nothing
 * downstream has to re-check that a key is usable. The key is application data, not
 * a credential, and is safe to log.
 */
export function resolveCatalogEntry(key: unknown): CatalogModel {
  const model = findCatalogModel(key);
  if (!model || !model.active) {
    throw new Error(`Unknown or inactive model key: ${String(key)}`);
  }
  return model;
}

/**
 * The provider identifier for a catalog **key**, as asked for by one adapter. This
 * is the only function that hands an identifier to a provider, so a request can
 * carry nothing else: an unknown or inactive key throws instead of reaching the
 * network, and so does a key another provider serves — an OpenRouter request can
 * never be aimed at a NVIDIA model, or the other way round, no matter which layer
 * picked the key.
 *
 * `provider` defaults to OpenRouter, the incumbent, so an adapter that forgets to
 * name itself fails loudly instead of silently borrowing another provider's model.
 */
export function resolveCatalogIdentifier(
  key: unknown,
  provider: ModelProviderName = "openrouter",
): string {
  const model = resolveCatalogEntry(key);
  if (model.provider !== provider) {
    throw new Error(
      `Model key served by another provider: ${String(key)} (${model.provider}, not ${provider})`,
    );
  }
  return model.modelIdentifier;
}

/**
 * The model used when a user has no saved preference.
 *
 * `OPENROUTER_MODEL` still works: when it names a model in the catalog (by
 * identifier, or by key for convenience) that entry becomes the default; anything
 * else — including a retired model or a typo — falls back to the catalog default
 * instead of being sent to the provider. Nothing here reads a credential, so pages
 * can resolve the default before provider keys are configured.
 *
 * The variable predates multi-provider support but is resolved through the catalog,
 * so it names the deployment's default **catalog** model whichever provider serves
 * it. A deployment that only configures NVIDIA keys can therefore point it at a
 * NVIDIA entry; an unset value keeps the OpenRouter default that shipped first.
 */
export function defaultModelKey(): string {
  const configured = getConfiguredModelName();
  if (!configured) return DEFAULT_MODEL_KEY;

  const known = byIdentifier.get(configured) ?? byKey.get(configured);
  if (known?.active) return known.key;

  warnOnce(configured, `[models] OPENROUTER_MODEL "${configured}" is not an active catalog model; using "${DEFAULT_MODEL_KEY}".`);
  return DEFAULT_MODEL_KEY;
}

/**
 * A stored preference is only usable while it still names an active model. An
 * unknown key (a catalog entry that was removed) or a retired one (deactivated)
 * resolves to the documented default, so generation keeps working and history is
 * untouched; callers can log the fact that the fallback happened.
 */
export function resolveStoredModelKey(stored: string | null | undefined): {
  key: string;
  usedFallback: boolean;
} {
  const model = findCatalogModel(stored);
  if (model?.active) return { key: model.key, usedFallback: false };
  return { key: defaultModelKey(), usedFallback: stored !== null && stored !== undefined };
}

/** One warning per distinct configured value, so a typo cannot spam the log. */
const warnedValues = new Set<string>();

function warnOnce(value: string, message: string): void {
  if (warnedValues.has(value)) return;
  warnedValues.add(value);
  console.error(message);
}

/** Test helper: forgets the warn-once memo so a case starts from a clean log. */
export function resetCatalogWarnings(): void {
  warnedValues.clear();
}
