import "server-only";

/**
 * The whole provider surface this project needs. A future provider (or a test
 * double) implements the same two calls, so neither the reply service nor the
 * route ever depends on OpenRouter specifics — and provider-specific stream
 * parsing stays inside the adapter that owns it.
 */

/** One conversational turn. Only a role and text — never ids, positions, or timestamps. */
export type ChatTurn = {
  role: "user" | "assistant";
  content: string;
};

export type GenerateReplyOptions = {
  /** Abort the request (for example when the caller gives up or the client leaves). */
  signal?: AbortSignal;
  /** Override the provider timeout; the default stays in the adapter. */
  timeoutMs?: number;
  /**
   * Which model to generate with, as a **catalog key** from the server-owned
   * catalog (never a provider identifier, and never anything a browser sent
   * directly). The adapter resolves it to the OpenRouter identifier itself, so
   * only catalog models can reach the provider. Omitted means the catalog default.
   */
  model?: string;
};

/**
 * The normalized provider stream. One shape only: a piece of assistant text.
 *
 * The rest of the application does not need to understand SSE framing, OpenRouter
 * chunk shapes, `[DONE]` markers, or provider metadata. A stream ends by returning
 * normally (completion) and reports every failure by throwing
 * `AiNotConfiguredError` / `AiProviderError`, so consumers use one `try`/`catch`
 * around the iteration instead of matching on provider payloads.
 */
export type ReplyStreamChunk = { type: "delta"; text: string };

/** The provider stream as an async iterable; the adapter implements it as a generator. */
export type ReplyStream = AsyncIterable<ReplyStreamChunk>;

/**
 * Both reply paths of one provider. `generateReply` returns the whole text in one
 * call; `streamReply` yields it incrementally. Both throw
 * `AiNotConfiguredError` / `AiProviderError`.
 */
export type ReplyProvider = {
  readonly name: string;
  generateReply(
    turns: readonly ChatTurn[],
    options?: GenerateReplyOptions,
  ): Promise<string>;
  streamReply(
    turns: readonly ChatTurn[],
    options?: GenerateReplyOptions,
  ): ReplyStream;
};
