import "server-only";

/**
 * Read a JSON route's body only up to its accepted UTF-8 byte size. `Request.text()`
 * buffers the entire upload before a caller can check its length, and trimming first
 * lets a huge whitespace-padded `{}` bypass a post-read size check. The declared
 * length is only an early rejection; the actual stream is counted even if that
 * header is absent or incorrect. `null` means too large, never an empty body.
 */
export async function readBoundedRequestBody(request: Request, maxBytes: number): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number.isFinite(Number(declared)) && Number(declared) > maxBytes)
    return null;
  if (!request.body) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  let oversized = false;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        oversized = true;
        return null;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    // Stop an oversized upload rather than continuing to consume the socket.
    if (oversized) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
