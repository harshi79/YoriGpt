import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { KEY_COOLDOWN_MS, createKeyPool, getKeyPool, resetKeyPools } = await import(
  "../src/server/ai/key-pool"
);

const A = "pool-key-a-not-a-secret";
const B = "pool-key-b-not-a-secret";
const C = "pool-key-c-not-a-secret";

afterEach(() => {
  resetKeyPools();
});

describe("key pool selection", () => {
  it("serves a single configured key and cools it down after a rejection", () => {
    let clock = 1_000;
    const pool = createKeyPool([A], { cooldownMs: 5_000, now: () => clock });

    expect(pool.size).toBe(1);
    expect(pool.select()).toBe(A);
    // A success keeps it eligible.
    pool.reportSuccess(A);
    expect(pool.select()).toBe(A);

    pool.reportFailure(A, 429);
    expect(pool.select()).toBeNull();
    expect(pool.lastStatus).toBe(429);

    // Still cooling one millisecond before the window ends…
    clock += 4_999;
    expect(pool.select()).toBeNull();

    // …and eligible again once it has passed.
    clock += 1;
    expect(pool.select()).toBe(A);
  });

  it("rotates through several keys in order and wraps around", () => {
    const pool = createKeyPool([A, B, C]);

    expect([pool.select(), pool.select(), pool.select(), pool.select()]).toEqual([
      A,
      B,
      C,
      A,
    ]);
  });

  it("skips a key while it is cooling down and keeps the others rotating", () => {
    let clock = 0;
    const pool = createKeyPool([A, B, C], { cooldownMs: 1_000, now: () => clock });

    expect(pool.select()).toBe(A);
    pool.reportFailure(A, 429);
    expect(pool.select()).toBe(B);
    pool.reportFailure(B, 401);
    expect(pool.select()).toBe(C);

    // Both rejected keys are skipped, and A becomes eligible again after its window.
    clock += 1_000;
    expect([pool.select(), pool.select()]).toEqual([A, B]);
  });

  it("never offers a key the caller has already tried", () => {
    const pool = createKeyPool([A, B, C]);
    const tried = new Set([A]);

    expect(pool.select({ exclude: tried })).toBe(B);
    tried.add(B);
    expect(pool.select({ exclude: tried })).toBe(C);
    tried.add(C);
    expect(pool.select({ exclude: tried })).toBeNull();
  });

  it("returns null when every key is cooling down", () => {
    const pool = createKeyPool([A, B], { cooldownMs: 60_000 });

    pool.reportFailure(A, 429);
    pool.reportFailure(B, 429);

    expect(pool.select()).toBeNull();
    // The reason for the quarantine is kept for diagnostics, never a key or a body.
    expect(pool.lastStatus).toBe(429);
  });

  it("clears a cooldown when the same key succeeds", () => {
    const pool = createKeyPool([A], { cooldownMs: 60_000 });

    pool.reportFailure(A, 401);
    expect(pool.select()).toBeNull();

    pool.reportSuccess(A);
    expect(pool.select()).toBe(A);
  });

  it("cools a duplicated key once, so it is never retried as a second key", () => {
    const pool = createKeyPool([A, A], { cooldownMs: 60_000 });

    expect(pool.size).toBe(2);
    pool.reportFailure(A, 429);

    expect(pool.select()).toBeNull();
  });

  it("uses the documented cooldown window by default", () => {
    let clock = 0;
    const pool = createKeyPool([A], { now: () => clock });

    pool.reportFailure(A, 429);
    clock += KEY_COOLDOWN_MS - 1;
    expect(pool.select()).toBeNull();
    clock += 1;
    expect(pool.select()).toBe(A);
  });
});

describe("key pool configuration", () => {
  it("treats a missing, blank, or whitespace-only list as no usable key", () => {
    for (const keys of [[], [""], ["   "], ["", " "]]) {
      const pool = createKeyPool(keys);
      expect(pool.size, JSON.stringify(keys)).toBe(0);
      expect(pool.select(), JSON.stringify(keys)).toBeNull();
    }
  });

  it("trims configured keys and ignores blank entries", () => {
    const pool = createKeyPool([" " + A + " ", "", B]);

    expect(pool.size).toBe(2);
    expect([pool.select(), pool.select()]).toEqual([A, B]);
  });

  it("isolates NVIDIA cooldown and rotation even with identical configured keys", () => {
    const openrouter = getKeyPool([A, B]);
    const nvidia = getKeyPool([A, B], "nvidia");
    expect(nvidia).not.toBe(openrouter);
    expect(getKeyPool([A, B], "nvidia")).toBe(nvidia);

    // NVIDIA rejects a key. The OpenRouter pool still starts at its own first
    // key, has no rejection status, and continues independently.
    expect(nvidia.select()).toBe(A);
    nvidia.reportFailure(A, 401);
    expect(nvidia.select()).toBe(B);
    expect(openrouter.lastStatus).toBeUndefined();
    expect(openrouter.select()).toBe(A);

    // A rejection in the incumbent pool cannot reset or change NVIDIA's state.
    openrouter.reportFailure(B, 429);
    expect(openrouter.select()).toBe(A);
    expect(nvidia.lastStatus).toBe(401);
    expect(nvidia.select()).toBe(B);

    resetKeyPools();
    expect(getKeyPool([A, B])).not.toBe(openrouter);
    expect(getKeyPool([A, B], "nvidia")).not.toBe(nvidia);
  });

  it("reuses one pool per configured key list and forgets it on reset", () => {
    const first = getKeyPool([A, B]);

    expect(getKeyPool([A, B])).toBe(first);
    expect(getKeyPool([A])).not.toBe(first);

    // Quarantine state lives in the cached pool…
    first.reportFailure(A, 429);
    expect(getKeyPool([A, B]).select()).toBe(B);

    // …and a reset starts from a clean rotation state.
    resetKeyPools();
    expect(getKeyPool([A, B])).not.toBe(first);
    expect(getKeyPool([A, B]).select()).toBe(A);
  });
});
