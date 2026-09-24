import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  generateReply,
  streamReply,
  nvidiaProvider,
  NVIDIA_MAX_KEY_ATTEMPTS,
  NVIDIA_MAX_REPLY_CHARACTERS,
  NVIDIA_TIMEOUT_MS,
} = await import("../src/server/ai/providers/nvidia");
const { AiNotConfiguredError, AiProviderError } = await import("../src/server/ai/errors");
const { generateReply: generateOpenRouter } = await import("../src/server/ai/providers/openrouter");
const { resetKeyPools } = await import("../src/server/ai/key-pool");
const { MODEL_CATALOG, resetCatalogWarnings } = await import("../src/server/ai/models/catalog");
type Options = { signal?: AbortSignal; timeoutMs?: number; model?: string };

const KEY = "nvidia-test-key-not-a-secret";
const BASE = "https://integrate.api.nvidia.com/v1";
const turns = [
  { role: "user" as const, content: "First question" },
  { role: "assistant" as const, content: "First answer" },
  { role: "user" as const, content: "Second question" },
];

/** The catalog entries this adapter is allowed to serve, and one it is not. */
const NVIDIA_MODELS = MODEL_CATALOG.filter((entry) => entry.provider === "nvidia");
const NVIDIA_MODEL = NVIDIA_MODELS.find((entry) => entry.active)!;
const FOREIGN_MODEL = MODEL_CATALOG.find(
  (entry) => entry.active && entry.provider !== "nvidia",
)!;

/**
 * Every call names its catalog key, because the adapter serves NVIDIA models only:
 * the deployment default is an OpenRouter entry, so an unnamed model is refused
 * (covered by its own case below) rather than silently sent to NVIDIA.
 */
function withModel(options: Options = {}): Options {
  return { ...options, model: NVIDIA_MODEL.key };
}

/** NVIDIA credentials only. `OPENROUTER_*` stays whatever the test set it to. */
function configure(overrides: { keys?: string; base?: string; model?: string } = {}) {
  vi.stubEnv("NVIDIA_API_KEYS", overrides.keys ?? KEY);
  vi.stubEnv("NVIDIA_BASE_URL", overrides.base ?? BASE);
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
  run: () => Promise<unknown>,
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

/** The key a stubbed request was signed with. */
function keyOf(request: Request): string {
  return (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
}

/** Captures everything the adapter writes to the server log. */
function captureLogs(): string[] {
  const lines: string[] = [];
  for (const method of ["error", "warn", "log"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
  }
  return lines;
}

afterEach(() => {
  // The key pool keeps quarantine state per provider and key list, so each case
  // starts from a clean rotation state rather than inheriting a cooldown.
  resetKeyPools();
  resetCatalogWarnings();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("NVIDIA request construction", () => {
  it("posts the conversation to the NVIDIA chat-completions endpoint", async () => {
    configure();
    const calls = stubFetch(() => completion("  A stored reply.  "));

    await expect(generateReply(turns, withModel())).resolves.toBe("A stored reply.");

    expect(calls).toHaveLength(1);
    const request = calls[0];
    expect(request.method).toBe("POST");
    expect(request.url).toBe(`${BASE}/chat/completions`);
    expect(request.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.headers.get("accept")).toBe("application/json");
    // OpenRouter's attribution header is that provider's own convention; nothing
    // application-specific is sent to NVIDIA.
    expect(request.headers.get("x-title")).toBeNull();

    const body = (await request.clone().json()) as {
      model: string;
      messages: unknown;
      stream: unknown;
    };
    expect(body.model).toBe(NVIDIA_MODEL.modelIdentifier);
    expect(body.stream).toBe(false);
    // Roles map to the provider's vocabulary, in order, with no database fields.
    expect(body.messages).toEqual([
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "Second question" },
    ]);

    const sent = JSON.stringify(body);
    expect(Object.keys(body).sort()).toEqual(["messages", "model", "stream"]);
    expect(sent).not.toContain("position");
    expect(sent).not.toContain("createdAt");
    // The adapter adds no pet metadata or instructions on its own. This direct
    // call supplied only conversation turns; the reply service prepends an instruction
    // when generating on behalf of an authenticated account.
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

    await expect(generateReply(messages, withModel())).resolves.toBe("ok");
    await collect(streamReply(messages, withModel()));

    expect(calls).toHaveLength(2);
    for (const request of calls) {
      const body = (await request.clone().json()) as { messages: unknown };
      expect(body.messages).toEqual(messages);
      expect(JSON.stringify(body)).not.toContain("uiPreferences");
    }
  });

  it("asks for a server-sent-event stream when streaming", async () => {
    configure();
    const calls = stubFetch(() => streamedResponse([chunkFrame("Hi"), STREAM_DONE]));

    await collect(streamReply(turns, withModel()));

    expect(calls).toHaveLength(1);
    expect(calls[0].headers.get("accept")).toBe("text/event-stream");
    expect(((await calls[0].clone().json()) as { stream: boolean }).stream).toBe(true);
  });

  it("honours a configured base URL", async () => {
    configure({ base: "http://127.0.0.1:3211/nvidia/v1/" });
    const calls = stubFetch(() => completion("ok"));

    await generateReply([{ role: "user", content: "Hi" }], withModel());

    expect(calls[0].url).toBe("http://127.0.0.1:3211/nvidia/v1/chat/completions");
    expect(((await calls[0].clone().json()) as { model: string }).model).toBe(
      NVIDIA_MODEL.modelIdentifier,
    );
  });

  it("resolves every NVIDIA catalog key to its NVIDIA identifier", async () => {
    configure();
    const calls = stubFetch(() => completion("ok"));
    const own = NVIDIA_MODELS.filter((entry) => entry.active);
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
    const calls = stubFetch(() => completion("never"));
    expect(FOREIGN_MODEL, "the catalog should offer a second provider").toBeDefined();

    // The dispatcher never routes a foreign key here, but the adapter refuses it on
    // its own too: an OpenRouter model can never be sent to NVIDIA, whatever picked
    // the key. It is a programming error, not a provider fault, so no key is spent.
    const caught = await generateReply(turns, { model: FOREIGN_MODEL.key }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(AiProviderError);
    expect((caught as Error).message).toBe(
      `Model key served by another provider: ${FOREIGN_MODEL.key} (${FOREIGN_MODEL.provider}, not nvidia)`,
    );
    expect(calls).toHaveLength(0);
  });

  it("refuses the OpenRouter deployment default instead of guessing a model", async () => {
    configure();
    const calls = stubFetch(() => completion("never"));

    // No `model` option means the catalog default, which is an OpenRouter entry.
    const caught = await generateReply(turns).then(
      () => null,
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/served by another provider/);
    expect(calls).toHaveLength(0);
  });

  it("uses a configured NVIDIA default when a deployment names one", async () => {
    configure({ model: NVIDIA_MODEL.modelIdentifier });
    const calls = stubFetch(() => completion("ok"));

    await generateReply([{ role: "user", content: "Hi" }]);

    expect(((await calls[0].clone().json()) as { model: string }).model).toBe(
      NVIDIA_MODEL.modelIdentifier,
    );
  });

  it("refuses unknown, retired, and raw identifier values before any request", async () => {
    configure();
    const calls = stubFetch(() => completion("never"));
    const inactive = MODEL_CATALOG.find((model) => !model.active)!;

    for (const model of [
      "not-a-model",
      inactive.key,
      NVIDIA_MODEL.modelIdentifier, // a provider identifier is not a catalog key
      "",
      " ",
    ]) {
      const caught = await generateReply(turns, { model }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(caught, model).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe("Unknown or inactive model key: " + model);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("NVIDIA configuration errors", () => {
  it("fails with a controlled error and makes no request when no key is configured", async () => {
    vi.stubEnv("NVIDIA_API_KEYS", "");
    const calls = stubFetch(() => completion("never"));

    const error = await generateReply(turns, withModel()).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(AiNotConfiguredError);
    expect(calls).toEqual([]);
    expect((error as Error).message).toBe("AI replies are not configured on this server.");
    // Configuration details are for the server log, not for the browser.
    expect((error as Error).message).not.toContain("NVIDIA");
    expect((error as Error).message).not.toContain(KEY);
  });

  it("never borrows the OpenRouter credentials", async () => {
    const OPENROUTER_KEY = "openrouter-test-key-not-a-secret";
    vi.stubEnv("OPENROUTER_API_KEYS", OPENROUTER_KEY);
    vi.stubEnv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1");
    vi.stubEnv("NVIDIA_API_KEYS", "");
    const calls = stubFetch(() => completion("never"));

    // A working OpenRouter configuration does not make NVIDIA usable.
    await expect(generateReply(turns, withModel())).rejects.toBeInstanceOf(AiNotConfiguredError);
    await expect(collect(streamReply(turns, withModel()))).rejects.toBeInstanceOf(
      AiNotConfiguredError,
    );
    expect(calls).toEqual([]);

    // And with both configured, only the NVIDIA key ever signs a NVIDIA request.
    resetKeyPools();
    configure();
    await generateReply(turns, withModel());
    expect(calls.map(keyOf)).toEqual([KEY]);
    expect(calls.map(keyOf)).not.toContain(OPENROUTER_KEY);
  });
});

describe("NVIDIA non-streaming replies", () => {
  it("returns only the assistant text and ignores everything else in the payload", async () => {
    configure();
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            id: "provider-response-id",
            object: "chat.completion",
            model: "provider-model-name",
            usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "  Only this text.  " },
                finish_reason: "stop",
              },
            ],
          }),
        ),
    );

    await expect(generateReply(turns, withModel())).resolves.toBe("Only this text.");
  });

  it("reports a payload without assistant text as malformed", async () => {
    configure();

    for (const payload of [
      {},
      { choices: [] },
      { choices: [{}] },
      { choices: [{ message: {} }] },
      { choices: [{ message: { content: null } }] },
      { choices: [{ message: { content: 42 } }] },
      "not json at all",
    ]) {
      stubFetch(
        () =>
          new Response(typeof payload === "string" ? payload : JSON.stringify(payload), {
            status: 200,
          }),
      );
      expect(
        (await failureOf(generateReply(turns, withModel()))).reason,
        JSON.stringify(payload),
      ).toBe("malformed-response");
    }
  });

  it("refuses an upstream error even if it also includes an assistant message", async () => {
    configure();
    const logs = captureLogs();
    const sensitive = "upstream-test-value-not-a-secret";

    for (const payload of [
      { error: { message: `failed: ${sensitive}` }, choices: [{ message: { content: "Partial" } }] },
      { choices: [{ message: { content: "Partial" }, finish_reason: "error" }] },
    ]) {
      stubFetch(() => new Response(JSON.stringify(payload)));
      expect((await failureOf(generateReply(turns, withModel()))).reason).toBe(
        "malformed-response",
      );
    }
    expect(logs.join("\n")).not.toContain(sensitive);
  });

  it("never retains an echoed key in errors or logs when upstream JSON is malformed", async () => {
    configure();
    const logs = captureLogs();

    stubFetch(() => new Response(`{broken JSON echoing ${KEY}`));
    const jsonError = await failureOf(generateReply(turns, withModel()));
    expect(jsonError.reason).toBe("malformed-response");
    expect(jsonError.message).not.toContain(KEY);
    expect(jsonError.cause).toBeUndefined();

    stubFetch(() => streamedResponse([`data: {broken JSON echoing ${KEY}\n\n`, STREAM_DONE]));
    const streamError = await collectFailure(() => collect(streamReply(turns, withModel())));
    expect(streamError.reason).toBe("malformed-response");
    expect(streamError.message).not.toContain(KEY);
    expect(streamError.cause).toBeUndefined();
    expect(logs.join("\n")).not.toContain(KEY);
  });

  it("reports an empty answer as empty, not as text", async () => {
    configure();

    for (const content of ["", "   ", "\n\t "]) {
      stubFetch(() => completion(content));
      expect((await failureOf(generateReply(turns, withModel()))).reason).toBe("empty-response");
    }
  });

  it("refuses an oversized answer instead of accumulating it", async () => {
    configure();
    // A body far past the accepted size is reported before it is parsed.
    stubFetch(() => completion("x".repeat(1_000_001)));

    expect((await failureOf(generateReply(turns, withModel()))).reason).toBe("malformed-response");
  });
});

describe("NVIDIA failures", () => {
  it("reports a timeout", async () => {
    configure();
    vi.stubGlobal("fetch", (_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation timed out.", "TimeoutError")),
        );
      });
    });

    expect(NVIDIA_TIMEOUT_MS).toBeGreaterThan(0);
    expect((await failureOf(generateReply(turns, withModel({ timeoutMs: 20 })))).reason).toBe(
      "timeout",
    );
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
    const pending = generateReply(turns, withModel({ signal: controller.signal, timeoutMs: 5_000 }));
    controller.abort();

    expect((await failureOf(pending)).reason).toBe("aborted");
  });

  it("does not send or retry a request for a caller that has already left", async () => {
    configure({ keys: [KEY, "second-key-not-a-secret"].join(",") });
    const stopped = new AbortController();
    stopped.abort();
    const calls = stubFetch(() => completion("never"));

    expect((await failureOf(generateReply(turns, withModel({ signal: stopped.signal })))).reason).toBe(
      "aborted",
    );
    expect(
      (await collectFailure(() => collect(streamReply(turns, withModel({ signal: stopped.signal }))))).reason,
    ).toBe("aborted");
    expect(calls).toHaveLength(0);
  });

  it("does not treat a late HTTP rejection as a key failure after an abort", async () => {
    configure({ keys: [KEY, "second-key-not-a-secret"].join(",") });
    const stopped = new AbortController();
    const calls = stubFetch(() => {
      stopped.abort();
      return new Response("", { status: 401 });
    });

    const error = await failureOf(generateReply(turns, withModel({ signal: stopped.signal })));
    expect(error.reason).toBe("aborted");
    expect(calls).toHaveLength(1); // no second key was tried
  });

  it("turns a non-2xx response into a status-only error without the provider body", async () => {
    const logs = captureLogs();
    configure();

    for (const status of [400, 401, 403, 404, 422, 429, 500, 502, 503, 504]) {
      resetKeyPools();
      stubFetch(
        () =>
          new Response(
            // NVIDIA error bodies can name the account and echo the request; none of
            // it may reach the caller, the log, or the serialized error.
            JSON.stringify({
              error: { message: `request failed for key ${KEY}`, code: status },
            }),
            { status },
          ),
      );

      const error = await failureOf(generateReply(turns, withModel()));
      expect(error.reason, String(status)).toBe("http-error");
      expect(error.status, String(status)).toBe(status);
      expect(error.message).not.toContain(KEY);
      expect(error.message).not.toContain("request failed for key");
      expect(JSON.stringify(error)).not.toContain(KEY);
    }

    const logged = logs.join("\n");
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain("authorization");
    expect(logged).not.toContain("request failed for key");
    // The log names the outcome and the status, nothing else.
    expect(logged).toContain("status 503");
  });

  it("reports a network failure as a network error", async () => {
    configure();
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });

    expect((await failureOf(generateReply(turns, withModel()))).reason).toBe("network-error");
  });

  it("does not retain upstream exception details that might echo a credential", async () => {
    configure();
    vi.stubGlobal("fetch", async () => {
      throw new Error(`upstream failed for ${KEY}`);
    });

    const error = await failureOf(generateReply(turns, withModel()));
    expect(error.reason).toBe("network-error");
    expect(error.cause).toBeUndefined();
    expect(error.message).not.toContain(KEY);
    expect(JSON.stringify(error)).not.toContain(KEY);
  });

  it("unblocks a pending JSON body read on caller abort even if fetch ignores the signal", async () => {
    configure();
    const cancel = new AbortController();
    let bodyCancelled = false;
    let startReading!: () => void;
    const reading = new Promise<void>((resolve) => { startReading = resolve; });
    vi.stubGlobal("fetch", async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull() { startReading(); /* Keep the read pending. */ },
          cancel() { bodyCancelled = true; },
        }, { highWaterMark: 0 }),
        { status: 200 },
      ),
    );

    const pending = generateReply(turns, withModel({ signal: cancel.signal, timeoutMs: 5_000 }));
    await reading;
    cancel.abort();
    expect((await failureOf(pending)).reason).toBe("aborted");
    expect(bodyCancelled).toBe(true);
  });

  it("unblocks a pending JSON body read on timeout even if fetch ignores the signal", async () => {
    configure();
    let bodyCancelled = false;
    vi.stubGlobal("fetch", async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull() { /* Keep the read pending until the deadline fires. */ },
          cancel() { bodyCancelled = true; },
        }, { highWaterMark: 0 }),
        { status: 200 },
      ),
    );

    expect((await failureOf(generateReply(turns, withModel({ timeoutMs: 20 })))).reason).toBe(
      "timeout",
    );
    expect(bodyCancelled).toBe(true);
  });

  it("cuts an oversized JSON body before reading further chunks", async () => {
    configure();
    let pulls = 0;
    let bodyCancelled = false;
    stubFetch(() =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            controller.enqueue(new Uint8Array(1_000_001));
          },
          cancel() { bodyCancelled = true; },
        }, { highWaterMark: 0 }),
        { status: 200 },
      ),
    );

    expect((await failureOf(generateReply(turns, withModel()))).reason).toBe(
      "malformed-response",
    );
    expect(pulls).toBe(1);
    expect(bodyCancelled).toBe(true);
  });

  it("reports a body that fails mid-read as a provider failure", async () => {
    configure();
    stubFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new TypeError("terminated"));
            },
          }),
          { status: 200 },
        ),
    );

    expect((await failureOf(generateReply(turns, withModel()))).reason).toBe("network-error");
  });
});

describe("NVIDIA key rotation", () => {
  const FIRST = "nvidia-rotation-first-not-a-secret";
  const SECOND = "nvidia-rotation-second-not-a-secret";
  const THIRD = "nvidia-rotation-third-not-a-secret";

  function configureKeys(...keys: string[]) {
    configure({ keys: keys.join(", ") });
  }

  it("answers with the first eligible key and spends no other", async () => {
    configureKeys(FIRST, SECOND);
    const calls = stubFetch(() => completion("Answered by the first key"));

    await expect(generateReply(turns, withModel())).resolves.toBe("Answered by the first key");
    expect(calls.map(keyOf)).toEqual([FIRST]);
  });

  it("retries with the next key when the first one is rate limited", async () => {
    configureKeys(FIRST, SECOND);
    const calls = stubFetch((request) =>
      keyOf(request) === FIRST
        ? new Response(JSON.stringify({ error: { message: `rate limited ${FIRST}` } }), {
            status: 429,
          })
        : completion("Answered by the second key"),
    );

    await expect(generateReply(turns, withModel())).resolves.toBe("Answered by the second key");
    expect(calls.map(keyOf)).toEqual([FIRST, SECOND]);

    // The rejected key is quarantined: the next request skips it entirely.
    calls.length = 0;
    await expect(generateReply(turns, withModel())).resolves.toBe("Answered by the second key");
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

      await expect(generateReply(turns, withModel()), String(status)).resolves.toBe(
        "Answered by the second key",
      );
      expect(calls.map(keyOf), String(status)).toEqual([FIRST, SECOND]);
    }
  });

  it("retries a provider-side failure with another key without quarantining it", async () => {
    for (const status of [500, 503, 504]) {
      resetKeyPools();
      configureKeys(FIRST, SECOND);
      const calls = stubFetch((request) =>
        keyOf(request) === FIRST ? new Response("", { status }) : completion("Recovered"),
      );

      await expect(generateReply(turns, withModel()), String(status)).resolves.toBe("Recovered");
      expect(calls.map(keyOf), String(status)).toEqual([FIRST, SECOND]);

      // A 5xx is not the key's fault, so the next request may start with it again.
      calls.length = 0;
      await generateReply(turns, withModel());
      expect(calls.map(keyOf), String(status)).toEqual([FIRST, SECOND]);
    }
  });

  it("retries with another key after a network failure", async () => {
    configureKeys(FIRST, SECOND);
    const calls = stubFetch((request) => {
      if (keyOf(request) === FIRST) throw new TypeError("fetch failed");
      return completion("Answered anyway");
    });

    await expect(generateReply(turns, withModel())).resolves.toBe("Answered anyway");
    expect(calls.map(keyOf)).toEqual([FIRST, SECOND]);
  });

  it("does not rotate on a failure another key cannot fix", async () => {
    for (const status of [400, 404, 422]) {
      resetKeyPools();
      configureKeys(FIRST, SECOND);
      const calls = stubFetch(() => new Response("", { status }));

      const error = await failureOf(generateReply(turns, withModel()));
      expect(error.status, String(status)).toBe(status);
      expect(calls.map(keyOf), String(status)).toEqual([FIRST]);
    }

    // Nor on an answer that is unusable rather than unreachable.
    resetKeyPools();
    configureKeys(FIRST, SECOND);
    const unusable = stubFetch(() => completion(""));
    expect((await failureOf(generateReply(turns, withModel()))).reason).toBe("empty-response");
    expect(unusable.map(keyOf)).toEqual([FIRST]);
  });

  it("bounds one request to the smaller of the attempt limit and the key count", async () => {
    configureKeys(FIRST, SECOND, THIRD, "nvidia-rotation-fourth-not-a-secret");
    const calls = stubFetch(() => new Response("", { status: 429 }));

    const error = await failureOf(generateReply(turns, withModel()));
    expect(error.status).toBe(429);
    expect(calls).toHaveLength(Math.min(4, NVIDIA_MAX_KEY_ATTEMPTS));
    expect(NVIDIA_MAX_KEY_ATTEMPTS).toBe(3);
    // Every attempt used a different key: one request never hammers the same one.
    expect(new Set(calls.map(keyOf)).size).toBe(calls.length);
  });

  it("reports the last rejection when every key is cooling down", async () => {
    configureKeys(FIRST, SECOND);
    const calls = stubFetch(() => new Response("", { status: 429 }));

    await failureOf(generateReply(turns, withModel()));
    calls.length = 0;

    // Both keys are quarantined now, so the next request makes no call at all and
    // reports the status that quarantined them — never which key it was.
    const error = await failureOf(generateReply(turns, withModel()));
    expect(error.reason).toBe("http-error");
    expect(error.status).toBe(429);
    expect(calls).toEqual([]);
  });

  it("does not share a rejection or cooldown with OpenRouter, even for the same key text", async () => {
    // Identical obvious test key text makes an accidental cache-key collision
    // observable. Real deployments have separate key lists, but they must be
    // isolated by *provider*, not by whatever strings happen to be configured.
    configureKeys(KEY);
    vi.stubEnv("OPENROUTER_API_KEYS", KEY);
    vi.stubEnv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1");
    const calls = stubFetch((request) =>
      request.url.startsWith(BASE)
        ? new Response("", { status: 401 })
        : completion("OpenRouter is still available"),
    );

    expect((await failureOf(generateReply(turns, withModel()))).status).toBe(401);
    await expect(generateOpenRouter(turns, { model: "gpt-4o-mini" })).resolves.toBe(
      "OpenRouter is still available",
    );
    expect(calls.map((request) => request.url)).toEqual([
      `${BASE}/chat/completions`,
      "https://openrouter.ai/api/v1/chat/completions",
    ]);
    expect(calls.map(keyOf)).toEqual([KEY, KEY]);

    // Now reverse the failure direction: OpenRouter quarantines its own key and
    // NVIDIA can still use the same string with its own, clean pool.
    resetKeyPools();
    calls.length = 0;
    stubFetch((request) =>
      request.url.startsWith(BASE)
        ? completion("NVIDIA is still available")
        : new Response("", { status: 429 }),
    );
    expect((await failureOf(generateOpenRouter(turns, { model: "gpt-4o-mini" }))).status).toBe(429);
    await expect(generateReply(turns, withModel())).resolves.toBe("NVIDIA is still available");
  });

  it("spreads consecutive requests across the configured keys", async () => {
    configureKeys(KEY, "second-key-not-a-secret");
    const calls = stubFetch(() => completion("ok"));

    for (let index = 0; index < 3; index += 1) {
      await generateReply([{ role: "user", content: "Hi" }], withModel());
    }
    expect(calls.map(keyOf)).toEqual([KEY, "second-key-not-a-secret", KEY]);
  });
});

/** One OpenAI-compatible stream chunk, with NVIDIA-only fields included. */
function chunkFrame(content: string, extra: Record<string, unknown> = {}) {
  return `data: ${JSON.stringify({
    id: "provider-chunk-id",
    object: "chat.completion.chunk",
    model: "provider-model-name",
    // NVIDIA endpoints are known to add a reasoning trace next to the content.
    choices: [{ index: 0, delta: { content, reasoning: "internal scratchpad" }, ...extra }],
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

describe("NVIDIA streaming replies", () => {
  it("yields every delta in order and stops at the completion marker", async () => {
    configure();
    const calls = stubFetch(() =>
      streamedResponse([
        chunkFrame("Hello"),
        chunkFrame(" there"),
        chunkFrame(", friend"),
        STREAM_DONE,
        // Anything after the marker is never read.
        chunkFrame("ignored"),
      ]),
    );

    const deltas = await collect(streamReply(turns, withModel()));

    expect(deltas).toEqual([
      { type: "delta", text: "Hello" },
      { type: "delta", text: " there" },
      { type: "delta", text: ", friend" },
    ]);
    expect(calls).toHaveLength(1);
  });

  it("accepts a finish_reason chunk as the completion marker", async () => {
    configure();
    stubFetch(() =>
      streamedResponse([chunkFrame("Complete"), chunkFrame("", { finish_reason: "stop" })]),
    );

    expect(await collect(streamReply(turns, withModel()))).toEqual([
      { type: "delta", text: "Complete" },
    ]);
  });

  it("reassembles frames split across reads, CRLF boundaries, and UTF-8 bytes", async () => {
    configure();
    const first = chunkFrame("Split ");
    const second = new TextEncoder().encode(chunkFrame("answer 🌟").replace(/\n/g, "\r\n"));
    const emojiBytes = second.indexOf(240); // first byte of the four-byte star
    expect(emojiBytes).toBeGreaterThan(0);
    const separator = second.indexOf(13, emojiBytes + 4); // CR of a CRLF boundary
    expect(separator).toBeGreaterThan(emojiBytes);

    stubFetch(() =>
      streamedResponse([
        // A frame cut in half, then a multi-byte character cut across reads.
        first.slice(0, 12),
        first.slice(12),
        second.slice(0, emojiBytes + 2),
        second.slice(emojiBytes + 2, separator + 1), // trailing CR, next read starts LF
        second.slice(separator + 1),
        STREAM_DONE,
      ]),
    );

    expect(await collect(streamReply(turns, withModel()))).toEqual([
      { type: "delta", text: "Split " },
      { type: "delta", text: "answer 🌟" },
    ]);
  });

  it("ignores keep-alives, other event fields, and chunks that carry no text", async () => {
    configure();
    stubFetch(() =>
      streamedResponse([
        ": keep-alive ping\n\n",
        "event: message\nid: 7\nretry: 100\n\n",
        "data:\n\n",
        chunkFrame(""), // a role-only delta
        chunkFrame("Real text"),
        `data: ${JSON.stringify({ choices: [] })}\n\n`,
        `data: ${JSON.stringify({ id: "usage-only", choices: [], usage: { total_tokens: 3 } })}\n\n`,
        STREAM_DONE,
      ]),
    );

    expect(await collect(streamReply(turns, withModel()))).toEqual([
      { type: "delta", text: "Real text" },
    ]);
  });

  it("never forwards a non-standard chunk field as assistant text", async () => {
    configure();
    stubFetch(() =>
      streamedResponse([
        chunkFrame("Answer"),
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: { reasoning: "let me think about the prompt" } }],
        })}\n\n`,
        STREAM_DONE,
      ]),
    );

    const deltas = await collect(streamReply(turns, withModel()));
    expect(deltas).toEqual([{ type: "delta", text: "Answer" }]);
    expect(deltas.map((delta) => delta.text).join("")).not.toContain("let me think");
  });

  it("accepts a plain message chunk when a gateway ignores the stream flag", async () => {
    configure();
    stubFetch(() =>
      streamedResponse([
        `data: ${JSON.stringify({
          choices: [{ index: 0, message: { role: "assistant", content: "Whole answer" } }],
        })}\n\n`,
        STREAM_DONE,
      ]),
    );

    expect(await collect(streamReply(turns, withModel()))).toEqual([
      { type: "delta", text: "Whole answer" },
    ]);
  });
});

describe("NVIDIA streaming failures", () => {
  it("refuses to treat a stream without a completion marker as an answer", async () => {
    configure();
    const delivered: string[] = [];
    stubFetch(() => streamedResponse([chunkFrame("Cut off halfway")]));

    const stream = streamReply(turns, withModel());
    const error = await (async () => {
      try {
        for await (const chunk of stream) delivered.push(chunk.text);
        return null;
      } catch (thrown) {
        return thrown;
      }
    })();

    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as InstanceType<typeof AiProviderError>).reason).toBe("malformed-response");
    // The half answer was forwarded but never presented as complete: the caller
    // decides, and the reply service stores nothing after a failure.
    expect(delivered).toEqual(["Cut off halfway"]);
  });

  it("treats malformed chunks and plain JSON as failures", async () => {
    configure();

    stubFetch(() => streamedResponse(['data: {"choices":[{"delta":\n\n', STREAM_DONE]));
    expect((await collectFailure(() => collect(streamReply(turns, withModel())))).reason).toBe(
      "malformed-response",
    );

    // A provider that ignores `stream: true` and answers with JSON sends no frames.
    stubFetch(() => new Response(JSON.stringify({ choices: [{ message: { content: "Hi" } }] })));
    expect((await collectFailure(() => collect(streamReply(turns, withModel())))).reason).toBe(
      "malformed-response",
    );

    // A stream with no body at all is malformed rather than empty.
    stubFetch(() => new Response(null, { status: 200 }));
    expect((await collectFailure(() => collect(streamReply(turns, withModel())))).reason).toBe(
      "malformed-response",
    );
  });

  it("rejects an upstream SSE error and a failing finish_reason, never declaring completion", async () => {
    configure();
    const sensitive = "upstream-test-value-not-a-secret";
    const logs = captureLogs();
    const errorFrame = `event: error\ndata: ${JSON.stringify({
      error: { message: `provider rejected a key: ${sensitive}` },
    })}\n\n`;

    // Even though a content chunk came first and [DONE] follows, the adapter must
    // throw rather than pretend the partial answer finished successfully.
    stubFetch(() => streamedResponse([chunkFrame("Partial"), errorFrame, STREAM_DONE]));
    const caught = await collectFailure(() => collect(streamReply(turns, withModel())));
    expect(caught.reason).toBe("malformed-response");
    expect(caught.message).not.toContain(sensitive);
    expect(JSON.stringify(caught)).not.toContain(sensitive);

    stubFetch(() =>
      streamedResponse([chunkFrame("Partial"), chunkFrame("", { finish_reason: "error" }), STREAM_DONE]),
    );
    expect((await collectFailure(() => collect(streamReply(turns, withModel())))).reason).toBe(
      "malformed-response",
    );
    expect(logs.join("\n")).not.toContain(sensitive);
  });

  it("rejects a malformed JSON-shaped chunk, not just unreadable JSON", async () => {
    configure();
    for (const payload of [
      {},
      { choices: "wrong" },
      { choices: [null] },
      { choices: [{}] },
      { choices: [{ delta: { content: 42 } }] },
    ]) {
      stubFetch(() => streamedResponse([chunkFrame("Partial"), `data: ${JSON.stringify(payload)}\n\n`, STREAM_DONE]));
      expect(
        (await collectFailure(() => collect(streamReply(turns, withModel())))).reason,
        JSON.stringify(payload),
      ).toBe("malformed-response");
    }
  });

  it("reports an empty stream as empty, not as an answer", async () => {
    configure();

    stubFetch(() => streamedResponse([STREAM_DONE]));
    expect((await collectFailure(() => collect(streamReply(turns, withModel())))).reason).toBe(
      "empty-response",
    );

    stubFetch(() =>
      streamedResponse([
        chunkFrame(""),
        chunkFrame("   "),
        chunkFrame("", { finish_reason: "stop" }),
        STREAM_DONE,
      ]),
    );
    expect((await collectFailure(() => collect(streamReply(turns, withModel())))).reason).toBe(
      "empty-response",
    );
  });

  it("cuts a runaway stream instead of accumulating it", async () => {
    configure();
    const logs = captureLogs();
    stubFetch(() =>
      streamedResponse([chunkFrame("x".repeat(NVIDIA_MAX_REPLY_CHARACTERS + 1)), STREAM_DONE]),
    );

    expect((await collectFailure(() => collect(streamReply(turns, withModel())))).reason).toBe(
      "too-long",
    );
    expect(logs.join("\n")).not.toContain("xxxx");
  });

  it("cuts a stream that sends too many bytes", async () => {
    configure();
    // Frames that never complete: the byte bound stops the read.
    stubFetch(() => streamedResponse([`data: ${"y".repeat(1_000_001)}\n\n`, STREAM_DONE]));

    expect((await collectFailure(() => collect(streamReply(turns, withModel())))).reason).toBe(
      "too-long",
    );
  });

  it("reports HTTP errors, network failures, timeouts, and cancellations", async () => {
    configure();

    stubFetch(() => new Response(`{"error":{"message":"bad key ${KEY}"}}`, { status: 429 }));
    const httpError = await collectFailure(() => collect(streamReply(turns, withModel())));
    expect(httpError.reason).toBe("http-error");
    expect(httpError.status).toBe(429);
    expect(JSON.stringify(httpError)).not.toContain(KEY);

    // That rejection quarantined the only configured key; the scenarios below are
    // independent, so they start from a clean pool.
    resetKeyPools();
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    expect((await collectFailure(() => collect(streamReply(turns, withModel())))).reason).toBe(
      "network-error",
    );

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
    expect((await collectFailure(() => collect(streamReply(turns, withModel())))).reason).toBe(
      "network-error",
    );

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
    expect(
      (await collectFailure(() => collect(streamReply(turns, withModel({ timeoutMs: 20 }))))).reason,
    ).toBe("timeout");

    // A caller abort is reported separately from the deadline.
    const controller = new AbortController();
    const pending = collect(
      streamReply(turns, withModel({ signal: controller.signal, timeoutMs: 5_000 })),
    );
    controller.abort();
    expect((await collectFailure(() => pending)).reason).toBe("aborted");

    // A disconnect can surface as a plain body failure even though the caller is the
    // one who cancelled: the signal decides the reason.
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
    expect(
      (
        await collectFailure(() =>
          collect(streamReply(turns, withModel({ signal: disconnected.signal }))),
        )
      ).reason,
    ).toBe("aborted");
  });

  it("a client disconnect unblocks a body read even if fetch ignores abort signals", async () => {
    configure();
    let cancelled = false;
    const controller = new AbortController();
    vi.stubGlobal("fetch", async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start() { /* Leave the connection pending indefinitely. */ },
          cancel() { cancelled = true; },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );

    const pending = collect(streamReply(turns, withModel({ signal: controller.signal })));
    controller.abort();
    const error = await collectFailure(() => pending);
    expect(error.reason).toBe("aborted");
    expect(cancelled).toBe(true);
  });

  it("rotates to another key when a stream fails before any delta", async () => {
    const FIRST = "nvidia-stream-first-not-a-secret";
    const SECOND = "nvidia-stream-second-not-a-secret";
    configure({ keys: [FIRST, SECOND].join(",") });
    const calls = stubFetch((request) =>
      keyOf(request) === FIRST
        ? new Response("", { status: 503 })
        : streamedResponse([chunkFrame("Recovered mid-stream"), STREAM_DONE]),
    );

    expect(await collect(streamReply(turns, withModel()))).toEqual([
      { type: "delta", text: "Recovered mid-stream" },
    ]);
    expect(calls.map(keyOf)).toEqual([FIRST, SECOND]);
  });

  it("never switches key once the answer has started", async () => {
    const FIRST = "nvidia-stream-first-not-a-secret";
    const SECOND = "nvidia-stream-second-not-a-secret";
    configure({ keys: [FIRST, SECOND].join(",") });
    const encoder = new TextEncoder();
    let upstream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const calls = stubFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              upstream = controller;
              controller.enqueue(encoder.encode(chunkFrame("Started on the first key")));
              // Leave the stream open until the caller has received that delta;
              // an error in this same callback could prevent the queued chunk
              // from ever reaching the consumer, which *should* allow rotation.
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );

    const stream = streamReply(turns, withModel());
    const first = await stream.next();
    expect(first).toEqual({ value: { type: "delta", text: "Started on the first key" }, done: false });
    upstream!.error(new TypeError("terminated"));
    const error = await failureOf(stream.next());
    expect(error.reason).toBe("network-error");
    // One request only: no second key was tried after text had been delivered, so
    // the caller can never receive two answers spliced together.
    expect(calls.map(keyOf)).toEqual([FIRST]);
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

    for await (const chunk of streamReply(turns, withModel())) {
      expect(chunk.text).toBe("First");
      break;
    }

    expect(cancelled).toBe(true);
  });
});

describe("the NVIDIA provider surface", () => {
  it("offers the same two calls as every other provider", async () => {
    configure();
    stubFetch(() => completion("Through the provider object"));

    expect(nvidiaProvider.name).toBe("nvidia");
    await expect(nvidiaProvider.generateReply(turns, withModel())).resolves.toBe(
      "Through the provider object",
    );
    expect(typeof nvidiaProvider.streamReply).toBe("function");
  });

  it("streams through the provider object as well", async () => {
    configure();
    stubFetch(() => streamedResponse([chunkFrame("Streamed"), STREAM_DONE]));

    expect(await collect(nvidiaProvider.streamReply(turns, withModel()))).toEqual([
      { type: "delta", text: "Streamed" },
    ]);
  });
});
