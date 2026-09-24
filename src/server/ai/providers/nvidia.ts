import "server-only";
import { getServerEnv } from "../../env";
import { AiNotConfiguredError, AiProviderError } from "../errors";
import { getKeyPool, type KeyPool } from "../key-pool";
import {
  defaultModelKey,
  resolveCatalogIdentifier,
  type ModelProviderName,
} from "../models/catalog";
import type {
  ChatTurn,
  GenerateReplyOptions,
  ReplyProvider,
  ReplyStream,
  ReplyStreamChunk,
} from "../types";

/**
 * The NVIDIA adapter: NVIDIA NIM's hosted inference API, which speaks the same
 * OpenAI-compatible chat-completions dialect as OpenRouter but is a different
 * service with different credentials, different rate limits, and no OpenRouter
 * attribution header.
 *
 * Everything NVIDIA-specific lives in this file — the endpoint, the request shape,
 * the server-sent-event framing of a streaming answer, `[DONE]` handling, the
 * translation of every failure into `AiProviderError`, and the bounded key rotation
 * that retries a request with another configured key. The reply service, the routes,
 * and the browser see exactly what they see from OpenRouter: plain assistant text.
 *
 * The adapter is deliberately self-contained rather than a shared base class with
 * the OpenRouter one. Both speak an OpenAI-compatible dialect today, but the two
 * services differ in the details that matter for reliability (headers, latency,
 * error vocabulary, non-standard chunk fields such as `reasoning`), and a shared
 * core would force the incumbent provider to change shape the moment NVIDIA needs
 * something of its own. What is shared instead is the *contract*: the same
 * `ReplyProvider` surface, the same failure reasons, the same key-pool semantics,
 * and the same "no mid-answer key switch, no partial row" guarantees.
 *
 * Which model to ask for is not decided here either: the caller passes a key from
 * the server-owned catalog, this adapter resolves it to the NVIDIA identifier, and
 * a key that is unknown, retired, or served by another provider is refused before
 * any request is made.
 */

/** A stalled provider must not hold a request open forever, streaming or not. */
export const NVIDIA_TIMEOUT_MS = 30_000;

/** Requests are small, but a runaway provider response is still bounded. */
const MAX_RESPONSE_BYTES = 1_000_000;

/** The same bound applies to the raw bytes of a streamed answer. */
const MAX_STREAM_BYTES = 1_000_000;

/**
 * How much assistant text one reply may contain. The stream is cut as soon as the
 * accumulated text passes this, so an endless provider stream cannot fill server
 * memory, the SSE connection, or a database row.
 */
export const NVIDIA_MAX_REPLY_CHARACTERS = 16_000;

/** Marks the end of an OpenAI-compatible stream. */
const STREAM_DONE = "[DONE]";

/**
 * How many keys one generation request may try. The real bound is the smaller of
 * this and the number of configured NVIDIA keys, so a request can never become an
 * unbounded retry loop and never hammers one key.
 */
export const NVIDIA_MAX_KEY_ATTEMPTS = 3;

/**
 * This adapter's place in the catalog, used for two things that must agree: which
 * catalog entries it may resolve an identifier for, and which scope its keys rotate
 * in. Scoping the pool by provider means a key NVIDIA rejected never cools down an
 * OpenRouter key — the two providers share no credentials, rate limits, or failure
 * history.
 */
const PROVIDER: ModelProviderName = "nvidia";

type ProviderConfig = {
  /** Configured keys, in order; the pool decides which one a request uses. */
  keys: readonly string[];
  baseUrl: string;
};

/**
 * Reads the server-only configuration. A missing or invalid value throws
 * `AiNotConfiguredError` so the endpoint can answer with a controlled error instead
 * of failing the build or leaking validation details to the browser.
 * `NVIDIA_API_KEYS` holds one or more keys; the pool rotates through them.
 *
 * Nothing here is read at module scope, so importing this adapter — which the
 * dispatcher always does — never requires NVIDIA credentials, and an OpenRouter-only
 * deployment boots and answers without them.
 */
function readConfig(): ProviderConfig {
  try {
    const { NVIDIA_API_KEYS, NVIDIA_BASE_URL } = getServerEnv("nvidia");
    return { keys: NVIDIA_API_KEYS, baseUrl: NVIDIA_BASE_URL };
  } catch (error) {
    throw new AiNotConfiguredError(error);
  }
}

function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

/**
 * The NVIDIA identifier one call will use. Only a catalog key is accepted from the
 * caller — the identifier itself is produced by the catalog module, for the
 * `nvidia` provider only — so no browser value, no stray string, and no model of
 * another provider can name a NVIDIA model. Resolved once per call, before any key
 * is selected, so an unusable model fails immediately instead of looking like a
 * retryable provider fault.
 */
function modelIdentifier(model: string | undefined): string {
  return resolveCatalogIdentifier(model ?? defaultModelKey(), PROVIDER);
}

/**
 * Builds the one request body both paths use; only `stream` differs. Just the three
 * fields NVIDIA documents for this endpoint: the model, the turns, and the flag.
 * Nothing internal travels with them — no database columns, no companion or
 * personality data, and no sampling parameters this application does not set.
 */
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
  const timeout = AbortSignal.timeout(options.timeoutMs ?? NVIDIA_TIMEOUT_MS);
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
 * inspected or retained: no message text, no body, and no untrusted `cause`
 * that could later leak through logging or serialization.
 */
function mapFetchFailure(error: unknown, signals: Signals): AiProviderError {
  if (signals.timeout.aborted) return new AiProviderError("timeout");
  if (signals.request.aborted || (error instanceof Error && error.name === "AbortError"))
    return new AiProviderError("aborted");
  return new AiProviderError("network-error");
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
  if (signals.request.aborted) throw mapFetchFailure(signals.request.reason, signals);
  let response: Response;
  try {
    response = await fetch(chatCompletionsUrl(config.baseUrl), {
      method: "POST",
      headers: {
        // The key exists only in this header, on the server, for this one attempt.
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(requestBody(model, turns, stream)),
      signal: signals.request,
    });
  } catch (error) {
    throw mapFetchFailure(error, signals);
  }
  // A gateway or test double may return a response despite a canceled signal.
  // Never accept it (or turn its HTTP status into a key-specific retry).
  if (signals.request.aborted) {
    void response.body?.cancel().catch(() => {});
    throw mapFetchFailure(signals.request.reason, signals);
  }
  return response;
}

/** A non-2xx answer is reported by status only; the body may echo provider input. */
function assertOk(response: Response, label: string) {
  if (response.ok) return;
  console.error(`[nvidia] ${label} request failed with status ${response.status}.`);
  // The body is never read — it can echo the request, and NVIDIA error bodies can
  // name the credential's account — but it is released so a rejected attempt does
  // not leave a socket open while another key is tried.
  void response.body?.cancel().catch(() => {});
  throw new AiProviderError("http-error", { status: response.status });
}

/**
 * How a failed attempt should be handled. Only two kinds of failure are worth
 * another key, and only one of them is the key's own fault:
 *
 * - `quarantine`: the provider rejected *this key* — invalid or revoked (401, 403)
 *   or rate limited (429), which is how NVIDIA's free tier reports an exhausted
 *   quota. The key is skipped until its cooldown expires and another key is tried.
 * - `rotate`: the failure is not key-specific — a provider-side error (5xx, which
 *   includes the 504s a busy NIM endpoint returns) or a network fault. Another key
 *   may still answer, but this one stays eligible.
 * - `none`: another key cannot help. A malformed, empty, or oversized answer, a
 *   request the provider refused as invalid (other 4xx, such as the 404 an unknown
 *   model identifier earns), a deadline that already consumed the request, or a
 *   caller that cancelled are all reported as they are.
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
  // A rejected upstream promise may include request details in its message.
  // Classify it, but never retain it as an error cause.
  return error instanceof AiProviderError ? error : new AiProviderError("network-error");
}

/**
 * The last resort: no key was eligible, so no request was made at all. Only
 * reachable while every configured NVIDIA key is cooling down after a provider
 * rejection; the reported status is the one that caused the most recent quarantine.
 */
function unavailableKeyError(pool: KeyPool, label: string): AiProviderError {
  console.error(
    `[nvidia] No eligible API key for the ${label}; every configured key is cooling down after a provider rejection.`,
  );
  return new AiProviderError("http-error", { status: pool.lastStatus });
}

/**
 * Only `choices[0].message.content` is of interest. An upstream error or a
 * `finish_reason: "error"` cannot become a successful reply even when some text
 * was included before the failure. Nothing else in the payload is forwarded.
 */
function readAssistantContent(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const result = payload as { choices?: unknown; error?: unknown };
  if (result.error != null) return null;
  const choices = result.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (typeof first !== "object" || first === null) return null;
  const choice = first as { message?: { content?: unknown }; finish_reason?: unknown };
  if (choice.finish_reason === "error") return null;
  const content = choice.message?.content;
  return typeof content === "string" ? content : null;
}

/**
 * Reads the JSON response with a byte limit as it arrives — `Response.text()`
 * would buffer an arbitrarily large body before a length check. A canceled body
 * read is unblocked explicitly, even when a gateway/fetch stub ignores the
 * request signal. Never retain more than the accepted bound in memory.
 */
async function readBoundedText(response: Response, signals: Signals): Promise<string> {
  const body = response.body;
  if (!body) throw new AiProviderError("malformed-response");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const abortRead = () => {
    void reader.cancel().catch(() => {});
  };
  signals.request.addEventListener("abort", abortRead, { once: true });

  try {
    for (;;) {
      if (signals.request.aborted) throw mapFetchFailure(signals.request.reason, signals);
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        // A broken body is a network failure, or a timeout/caller abort when its
        // signal fired. It is not malformed JSON, so another key may retry it.
        throw mapFetchFailure(error, signals);
      }
      if (signals.request.aborted) throw mapFetchFailure(signals.request.reason, signals);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        console.error("[nvidia] Reply response exceeded the accepted size.");
        throw new AiProviderError("malformed-response");
      }
      chunks.push(chunk.value);
    }
  } finally {
    signals.request.removeEventListener("abort", abortRead);
    reader.releaseLock();
    void body.cancel().catch(() => {});
  }

  if (signals.request.aborted) throw mapFetchFailure(signals.request.reason, signals);
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/** Reads the assistant text; the raw provider body is never logged or forwarded. */
async function readJsonReply(response: Response, signals: Signals): Promise<string> {
  const text = await readBoundedText(response, signals);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    // A JSON parser error can contain snippets of the provider response in its
    // message. That body may echo our input or credential, so don't keep the
    // SyntaxError as `cause` and don't print the original text either.
    console.error("[nvidia] Reply response was not valid JSON.");
    throw new AiProviderError("malformed-response");
  }

  const content = readAssistantContent(payload);
  if (content === null) {
    console.error("[nvidia] Reply response had no assistant message.");
    throw new AiProviderError("malformed-response");
  }
  if (content.trim() === "") {
    console.error("[nvidia] Reply response was empty.");
    throw new AiProviderError("empty-response");
  }

  return content.trim();
}

/**
 * The text of one streamed chunk. NVIDIA sends `choices[0].delta.content`; a
 * `message.content` field is accepted too, because a non-streaming answer may arrive
 * on this path when a gateway ignores `stream: true`.
 *
 * Anything else a chunk may carry is ignored on purpose. NVIDIA endpoints are known
 * to add non-standard fields alongside `delta.content` (a `reasoning` trace, for
 * instance), and those are provider metadata, not assistant text: forwarding them
 * would put a model's scratchpad in front of the user and in the database.
 */
function readChunk(payload: unknown): { text: string; finished: boolean } {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    console.error("[nvidia] Streaming reply contained an invalid chunk shape.");
    throw new AiProviderError("malformed-response");
  }
  const result = payload as { choices?: unknown; error?: unknown };
  if (result.error != null) {
    // Some gateways send a 200 SSE response and then an error frame. The error
    // object can include credentials or the prompt, so neither it nor a cause is
    // ever logged or forwarded. Any text already yielded stays provisional.
    console.error("[nvidia] Streaming reply contained a provider error frame.");
    throw new AiProviderError("malformed-response");
  }
  const choices = result.choices;
  if (!Array.isArray(choices)) {
    console.error("[nvidia] Streaming reply contained an invalid chunk shape.");
    throw new AiProviderError("malformed-response");
  }
  // OpenAI-compatible usage-only frames may carry `choices: []` after the final
  // token. They contain no assistant text, and are safe to ignore.
  if (choices.length === 0) return { text: "", finished: false };

  const first = choices[0];
  if (typeof first !== "object" || first === null || Array.isArray(first)) {
    console.error("[nvidia] Streaming reply contained an invalid choice.");
    throw new AiProviderError("malformed-response");
  }
  const choice = first as {
    delta?: { content?: unknown };
    message?: { content?: unknown };
    finish_reason?: unknown;
  };
  if (choice.finish_reason === "error") {
    console.error("[nvidia] Streaming reply ended with a provider error.");
    throw new AiProviderError("malformed-response");
  }
  // The official chunk shape is a delta plus a nullable finish reason. A final
  // chunk may have only `finish_reason`; a role/usage-only chunk may have no text.
  // Unexpected objects are not silently skipped — that could make `[DONE]` turn a
  // half answer into a stored, apparently complete reply.
  if (
    (choice.delta !== undefined &&
      (typeof choice.delta !== "object" || choice.delta === null || Array.isArray(choice.delta))) ||
    (choice.message !== undefined &&
      (typeof choice.message !== "object" ||
        choice.message === null ||
        Array.isArray(choice.message))) ||
    (choice.finish_reason !== undefined &&
      choice.finish_reason !== null &&
      typeof choice.finish_reason !== "string") ||
    (choice.delta === undefined && choice.message === undefined && !choice.finish_reason)
  ) {
    console.error("[nvidia] Streaming reply contained an invalid choice.");
    throw new AiProviderError("malformed-response");
  }

  const delta = choice.delta?.content;
  const message = choice.message?.content;
  if (
    (delta != null && typeof delta !== "string") ||
    (message != null && typeof message !== "string")
  ) {
    console.error("[nvidia] Streaming reply contained non-text assistant content.");
    throw new AiProviderError("malformed-response");
  }
  const text = typeof delta === "string" ? delta : typeof message === "string" ? message : "";
  // A final chunk may carry only `finish_reason`; that is a valid completion marker
  // for a stream that closes without `[DONE]`.
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
  // A blank `data:` keep-alive is not a JSON chunk. Ignore it; non-empty data
  // that is not JSON still fails loudly as a malformed provider response.
  if (data === null || data === "") return { kind: "none" };
  if (data === STREAM_DONE) return { kind: "data", text: "", done: true };

  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    // JSON.parse errors may quote the upstream data (including an echoed key).
    console.error("[nvidia] Streaming reply contained an unreadable chunk.");
    throw new AiProviderError("malformed-response");
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
    console.error("[nvidia] Streaming reply had no response body.");
    throw new AiProviderError("malformed-response");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  let text = "";
  let complete = false;
  let finishedReading = false;
  // Some fetch implementations leave a body read pending even after the request's
  // signal aborts. Cancel it ourselves as well, so a disconnect or deadline always
  // unblocks iteration. The signal check in the loop maps cancellation to its
  // normalized reason even if reader.cancel resolves a pending read as `done`.
  const abortRead = () => {
    void reader.cancel().catch(() => {});
  };
  signals.request.addEventListener("abort", abortRead, { once: true });

  try {
    while (!complete) {
      if (signals.request.aborted) throw mapFetchFailure(signals.request.reason, signals);
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
          // text is still a complete event. A final lone CR is an SSE line break.
          buffer = buffer.replace(/\r$/, "\n");
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
        if (signals.request.aborted) throw mapFetchFailure(signals.request.reason, signals);
        if (chunk.done) {
          finishedReading = true;
          buffer += decoder.decode();
          continue;
        }

        bytes += chunk.value.byteLength;
        if (bytes > MAX_STREAM_BYTES) {
          console.error("[nvidia] Streaming reply exceeded the accepted size.");
          throw new AiProviderError("too-long");
        }

        // Leave a CR at the end of the buffer unresolved until the next read: if
        // its following LF arrives in another byte chunk, they are *one* line
        // break, not two. A lone CR inside the buffer is a line break on its own.
        buffer += decoder.decode(chunk.value, { stream: true });
        buffer = buffer.replace(/\r\n/g, "\n").replace(/\r(?!$)/g, "\n");
      }

      if (frame === null) break;
      if (signals.request.aborted) throw mapFetchFailure(signals.request.reason, signals);

      const result = applyFrame(frame);
      if (result.kind === "none") continue;
      if (result.text !== "") {
        text += result.text;
        if (text.length > NVIDIA_MAX_REPLY_CHARACTERS) {
          console.error("[nvidia] Streaming reply exceeded the reply size limit.");
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
    signals.request.removeEventListener("abort", abortRead);
    reader.releaseLock();
    void body.cancel().catch(() => {});
  }

  if (signals.request.aborted) throw mapFetchFailure(signals.request.reason, signals);
  if (!complete) {
    console.error("[nvidia] Streaming reply ended before a completion marker.");
    throw new AiProviderError("malformed-response");
  }
  if (text.trim() === "") {
    console.error("[nvidia] Streaming reply was empty.");
    throw new AiProviderError("empty-response");
  }
}

/**
 * Streams the assistant answer of one conversation turn, rotating through the
 * configured NVIDIA keys when a request fails for a reason another key could avoid.
 *
 * The key pool decides which key each attempt uses, and one request tries at most
 * `min(configured keys, NVIDIA_MAX_KEY_ATTEMPTS)` of them. Two rules keep this safe:
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
  // The catalog decides the identifier; a key it does not offer for NVIDIA fails
  // here, before any network call and without touching the key pool.
  const model = modelIdentifier(options.model);
  const pool = getKeyPool(config.keys, PROVIDER);
  const signals = requestSignals(options);
  const tried = new Set<string>();
  let lastFailure: AiProviderError | null = null;

  for (let attempt = 0; attempt < Math.min(pool.size, NVIDIA_MAX_KEY_ATTEMPTS); attempt += 1) {
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

  return readJsonReply(response, signals);
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
  const pool = getKeyPool(config.keys, PROVIDER);
  const signals = requestSignals(options);
  const tried = new Set<string>();
  let lastFailure: AiProviderError | null = null;

  for (let attempt = 0; attempt < Math.min(pool.size, NVIDIA_MAX_KEY_ATTEMPTS); attempt += 1) {
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

export const nvidiaProvider: ReplyProvider = {
  name: "nvidia",
  generateReply,
  streamReply(
    turns: readonly ChatTurn[],
    options?: GenerateReplyOptions,
  ): ReplyStream {
    return streamReply(turns, options);
  },
};
