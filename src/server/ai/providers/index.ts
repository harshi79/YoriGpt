import "server-only";
import {
  defaultModelKey,
  resolveCatalogEntry,
  type ModelProviderName,
} from "../models/catalog";
import type { ReplyProvider } from "../types";
import { nvidiaProvider } from "./nvidia";
import { openRouterProvider } from "./openrouter";

/**
 * Provider dispatch: the single route from a model key to the adapter that will
 * answer with it.
 *
 * The order is fixed and one-directional — a catalog **key** names an entry, the
 * entry names its provider, the provider names an adapter — so nothing else in the
 * application can choose a provider. A browser sends only a key (validated by
 * `parseModelSelectionRequest`, stored per account, re-checked against the catalog);
 * the reply service hands that key here; and the adapter that comes back resolves
 * the provider identifier itself. There is no request field, no header, and no
 * client-side state that can make a request go to NVIDIA instead of OpenRouter.
 *
 * Adding a provider is therefore: an entry in `MODEL_CATALOG` with its `provider`,
 * an adapter file, one line in `PROVIDERS` below, and a seeded `ai_models` row.
 * The record is typed by `ModelProviderName`, so a catalog entry whose provider has
 * no adapter is a compile error rather than a runtime surprise.
 */

/** Every provider the catalog may name, mapped to the adapter that implements it. */
const PROVIDERS: Record<ModelProviderName, ReplyProvider> = {
  openrouter: openRouterProvider,
  nvidia: nvidiaProvider,
};

/**
 * The adapter that should answer for one catalog key. `undefined` means the
 * deployment default, exactly as an adapter that receives no `model` option would.
 *
 * A key the catalog does not offer — unknown, retired, or a raw provider identifier
 * a caller tried to smuggle in — throws here, before any adapter is picked and
 * before any credential is read. That keeps the failure what it always was: a
 * programming or request-validation error, never a retryable provider fault, so it
 * cannot burn a key or look like an outage.
 */
export function resolveReplyProvider(modelKey?: string): ReplyProvider {
  return PROVIDERS[resolveCatalogEntry(modelKey ?? defaultModelKey()).provider];
}
