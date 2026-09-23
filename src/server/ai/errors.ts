import "server-only";

/**
 * Failures a provider can report. Both messages are safe to log and to show to a
 * signed-in user: they never contain credentials, request bodies, or raw provider
 * payloads. The route decides the client-facing code and text.
 */

/** No usable provider configuration (for example no API key). */
export class AiNotConfiguredError extends Error {
  constructor(cause?: unknown) {
    super("AI replies are not configured on this server.");
    this.name = "AiNotConfiguredError";
    // Keep the underlying validation error (field names only) for server logs.
    this.cause = cause;
  }
}

export type AiFailureReason =
  | "timeout"
  | "aborted"
  | "http-error"
  | "malformed-response"
  | "empty-response"
  | "network-error"
  /** The provider kept producing text past the stored-size limit; the stream is cut. */
  | "too-long";

/** A configured provider could not produce a usable reply. */
export class AiProviderError extends Error {
  readonly reason: AiFailureReason;
  /** Provider HTTP status when one was received; never a response body. */
  readonly status?: number;

  constructor(reason: AiFailureReason, options: { status?: number; cause?: unknown } = {}) {
    super(`The AI provider did not return a usable reply (${reason}).`);
    this.name = "AiProviderError";
    this.reason = reason;
    this.status = options.status;
    this.cause = options.cause;
  }
}
