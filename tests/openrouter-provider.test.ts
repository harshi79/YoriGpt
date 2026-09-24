import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { generateReply, streamReply, OPENROUTER_MAX_REPLY_CHARACTERS, MAX_KEY_ATTEMPTS } =
  await import("../src/server/ai/providers/openrouter");
const { AiNotConfiguredError, AiProviderError } = await import("../src/server/ai/errors");
const { resetKeyPools } = await import("../src/server/ai/key-pool");
const { MODEL_CATALOG, resetCatalogWarnings } = await import("../src/server/ai/models/catalog");

const KEY = "openrouter-test-key-not-a-secret";
const turns = [
  { role: "user" as const, content: "First question" },
  { role: "assistant" as const, content: "First answer" },
  { role: "user" as const, content: "Second question" },
];

/**
 * OPENROUTER_MODEL only names the *default* model; a call that passes a catalog key
 * always wins, and a call that passes nothing falls back to that default.
 */
function configure(overrides: { keys?: string; base?: string; model?: string } = {}) {
  vi.stubEnv("OPENROUTER_API_KEYS", overrides.keys ?? KEY);
  vi.stubEnv("OPENROUTER_BASE_URL", overrides.base ?? "https://openrouter.ai/api/v1");
  vi.stubEnv("OPENROUTER_MODEL", overrides.model ?? "");
}

/** Captures the request the adapter makes and replies with the given payload. */
function stubFetch(handler: (request: Request) => Promise<Response> | Response) {
  const calls: Request[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(String(input), init);
    calls.push(request);
    return handler(request);
  });
  return calls;
}

/** Awaits a call that should fail and returns the typed provider error. */
async function failureOf(run: Promise<unknown>): Promise<InstanceType<typeof AiProviderError>> {
  const caught = await run.then(
    () => null,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(AiProviderError);
  return caught as InstanceType<typeof AiProviderError>;
}

/** Runs a streamed call that is expected to fail and returns the typed error. */
async function collectFailure(
  run: () => Promise<void>,
): Promise<InstanceType<typeof AiProviderError>> {
  const caught = await run().then(
    () => null,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(AiProviderError);
  return caught as InstanceType<typeof AiProviderError>;
}

function completion(content: unknown, status = 200) {
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
    status,
  });
}

afterEach(() => {
  // The key pool keeps quarantine state per configured key list, so each case
  // starts from a clean rotation state rather than inheriting a cooldown.
  resetKeyPools();
  resetCatalogWarnings();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The key a stubbed request was signed with. */
function keyOf(request: Request): string {
  return (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
}

describe("OpenRouter request construction", () => {
  it("posts the conversation to the chat-completions endpoint with the configured model", async () => {
    configure();
    const calls = stubFetch(() => completion("  A stored reply.  "));

    await expect(generateReply(turns)).resolves.toBe("A stored reply.");

    expect(calls).toHaveLength(1);
    const request = calls[0];
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(request.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(request.headers.get("content-type")).toBe("application/json");

    const body = (await request.clone().json()) as {
      model: string;
      messages: unknown;
      stream: unknown;
    };
    expect(body.model).toBe("openai/gpt-4o-mini");
    expect(body.stream).toBe(false);
    // Roles map to the provider's vocabulary, in order, with no database fields.
    expect(body.messages).toEqual([
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "Second question" },
    ]);
    expect(JSON.stringify(body)).not.toContain("position");
    expect(JSON.stringify(body)).not.toContain("createdAt");
    // The adapter does not add pet metadata or instructions on its own. This direct
    // call supplied only conversation turns; the reply service prepends an instruction
    // when generating on behalf of an authenticated account.
    const sent = JSON.stringify(body);
    expect(Object.keys(body).sort()).toEqual(["messages", "model", "stream"]);
    for (const forbidden of [
      "pet",
      "personality",
      "companion",
      "traits",
      "restingState",
      "motionLevel",
      "uiPreferences",
      "selectedPetKey",
    ])
      expect(sent, forbidden).not.toContain(forbidden);
  });

  it("passes a prebuilt system message through JSON and streaming unchanged", async () => {
    configure();
    const instruction = "Answer accurately in a gentle tone.";
    const messages = [{ role: "system" as const, content: instruction }, ...turns];
    const calls = stubFetch((request) =>
      request.headers.get("accept") === "text/event-stream"
        ? streamedResponse([chunkFrame("ok"), STREAM_DONE])
        : completion("ok"),
    );

    await expect(generateReply(messages)).resolves.toBe("ok");
    await collect(streamReply(messages));

    expect(calls).toHaveLength(2);
    for (const request of calls) {
      const body = (await request.clone().json()) as { messages: unknown };
      expect(body.messages).toEqual(messages);
      expect(JSON.stringify(body)).not.toContain("uiPreferences");
    }
  });

  it("honours a configured base URL", async () => {
    configure({ base: "http://127.0.0.1:3210/api/v1/" });
    const calls = stubFetch(() => completion("ok"));

    await generateReply([{ role: "user", content: "Hi" }], { model: "gpt-4o" });

    expect(calls[0].url).toBe("http://127.0.0.1:3210/api/v1/chat/completions");
    expect(((await calls[0].clone().json()) as { model: string }).model).toBe("openai/gpt-4o");
  });

  it("resolves every OpenRouter catalog key to its identifier", async () => {
    configure();
    const calls = stubFetch(() => completion("ok"));
    const own = MODEL_CATALOG.filter((entry) => entry.active && entry.provider === "openrouter");
    expect(own.length).toBeGreaterThan(0);

    for (const model of own) {
      await generateReply([{ role: "user", content: "Hi" }], { model: model.key });
      expect(((await calls.at(-1)!.clone().json()) as { model: string }).model).toBe(
        model.modelIdentifier,
      );
    }
  });

  it("refuses a catalog key another provider serves, before any request", async () => {
    configure();
    const calls = stubFetch(() => completion("ok"));
    const foreign = MODEL_CATALOG.find((entry) => entry.active && entry.provider !== "openrouter");
    expect(foreign, "the catalog should offer a second provider").toBeDefined();

    // The dispatcher never routes a foreign key here, but the adapter refuses it on
    // its own too: a NVIDIA model can never be sent to OpenRouter, whatever picked
    // the key. Like an unknown key, this is a programming error rather than a
    // provider fault, so no key is spent and nothing is quarantined.
    const caught = await generateReply(turns, { model: foreign!.key }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      `Model key served by another provider: ${foreign!.key} (${foreign!.provider}, not openrouter)`,
    );
    expect(calls).toHaveLength(0);
  });

  it("uses the default model when the caller does not name one", async () => {
    configure();
    const calls = stubFetch(() => completion("ok"));

    await generateReply([{ role: "user", content: "Hi" }]);

    expect(((await calls[0].clone().json()) as { model: string }).model).toBe(
      "openai/gpt-4o-mini",
    );
    // With no preference stored, the configured default names the model.
    configure({ model: "anthropic/claude-3.7-sonnet" });
    await generateReply([{ role: "user", content: "Hi" }]);
    expect(((await calls[1].clone().json()) as { model: string }).model).toBe(
      "anthropic/claude-3.7-sonnet",
    );
  });

  it("refuses unknown, retired, and raw identifier values before any request", async () => {
    configure();
    const calls = stubFetch(() => completion("ok"));
    const inactive = MODEL_CATALOG.find((model) => !model.active)!;

    for (const model of [
      "not-a-model",
      inactive.key,
      "openai/gpt-4o", // a provider identifier is not a catalog key
      "",
      " ",
    ]) {
      // A model key that is not usable is a programming error, not a provider
      // failure: it is raised as-is so it can never be mistaken for a retryable
      // condition (no key is rotated, and nothing is quarantined).
      const caught = await generateReply(turns, { model }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(caught, model).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe("Unknown or inactive model key: " + model);
    }
    expect(calls).toHaveLength(0);
  });

  it("ignores a configured default that is not in the catalog, and never sends it", async () => {
    const warnings = vi.spyOn(console, "error").mockImplementation(() => {});
    configure({ model: "mock/yori-test" });
    const calls = stubFetch(() => completion("ok"));

    await generateReply([{ role: "user", content: "Hi" }]);

    const sent = JSON.stringify(await calls[0].clone().json());
    expect((JSON.parse(sent) as { model: string }).model).toBe("openai/gpt-4o-mini");
    expect(sent).not.toContain("mock/yori-test");
    expect(warnings.mock.calls.some((call) => String(call[0]).includes("OPENROUTER_MODEL"))).toBe(
      true,
    );
  });

  it("starts with the first configured key and round-robins across requests", async () => {
    configure({ keys: `${KEY},second-key` });
    const calls = stubFetch(() => completion("ok"));

    for (let request = 0; request < 3; request += 1) {
      await generateReply([{ role: "user", content: "Hi" }]);
    }

    // Consecutive requests spread across the configured keys instead of always
    // starting with the same one, and the rotation is deterministic.
    expect(calls.map(keyOf)).toEqual([KEY, "second-key", KEY]);
  });
});

describe("OpenRouter configuration errors", () => {
  it("fails with a controlled error and makes no request when no key is configured", async () => {
    vi.stubEnv("OPENROUTER_API_KEYS", "");
    const calls = stubFetch(() => completion("never"));

    const error = await generateReply(turns).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(AiNotConfiguredError);
    expect(calls).toEqual([]);
    expect((error as Error).message).toBe("AI replies are not configured on this server.");
    // Configuration details are for the server log, not for the browser.
    expect((error as Error).message).not.toContain("OPENROUTER");
    expect((error as Error).message).not.toContain(KEY);
  });
});

describe("OpenRouter failures", () => {
  it("reports a timeout", async () => {
    configure();
    vi.stubGlobal("fetch", (_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation timed out.", "TimeoutError")),
        );
      });
    });

    expect((await failureOf(generateReply(turns, { timeoutMs: 20 }))).reason).toBe("timeout");
  });

  it("reports a cancelled request separately from a timeout", async () => {
    configure();
    vi.stubGlobal("fetch", (_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      });
    });

    const controller = new AbortController();
    const pending = generateReply(turns, { signal: controller.signal, timeoutMs: 5_000 });
    controller.abort();

    expect((await failureOf(pending)).reason).toBe("aborted");
  });

  it("turns a non-2xx response into a safe error without the provider body", async () => {
    configure();
    stubFetch(
      () =>
        new Response(
          JSON.stringify({ error: { message: `invalid key ${KEY}`, code: 401 } }),
          { status: 401 },
        ),
    );

    const error = await failureOf(generateReply(turns));
    expect(error.reason).toBe("http-error");
    expect(error.status).toBe(401);
    // The provider response body is never forwarded or logged.
    expect(error.message).not.toContain(KEY);
    expect(error.message).not.toContain("invalid key");
  });

  it("refuses a 200 provider error even when it also contains assistant text", async () => {
    configure();
    stubFetch(() =>
      new Response(JSON.stringify({
        error: { message: `failed for ${KEY}` },
        choices: [{ message: { content: "Incomplete answer" }, finish_reason: "error" }],
      })),
    );

    const error = await failureOf(generateReply(turns));
    expect(error.reason).toBe("malformed-response");
    expect(JSON.stringify(error)).not.toContain(KEY);
  });

  it("treats malformed and empty responses as failures", async () => {
    configure();

    for (const payload of ["not json", JSON.stringify({ choices: [] }), JSON.stringify({}), JSON.stringify([1, 2])]) {
      stubFetch(() => new Response(payload, { status: 200 }));
      expect((await failureOf(generateReply(turns))).reason, payload).toBe("malformed-response");
    }

    stubFetch(() => new Response(JSON.stringify({ choices: [{ message: { content: 42 } }] })));
    expect((await failureOf(generateReply(turns))).reason).toBe("malformed-response");

    stubFetch(() => completion("   \n  "));
    expect((await failureOf(generateReply(turns))).reason).toBe("empty-response");
  });

  it("enforces the JSON size limit while reading, without buffering via Response.text", async () => {
    configure();
    const response = new Response(new Uint8Array(1_000_001));
    const readWholeBody = vi.spyOn(response, "text");
    stubFetch(() => response);

    expect((await failureOf(generateReply(turns))).reason).toBe("malformed-response");
    expect(readWholeBody).not.toHaveBeenCalled();
  });

  it("reports a network failure without leaking the key", async () => {
    configure();
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });

    const error = await failureOf(generateReply(turns));
    expect(error.reason).toBe("network-error");
    expect(String(error)).not.toContain(KEY);
  });

  it("does not retain a network cause that could echo the provider key", async () => {
    configure();
    vi.stubGlobal("fetch", async () => {
      throw new TypeError(`failed for ${KEY}`);
    });

    const error = await failureOf(generateReply(turns));
    expect(error.reason).toBe("network-error");
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain(KEY);
  });

  it("never puts the key in a provider error message", async () => {
    configure();
    stubFetch(() => new Response("", { status: 500 }));

    const error = await failureOf(generateReply(turns));
    expect(error.message).not.toContain(KEY);
    expect(JSON.stringify({ message: error.message, status: error.status })).not.toContain(KEY);
  });
});

describe("OpenRouter key rotation", () => {
  const FIRST = "rotation-first-key-not-a-secret";
  const SECOND = "rotation-second-key-not-a-secret";
  const THIRD = "rotation-third-key-not-a-secret";

  function configureKeys(...keys: string[]) {
    configure({ keys: keys.join(",") });
  }

  it("retries with the next key when the first one is rate limited", async () => {
    configureKeys(FIRST, SECOND);
    const calls = stubFetch((request) =>
      keyOf(request) === FIRST
        ? new Response(JSON.stringify({ error: { message: `rate limited key ${FIRST}` } }), {
            status: 429,
          })
        : completion("Answered by the second key"),
    );

    await expect(generateReply(turns)).resolves.toBe("Answered by the second key");
    expect(calls.map(keyOf)).toEqual([FIRST, SECOND]);

    // The rejected key is quarantined: the next request skips it entirely.
    calls.length = 0;
    await expect(generateReply(turns)).resolves.toBe("Answered by the second key");
    expect(calls.map(keyOf)).toEqual([SECOND]);
  });

  it("retries with the next key when the provider rejects the key", async () => {
    for (const status of [401, 403]) {
      resetKeyPools();
      configureKeys(FIRST, SECOND);
      const calls = stubFetch((request) =>
        keyOf(request) === FIRST
          ? new Response(JSON.stringify({ error: { message: `invalid key ${FIRST}` } }), {
              status,
            })
          : completion("Answered by the second key"),
      );

      await expect(generateReply(turns), String(status)).resolves.toBe(
        "Answered by the second key",
      );
      expect(calls.map(keyOf), String(status)).toEqual([FIRST, SECOND]);
    }
  });

  it("retries a provider-side failure with another key without quarantining it", async () => {
    configureKeys(FIRST, SECOND);
    const calls = stubFetch((request) =>
      keyOf(request) === FIRST
        ? new Response("", { status: 503 })
        : completion("Recovered on the second key"),
    );

    await expect(generateReply(turns)).resolves.toBe("Recovered on the second key");
    expect(calls.map(keyOf)).toEqual([FIRST, SECOND]);

    // A 5xx is not the key's fault, so the next request may start with it again.
    calls.length = 0;
    await generateReply(turns);
    expect(calls.map(keyOf)).toEqual([FIRST, SECOND]);
  });

  it("retries with another key after a network failure", async () => {
    configureKeys(FIRST, SECOND);
    const calls = stubFetch((request) => {
      if (keyOf(request) === FIRST) throw new TypeError("fetch failed");
      return completion("Answered anyway");
    });

    await expect(generateReply(turns)).resolves.toBe("Answered anyway");
    expect(calls.map(keyOf)).toEqual([FIRST, SECOND]);
  });

  it("does not rotate on a failure another key cannot fix", async () => {
    configureKeys(FIRST, SECOND);

    // A request the provider refuses as invalid.
    let calls = stubFetch(() => new Response("", { status: 400 }));
    expect((await failureOf(generateReply(turns))).status).toBe(400);
    expect(calls).toHaveLength(1);

    resetKeyPools();
    // An answer that arrived complete but unreadable.
    calls = stubFetch(() => new Response("not json", { status: 200 }));
    expect((await failureOf(generateReply(turns))).reason).toBe("malformed-response");
    expect(calls).toHaveLength(1);

    resetKeyPools();
    // A complete answer with no text in it.
    calls = stubFetch(() => completion("   \n "));
    expect((await failureOf(generateReply(turns))).reason).toBe("empty-response");
    expect(calls).toHaveLength(1);
  });

  it("does not rotate when the caller cancels", async () => {
    configureKeys(FIRST, SECOND);
    const attempted: string[] = [];
    vi.stubGlobal("fetch", (_input: RequestInfo | URL, init?: RequestInit) => {
      attempted.push((init?.headers as Record<string, string>)?.authorization ?? "");
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      });
    });

    const controller = new AbortController();
    const pending = generateReply(turns, { signal: controller.signal, timeoutMs: 5_000 });
    controller.abort();

    expect((await failureOf(pending)).reason).toBe("aborted");
    expect(attempted).toHaveLength(1);
    expect(attempted[0]).toBe(`Bearer ${FIRST}`);
  });

  it("stops after the bounded number of attempts", async () => {
    configureKeys(FIRST, SECOND, THIRD, "rotation-fourth-key", "rotation-fifth-key");
    const calls = stubFetch(() => new Response("", { status: 429 }));

    const error = await failureOf(generateReply(turns));

    expect(error.status).toBe(429);
    // Five configured keys never become five attempts, and no key is tried twice.
    expect(calls).toHaveLength(MAX_KEY_ATTEMPTS);
    expect(new Set(calls.map(keyOf)).size).toBe(MAX_KEY_ATTEMPTS);
  });

  it("fails with a controlled error while every key is cooling down", async () => {
    configureKeys(FIRST, SECOND);
    const calls = stubFetch(() => new Response("", { status: 429 }));

    expect((await failureOf(generateReply(turns))).status).toBe(429);
    expect(calls).toHaveLength(2);

    const error = await failureOf(generateReply(turns));
    expect(error.reason).toBe("http-error");
    // The status of the rejection that quarantined the keys is kept for the log and
    // for the error, never a key or a provider body.
    expect(error.status).toBe(429);
    expect(error.message).not.toContain(FIRST);
    // No key is eligible, so the request never reaches the provider at all.
    expect(calls).toHaveLength(2);
  });

  it("rotates before the first streamed delta", async () => {
    configureKeys(FIRST, SECOND);
    const calls = stubFetch((request) =>
      keyOf(request) === FIRST
        ? new Response("", { status: 429 })
        : streamedResponse([
            chunkFrame("From "),
            chunkFrame("the second key"),
            chunkFrame("", { finish_reason: "stop" }),
            STREAM_DONE,
          ]),
    );

    const deltas = await collect(streamReply(turns));
    expect(deltas.map((delta) => delta.text)).toEqual(["From ", "the second key"]);
    expect(calls.map(keyOf)).toEqual([FIRST, SECOND]);
  });

  it("does not switch keys once deltas have been delivered", async () => {
    configureKeys(FIRST, SECOND);
    const encoder = new TextEncoder();
    const calls = stubFetch((request) => {
      if (keyOf(request) === SECOND)
        return streamedResponse([chunkFrame("Should never be used"), STREAM_DONE]);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(chunkFrame("Half an answer")));
          },
          // Once the queued delta has been read, the connection breaks: a network
          // fault after the answer started is normally retryable, but it must be
          // reported here instead of restarting the reply on another key.
          pull(controller) {
            controller.error(new TypeError("terminated"));
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });

    const deltas: string[] = [];
    const failure = await collectFailure(async () => {
      for await (const chunk of streamReply(turns)) deltas.push(chunk.text);
    });

    expect(deltas).toEqual(["Half an answer"]);
    expect(failure.reason).toBe("network-error");
    expect(calls.map(keyOf)).toEqual([FIRST]);
  });

  it("keeps every key out of errors, logs, and streamed deltas", async () => {
    configureKeys(FIRST, SECOND);
    const logged: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });

    // The provider echoes both keys in its rejection body; nothing may forward them.
    const calls = stubFetch((request) =>
      keyOf(request) === FIRST
        ? new Response(
            JSON.stringify({ error: { message: `bad key ${FIRST}, also ${SECOND}` } }),
            { status: 401 },
          )
        : streamedResponse([
            chunkFrame("Safe answer"),
            chunkFrame("", { finish_reason: "stop" }),
            STREAM_DONE,
          ]),
    );

    const deltas = await collect(streamReply(turns));
    expect(deltas.map((delta) => delta.text)).toEqual(["Safe answer"]);
    expect(calls.map(keyOf)).toEqual([FIRST, SECOND]);

    const loggedText = JSON.stringify(logged);
    expect(loggedText).not.toContain(FIRST);
    expect(loggedText).not.toContain(SECOND);
    // Only safe classifications reach the log.
    expect(loggedText).toContain("401");
  });
});

/** One OpenAI-compatible stream chunk, with provider-only fields included. */
function chunkFrame(content: string, extra: Record<string, unknown> = {}) {
  return `data: ${JSON.stringify({
    id: "provider-chunk-id",
    object: "chat.completion.chunk",
    model: "provider-model-name",
    system_fingerprint: "provider-fingerprint",
    choices: [{ index: 0, delta: { content }, ...extra }],
  })}\n\n`;
}

const STREAM_DONE = "data: [DONE]\n\n";

/** A streamed response whose bytes arrive exactly in the given pieces. */
function streamedResponse(parts: (string | Uint8Array)[]) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(typeof part === "string" ? encoder.encode(part) : part);
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** Collects a streamed reply into its deltas. */
async function collect(stream: AsyncIterable<{ type: string; text: string }>) {
  const deltas: { type: string; text: string }[] = [];
  for await (const chunk of stream) deltas.push(chunk);
  return deltas;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("OpenRouter streaming requests", () => {
  it("asks for a stream and yields every delta in order", async () => {
    configure();
    const calls = stubFetch(() =>
      streamedResponse([
        chunkFrame("Hello"),
        chunkFrame(" there"),
        chunkFrame(", friend"),
        chunkFrame("", { finish_reason: "stop" }),
        STREAM_DONE,
      ]),
    );

    const deltas = await collect(streamReply(turns));

    expect(deltas).toEqual([
      { type: "delta", text: "Hello" },
      { type: "delta", text: " there" },
      { type: "delta", text: ", friend" },
    ]);

    const request = calls[0];
    expect(request.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(request.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(request.headers.get("accept")).toBe("text/event-stream");
    const body = (await request.clone().json()) as { stream: unknown; model: string };
    expect(body.stream).toBe(true);
    expect(body.model).toBe("openai/gpt-4o-mini");
  });

  it("delivers incremental text even when frames and characters are split across reads", async () => {
    configure();
    const encoder = new TextEncoder();
    // A frame cut in half, a CRLF pair split over two reads, a keep-alive comment,
    // an `event:` field, and a four-byte emoji split across two byte chunks.
    const emoji = "🙂";
    const emojiBytes = encoder.encode(emoji);
    stubFetch(() =>
      streamedResponse([
        ": keep-alive\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Par",
        "tial\"}}]}\r",
        "\n\r\ndata: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\" ",
        emojiBytes.slice(0, 2),
        emojiBytes.slice(2),
        "\"}}]}\n\n",
        "event: message\ndata: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        STREAM_DONE,
      ]),
    );

    const deltas = await collect(streamReply(turns));

    expect(deltas.map((delta) => delta.text).join("")).toBe(`Partial ${emoji}`);
  });

  it("keeps a CRLF split across reads inside one multi-line SSE frame", async () => {
    configure();
    stubFetch(() => streamedResponse([
      'data: {"choices":[{"delta":\r',
      '\ndata: {"content":"From one frame"}}]}\r\n\r\n',
      STREAM_DONE,
    ]));

    expect((await collect(streamReply(turns))).map((delta) => delta.text)).toEqual(["From one frame"]);
  });

  it("normalizes deltas so no provider field escapes the adapter", async () => {
    configure();
    stubFetch(() => streamedResponse([chunkFrame("A"), chunkFrame("B"), STREAM_DONE]));

    const deltas = await collect(streamReply(turns));

    for (const delta of deltas) expect(Object.keys(delta)).toEqual(["type", "text"]);
    const serialized = JSON.stringify(deltas);
    for (const leaked of [
      "provider-chunk-id",
      "provider-model-name",
      "provider-fingerprint",
      "system_fingerprint",
      "choices",
      "finish_reason",
    ])
      expect(serialized).not.toContain(leaked);
  });

  it("accepts a finish_reason as the completion marker when no [DONE] arrives", async () => {
    configure();
    stubFetch(() =>
      streamedResponse([chunkFrame("Complete "), chunkFrame("answer", { finish_reason: "stop" })]),
    );

    expect((await collect(streamReply(turns))).map((delta) => delta.text).join("")).toBe(
      "Complete answer",
    );
  });
});

describe("OpenRouter streaming failures", () => {
  it("does not turn an upstream error frame followed by [DONE] into a stored reply", async () => {
    configure({ keys: `${KEY},another-test-key` });
    const calls = stubFetch(() =>
      streamedResponse([
        chunkFrame("Provisional text"),
        `data: ${JSON.stringify({ error: { message: `failed for ${KEY}` } })}\n\n`,
        STREAM_DONE,
      ]),
    );
    const deltas: string[] = [];
    const error = await collectFailure(async () => {
      for await (const chunk of streamReply(turns)) deltas.push(chunk.text);
    });

    expect(deltas).toEqual(["Provisional text"]);
    expect(error.reason).toBe("malformed-response");
    expect(JSON.stringify(error)).not.toContain(KEY);
    expect(calls).toHaveLength(1); // never rotate after a delta
  });

  it("does not treat a finish_reason of error as successful completion", async () => {
    configure();
    stubFetch(() => streamedResponse([chunkFrame("Provisional"), chunkFrame("", { finish_reason: "error" })]));

    const error = await failureOf(collect(streamReply(turns)));
    expect(error.reason).toBe("malformed-response");
  });

  it("refuses to treat a stream without a completion marker as an answer", async () => {
    configure();
    stubFetch(() => streamedResponse([chunkFrame("Cut off halfway")]));

    expect((await failureOf(collect(streamReply(turns)))).reason).toBe("malformed-response");
  });

  it("treats malformed chunks, empty deltas, and plain JSON as failures", async () => {
    configure();

    stubFetch(() => streamedResponse(["data: {\"choices\":[{\"delta\":\n\n", STREAM_DONE]));
    expect((await failureOf(collect(streamReply(turns)))).reason).toBe("malformed-response");

    // Nothing but an empty delta and an empty completion: no assistant text.
    stubFetch(() =>
      streamedResponse([chunkFrame(""), chunkFrame("   "), chunkFrame("", { finish_reason: "stop" }), STREAM_DONE]),
    );
    expect((await failureOf(collect(streamReply(turns)))).reason).toBe("empty-response");

    // A provider that ignores `stream: true` and answers with JSON sends no frames.
    stubFetch(() => new Response(JSON.stringify({ choices: [{ message: { content: "Hi" } }] })));
    expect((await failureOf(collect(streamReply(turns)))).reason).toBe("malformed-response");
  });

  it("reports HTTP errors, network failures, timeouts, and cancellations", async () => {
    configure();

    stubFetch(() => new Response(`{"error":{"message":"bad key ${KEY}"}}`, { status: 429 }));
    const httpError = await failureOf(collect(streamReply(turns)));
    expect(httpError.reason).toBe("http-error");
    expect(httpError.status).toBe(429);
    expect(JSON.stringify(httpError)).not.toContain(KEY);

    // That rejection quarantined the only configured key; the scenarios below are
    // independent, so they start from a clean pool.
    resetKeyPools();
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    expect((await failureOf(collect(streamReply(turns)))).reason).toBe("network-error");

    // The provider accepts the request, then the connection breaks mid-stream.
    const encoder = new TextEncoder();
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(chunkFrame("Half an answer")));
              controller.error(new TypeError("terminated"));
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );
    expect((await failureOf(collect(streamReply(turns)))).reason).toBe("network-error");

    // The provider goes quiet: the adapter's own deadline stops the read.
    vi.stubGlobal(
      "fetch",
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(chunkFrame("Slow")));
              init?.signal?.addEventListener("abort", () =>
                controller.error(new DOMException("The operation was aborted.", "AbortError")),
              );
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );
    expect((await failureOf(collect(streamReply(turns, { timeoutMs: 20 })))).reason).toBe("timeout");

    // A caller abort is reported separately from the deadline.
    const controller = new AbortController();
    const pending = collect(streamReply(turns, { signal: controller.signal, timeoutMs: 5_000 }));
    controller.abort();
    expect((await failureOf(pending)).reason).toBe("aborted");

    // A disconnect can surface as a plain body failure (`TypeError: terminated`) even
    // though the caller is the one who cancelled: the signal decides the reason.
    const disconnected = new AbortController();
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new TypeError("terminated"));
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );
    disconnected.abort();
    const interrupted = collect(streamReply(turns, { signal: disconnected.signal }));
    expect((await failureOf(interrupted)).reason).toBe("aborted");
  });

  it("stops reading and cancels the provider stream when the consumer stops early", async () => {
    configure();
    let cancelled = false;
    const encoder = new TextEncoder();
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(chunkFrame("First")));
              controller.enqueue(encoder.encode(chunkFrame("Second")));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );

    // A caller that abandons the stream (a browser that navigated away) must not
    // leave the provider connection open.
    for await (const delta of streamReply(turns)) {
      expect(delta.text).toBe("First");
      break;
    }

    expect(cancelled).toBe(true);
  });

  it("cuts a runaway stream instead of accumulating it", async () => {
    configure();
    const huge = "x".repeat(OPENROUTER_MAX_REPLY_CHARACTERS + 1);
    stubFetch(() => streamedResponse([chunkFrame(huge), STREAM_DONE]));

    const error = await failureOf(collect(streamReply(turns)));
    expect(error.reason).toBe("too-long");
  });
});
