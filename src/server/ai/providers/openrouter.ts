import "server-only";
import { getServerEnv } from "../../env";
import { AiNotConfiguredError, AiProviderError } from "../errors";
import { getKeyPool, type KeyPool } from "../key-pool";
import { defaultModelKey, resolveCatalogIdentifier } from "../models/catalog";
import type {
  ChatTurn,
  GenerateReplyOptions,
  ReplyProvider,
  ReplyStream,
  ReplyStreamChunk,
} from "../types";

/**
 * The incumbent AI provider. It speaks OpenRouter's OpenAI-compatible
 * chat-completions API over the plain `fetch` of the server runtime — no SDK, no
 * key in the browser. Everything provider-specific lives in this file: the request
 * shape, the server-sent-event framing of a streaming answer, `[DONE]` handling,
 * the translation of every failure into `AiProviderError`, and the bounded key
 * rotation that retries a request with another configured key. The reply service,
 * the routes, and the browser only ever see plain assistant text.
 *
 * Which model to ask for is not decided here either: the caller passes a key from
 * the server-owned catalog, this adapter resolves it to the OpenRouter identifier,
 * and a key that is unknown or retired is refused before any request is made. Model
 * choice and key rotation are independent — every model uses the same key pool.
 */

/** A stalled provider must not hold a request open forever, streaming or not. */
export const OPENROUTER_TIMEOUT_MS = 30_000;

/** Requests are small, but a runaway provider response is still bounded. */
const MAX_RESPONSE_BYTES = 1_000_000;

/** The same bound applies to the raw bytes of a streamed answer. */
const MAX_STREAM_BYTES = 1_000_000;

/**
 * How much assistant text one reply may contain. The stream is cut as soon as the
 * accumulated text passes this, so an endless provider stream cannot fill server
 * memory, the SSE connection, or a database row.
 */
export const OPENROUTER_MAX_REPLY_CHARACTERS = 16_000;

/** Marks the end of an OpenAI-compatible stream. */
const STREAM_DONE = "[DONE]";

/**
 * How many keys one generation request may try. The real bound is the smaller of
 * this and the number of configured keys, so a request can never become an
 * unbounded retry loop and never hammers one key.
 */
export const MAX_KEY_ATTEMPTS = 3;

type ProviderConfig = {
  /** Configured keys, in order; the pool decides which one a request uses. */
  keys: readonly string[];
  baseUrl: string;
};

/**
 * Reads the server-only configuration. A missing or invalid value throws
 * `AiNotConfiguredError` so the endpoint can answer with a controlled error
 * instead of failing the build or leaking validation details to the browser.
 * `OPENROUTER_API_KEYS` holds one or more keys; the pool rotates through them.
 */
function readConfig(): ProviderConfig {
  try {
    const { OPENROUTER_API_KEYS, OPENROUTER_BASE_URL } = getServerEnv("openrouter");
    return { keys: OPENROUTER_API_KEYS, baseUrl: OPENROUTER_BASE_URL };
  } catch (error) {
    throw new AiNotConfiguredError(error);
  }
}

function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

/**
 * The OpenRouter identifier one call will use. Only a catalog key is accepted from
 * the caller — the identifier itself is produced by the catalog module — so no
 * browser value and no stray string can name a provider model. Resolved once per
 * call, before any key is selected, so an unusable model fails immediately instead
 * of looking like a retryable provider fault.
 */
function modelIdentifier(model: string | undefined): string {
  return resolveCatalogIdentifier(model ?? defaultModelKey());
}

/** Builds the one request body both paths use; only `stream` differs. */
function requestBody(model: string, turns: readonly ChatTurn[], stream: boolean) {
  return {
    model,
    messages: turns.map((turn) => ({ role: turn.role, content: turn.content })),
    stream,
  };
}

type Signals = {
  /** The adapter's own deadline; distinguishes a timeout from a caller abort. */
  timeout: AbortSignal;
  /** Everything the request should stop for. */
  request: AbortSignal;
};

function requestSignals(options: GenerateReplyOptions): Signals {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? OPENROUTER_TIMEOUT_MS);
  return {
    timeout,
    request: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
  };
}

/**
 * Turns a failed fetch (or a failed body read) into a typed provider error.
 * The timeout signal is checked first so a deadline is never reported as a caller
 * cancellation. A caller abort is then recognised from the signal as well as from
 * the error, because a cancelled body read surfaces as a plain stream failure
 * (`TypeError: terminated`) rather than an `AbortError` — a browser navigating away
 * must not be filed as a provider network fault. Nothing but the outcome is
 * inspected: no message text, no body.
 */
function mapFetchFailure(error: unknown, signals: Signals): AiProviderError {
  if (signals.timeout.aborted) return new AiProviderError("timeout", { cause: error });
  if (signals.request.aborted || (error instanceof Error && error.name === "AbortError"))
    return new AiProviderError("aborted", { cause: error });
  return new AiProviderError("network-error", { cause: error });
}

/**
 * Sends one attempt with one key. Body parsing stays with the caller, which knows
 * the mode. The deadline is created per request, not per attempt, so rotating to
 * another key never extends how long a user request may take.
 */
async function postChatCompletions(
  config: ProviderConfig,
  key: string,
  model: string,
  turns: readonly ChatTurn[],
  signals: Signals,
  stream: boolean,
): Promise<Response> {
  try {
    return await fetch(chatCompletionsUrl(config.baseUrl), {
      method: "POST",
      headers: {
        // The key exists only in this header, on the server, for this one attempt.
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: stream ? "text/event-stream" : "application/json",
        "x-title": "YoriGPT",
      },
      body: JSON.stringify(requestBody(model, turns, stream)),
      signal: signals.request,
    });
  } catch (error) {
    throw mapFetchFailure(error, signals);
  }
}

/** A non-2xx answer is reported by status only; the body may echo provider input. */
function assertOk(response: Response, label: string) {
  if (response.ok) return;
  console.error(`[openrouter] ${label} request failed with status ${response.status}.`);
  // The body is never read — it can echo the request — but it is released so a
  // rejected attempt does not leave a socket open while another key is tried.
  void response.body?.cancel().catch(() => {});
  throw new AiProviderError("http-error", { status: response.status });
}

/**
 * How a failed attempt should be handled. Only two kinds of failure are worth
 * another key, and only one of them is the key's own fault:
 *
 * - `quarantine`: the provider rejected *this key* — invalid or revoked (401, 403)
 *   or rate limited (429). The key is skipped until its cooldown expires and
 *   another key is tried.
 * - `rotate`: the failure is not key-specific — a provider-side error (5xx) or a
 *   network fault. Another key may still answer, but this one stays eligible.
 * - `none`: another key cannot help. A malformed, empty, or oversized answer, a
 *   request the provider refused as invalid (other 4xx), a deadline that already
 *   consumed the request, or a caller that cancelled are all reported as they are.
 */
type FailureAction = "quarantine" | "rotate" | "none";

function failureAction(error: AiProviderError): FailureAction {
  if (error.reason === "network-error") return "rotate";
  if (error.reason !== "http-error" || error.status === undefined) return "none";
  if (error.status === 401 || error.status === 403 || error.status === 429) return "quarantine";
  if (error.status >= 500) return "rotate";
  return "none";
}

/** Every attempt ends here, so both reply paths classify failures identically. */
function asProviderFailure(error: unknown): AiProviderError {
  return error instanceof AiProviderError
    ? error
    : new AiProviderError("network-error", { cause: error });
}

/**
 * The last resort: no key was eligible, so no request was made at all. Only
 * reachable while every configured key is cooling down after a provider rejection;
 * the reported status is the one that caused the most recent quarantine.
 */
function unavailableKeyError(pool: KeyPool, label: string): AiProviderError {
  console.error(
    `[openrouter] No eligible API key for the ${label}; every configured key is cooling down after a provider rejection.`,
  );
  return new AiProviderError("http-error", { status: pool.lastStatus });
}

/** Only `choices[0].message.content` is of interest; everything else is ignored. */
function readAssistantContent(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (typeof first !== "object" || first === null) return null;
  const content = (first as { message?: { content?: unknown } }).message?.content;
  return typeof content === "string" ? content : null;
}

/**
 * Reads a non-streamed answer. Bounded by `MAX_RESPONSE_BYTES` before parsing, and
 * the body is never logged or forwarded.
 */
async function readJsonReply(response: Response): Promise<string> {
  let payload: unknown;
  try {
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      console.error("[openrouter] Reply response exceeded the accepted size.");
      throw new AiProviderError("malformed-response");
    }
    payload = JSON.parse(text);
  } catch (error) {
    if (error instanceof AiProviderError) throw error;
    console.error("[openrouter] Reply response was not valid JSON.");
    throw new AiProviderError("malformed-response", { cause: error });
  }

  const content = readAssistantContent(payload);
  if (content === null) {
    console.error("[openrouter] Reply response had no assistant message.");
    throw new AiProviderError("malformed-response");
  }
  if (content.trim() === "") {
    console.error("[openrouter] Reply response was empty.");
    throw new AiProviderError("empty-response");
  }

  return content.trim();
}

/**
 * The text of one streamed chunk. OpenRouter sends `choices[0].delta.content`;
 * a `message.content` field is accepted too, because a non-streaming answer may
 * arrive on this path when a gateway ignores `stream: true`.
 */
function readChunk(payload: unknown): { text: string; finished: boolean } {
  if (typeof payload !== "object" || payload === null) return { text: "", finished: false };
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return { text: "", finished: false };

  const first = choices[0];
  if (typeof first !== "object" || first === null) return { text: "", finished: false };
  const choice = first as {
    delta?: { content?: unknown };
    message?: { content?: unknown };
    finish_reason?: unknown;
  };

  const delta = choice.delta?.content;
  const message = choice.message?.content;
  const text = typeof delta === "string" ? delta : typeof message === "string" ? message : "";
  // A final chunk may carry only `finish_reason`; that is a valid completion marker
  // for providers that close the stream without `[DONE]`.
  const finished = typeof choice.finish_reason === "string" && choice.finish_reason !== "";
  return { text, finished };
}

/**
 * One parsed server-sent event. Only `data:` lines matter here; comments
 * (keep-alive pings), `event:`, `id:`, and `retry:` fields are ignored, so a
 * provider that adds metadata cannot break parsing.
 */
function readEventData(frame: string): string | null {
  const lines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    if (field !== "data") continue;
    const value = separator === -1 ? "" : line.slice(separator + 1);
    lines.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * Applies one parsed frame and reports what it contained: assistant text (which
 * may be empty) and whether the provider marked the answer complete. Provider
 * payloads never escape this function — only text does.
 */
type FrameResult = { kind: "none" } | { kind: "data"; text: string; done: boolean };

function applyFrame(frame: string): FrameResult {
  const data = readEventData(frame);
  if (data === null) return { kind: "none" };
  if (data === STREAM_DONE) return { kind: "data", text: "", done: true };

  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch (error) {
    console.error("[openrouter] Streaming reply contained an unreadable chunk.");
    throw new AiProviderError("malformed-response", { cause: error });
  }

  const { text, finished } = readChunk(payload);
  return { kind: "data", text, done: finished };
}

/**
 * Streams one attempt with one key: yields one normalized delta per provider chunk
 * and returns when the provider says the answer is complete. The stream counts as
 * complete only when it says so — `data: [DONE]` or a chunk carrying
 * `finish_reason`. A connection that stops before either marker is a
 * `malformed-response`, so a truncated answer can never be mistaken for a finished
 * one and never reaches the database.
 */
async function* streamReplyOnce(
  config: ProviderConfig,
  key: string,
  model: string,
  turns: readonly ChatTurn[],
  signals: Signals,
): AsyncGenerator<ReplyStreamChunk, void, void> {
  const response = await postChatCompletions(config, key, model, turns, signals, true);
  assertOk(response, "Streaming reply");

  const body = response.body;
  if (!body) {
    console.error("[openrouter] Streaming reply had no response body.");
    throw new AiProviderError("malformed-response");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  let text = "";
  let complete = false;
  let finishedReading = false;

  try {
    while (!complete) {
      // Take the next complete frame, reading more of the body only when the
      // buffer does not hold one yet. This keeps delivery incremental: a delta is
      // yielded as soon as its frame arrives, never after the whole answer.
      let frame: string | null = null;
      while (frame === null) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary !== -1) {
          frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          break;
        }
        if (finishedReading) {
          // A provider may close without a trailing blank line; the remaining
          // text is still a complete event.
          if (buffer.trim() !== "") {
            frame = buffer;
            buffer = "";
          }
          break;
        }

        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (error) {
          throw mapFetchFailure(error, signals);
        }
        if (chunk.done) {
          finishedReading = true;
          continue;
        }

        bytes += chunk.value.byteLength;
        if (bytes > MAX_STREAM_BYTES) {
          console.error("[openrouter] Streaming reply exceeded the accepted size.");
          throw new AiProviderError("too-long");
        }

        // Normalizing line endings here keeps frames that are split across chunks
        // (including a CRLF split over two reads) intact.
        buffer += decoder.decode(chunk.value, { stream: true });
        buffer = buffer.replace(/\r\n?/g, "\n");
      }

      if (frame === null) break;

      const result = applyFrame(frame);
      if (result.kind === "none") continue;
      if (result.text !== "") {
        text += result.text;
        if (text.length > OPENROUTER_MAX_REPLY_CHARACTERS) {
          console.error("[openrouter] Streaming reply exceeded the reply size limit.");
          throw new AiProviderError("too-long");
        }
        yield { type: "delta", text: result.text };
      }
      if (result.done) complete = true;
    }
  } finally {
    // Releasing the lock lets the runtime cancel the socket, and the explicit
    // cancel below stops the provider connection when this generator is abandoned
    // — a client that disconnected, or a caller that stopped iterating — instead
    // of leaving it open until the provider finishes on its own.
    reader.releaseLock();
    void body.cancel().catch(() => {});
  }

  if (!complete) {
    console.error("[openrouter] Streaming reply ended before a completion marker.");
    throw new AiProviderError("malformed-response");
  }
  if (text.trim() === "") {
    console.error("[openrouter] Streaming reply was empty.");
    throw new AiProviderError("empty-response");
  }
}

/**
 * Streams the assistant answer of one conversation turn, rotating through the
 * configured keys when a request fails for a reason another key could avoid.
 *
 * The key pool decides which key each attempt uses, and one request tries at most
 * `min(configured keys, MAX_KEY_ATTEMPTS)` of them. Two rules keep this safe:
 * a key that already failed for this request is never offered again, and rotation
 * only happens while no delta has been forwarded. Once the caller has received
 * assistant text the answer has started, so a later failure is reported exactly as
 * before — no mid-answer key switch, no partial row, no fake completion.
 */
export async function* streamReply(
  turns: readonly ChatTurn[],
  options: GenerateReplyOptions = {},
): AsyncGenerator<ReplyStreamChunk, void, void> {
  const config = readConfig();
  // The catalog decides the identifier; a key the catalog does not offer fails
  // here, before any network call and without touching the key pool.
  const model = modelIdentifier(options.model);
  const pool = getKeyPool(config.keys);
  const signals = requestSignals(options);
  const tried = new Set<string>();
  let lastFailure: AiProviderError | null = null;

  for (let attempt = 0; attempt < Math.min(pool.size, MAX_KEY_ATTEMPTS); attempt += 1) {
    const key = pool.select({ exclude: tried });
    if (!key) break;
    tried.add(key);

    /** Assistant text already handed to the caller for this attempt. */
    let delivered = false;

    try {
      for await (const chunk of streamReplyOnce(config, key, model, turns, signals)) {
        delivered = true;
        yield chunk;
      }
      pool.reportSuccess(key);
      return;
    } catch (error) {
      const failure = asProviderFailure(error);
      // A cancelled caller and a spent deadline classify as `none`, so an abort can
      // never look like a provider fault or trigger another key.
      const action = delivered ? "none" : failureAction(failure);
      if (action === "none") throw failure;

      if (action === "quarantine") pool.reportFailure(key, failure.status);
      lastFailure = failure;
    }
  }

  throw lastFailure ?? unavailableKeyError(pool, "streaming");
}

/** One non-streamed attempt with one key: `stream: false`, one complete answer. */
async function generateReplyOnce(
  config: ProviderConfig,
  key: string,
  model: string,
  turns: readonly ChatTurn[],
  signals: Signals,
): Promise<string> {
  const response = await postChatCompletions(config, key, model, turns, signals, false);
  assertOk(response, "Reply");

  try {
    return await readJsonReply(response);
  } catch (error) {
    // A body that fails mid-read (timeout, disconnect) is still a provider failure.
    if (error instanceof AiProviderError) throw error;
    throw new AiProviderError("network-error", { cause: error });
  }
}

/**
 * Non-streaming call kept for the JSON reply endpoint. It rotates through the same
 * key pool, with the same classification and the same bounds as the streaming
 * path; the only difference is that nothing is forwarded before the answer is
 * complete, so a retry is invisible to the caller.
 */
export async function generateReply(
  turns: readonly ChatTurn[],
  options: GenerateReplyOptions = {},
): Promise<string> {
  const config = readConfig();
  const model = modelIdentifier(options.model);
  const pool = getKeyPool(config.keys);
  const signals = requestSignals(options);
  const tried = new Set<string>();
  let lastFailure: AiProviderError | null = null;

  for (let attempt = 0; attempt < Math.min(pool.size, MAX_KEY_ATTEMPTS); attempt += 1) {
    const key = pool.select({ exclude: tried });
    if (!key) break;
    tried.add(key);

    try {
      const text = await generateReplyOnce(config, key, model, turns, signals);
      pool.reportSuccess(key);
      return text;
    } catch (error) {
      const failure = asProviderFailure(error);
      const action = failureAction(failure);
      if (action === "none") throw failure;

      if (action === "quarantine") pool.reportFailure(key, failure.status);
      lastFailure = failure;
    }
  }

  throw lastFailure ?? unavailableKeyError(pool, "reply");
}

export const openRouterProvider: ReplyProvider = {
  name: "openrouter",
  generateReply,
  streamReply(
    turns: readonly ChatTurn[],
    options?: GenerateReplyOptions,
  ): ReplyStream {
    return streamReply(turns, options);
  },
};
