import "server-only";

/**
 * Server-only pool of provider API keys.
 *
 * The pool owns exactly two things: which key a request should try next, and which
 * keys are temporarily skipped because the provider rejected them. Nothing else in
 * the application selects keys, and the pool never logs, serializes, or hands a key
 * to anything except the adapter that signs the provider request with it.
 *
 * State is per process and in memory only — deliberately not database-backed. A
 * restart, or a redeploy with new credentials, begins with a clean pool and the
 * first configured key. Rotation is round-robin, so consecutive requests spread
 * across the configured keys instead of always starting with the first one, and a
 * key that was just rejected is skipped until its short cooldown expires.
 */

/**
 * How long a rejected key is skipped before it is eligible again. Short on purpose:
 * a rate limit is usually transient, and a one-key deployment must recover on its
 * own without a restart. Key rejection is the only thing that quarantines a key.
 */
export const KEY_COOLDOWN_MS = 30_000;

/** The surface the provider adapter needs. Deliberately tiny. */
export type KeyPool = {
  /** Number of configured keys; also the bound on how many keys one request may try. */
  readonly size: number;
  /** Status of the failure that most recently quarantined a key; diagnostics only. */
  readonly lastStatus: number | undefined;
  /**
   * The next eligible key in round-robin order, or `null` when every key is
   * cooling down. `exclude` holds the keys this request already tried — once a key
   * has failed for this request it is never offered again, so one request can never
   * hammer the same key.
   */
  select(options?: { exclude?: ReadonlySet<string> }): string | null;
  /**
   * Records a key-specific rejection (invalid or revoked key, rate limit) and
   * starts that key's cooldown. Cooling is tracked per key value, so a key that is
   * configured twice cools down once.
   */
  reportFailure(key: string, status?: number): void;
  /** Records a successful call, which clears any leftover cooldown for that key. */
  reportSuccess(key: string): void;
};

/** Builds an isolated pool; `now`/`cooldownMs` exist so tests need no real clock. */
export function createKeyPool(
  keys: readonly string[],
  options: { cooldownMs?: number; now?: () => number } = {},
): KeyPool {
  // Blank entries cannot sign a request; configuration is already normalized by
  // env.ts, and this keeps a directly constructed pool safe as well.
  const usable = keys.map((key) => key.trim()).filter((key) => key.length > 0);
  const cooldownMs = options.cooldownMs ?? KEY_COOLDOWN_MS;
  const now = options.now ?? Date.now;
  const coolingUntil = new Map<string, number>();
  let cursor = 0;
  let lastStatus: number | undefined;

  return {
    get size() {
      return usable.length;
    },

    get lastStatus() {
      return lastStatus;
    },

    select({ exclude } = {}) {
      const moment = now();
      for (let step = 0; step < usable.length; step += 1) {
        const index = (cursor + step) % usable.length;
        const key = usable[index];
        if (exclude?.has(key)) continue;
        if ((coolingUntil.get(key) ?? 0) > moment) continue;
        // The cursor moves past the key that was handed out, so the next request
        // starts with its neighbour.
        cursor = (index + 1) % usable.length;
        return key;
      }
      return null;
    },

    reportFailure(key, status) {
      coolingUntil.set(key, now() + cooldownMs);
      if (status !== undefined) lastStatus = status;
    },

    reportSuccess(key) {
      coolingUntil.delete(key);
    },
  };
}

/**
 * Pools are cached per configured key list so that a cooldown survives between
 * requests, which is the whole point of quarantining a key. A different key list
 * (a redeploy, or a test that stubs new values) gets its own pool.
 */
const pools = new Map<string, KeyPool>();

export function getKeyPool(keys: readonly string[]): KeyPool {
  const signature = keys.join("\u0000");
  const cached = pools.get(signature);
  if (cached) return cached;

  const pool = createKeyPool(keys);
  pools.set(signature, pool);
  return pool;
}

/**
 * Forgets every cached pool, so the next request starts from a clean rotation
 * state. Tests call this between cases to stay deterministic; a running server
 * keeps its pool for the lifetime of the process.
 */
export function resetKeyPools(): void {
  pools.clear();
}
