import { createServer } from "node:http";

/**
 * A tiny OpenRouter-compatible stub for the browser suite. It speaks the same
 * chat-completions request/response shape as the real provider — including
 * server-sent-event streaming — so the browser tests stay deterministic and CI
 * never needs an OpenRouter key or network access. Nothing in `src/` knows about
 * this server: the app reaches it only because the test run points
 * `OPENROUTER_BASE_URL` at it.
 *
 * Deterministic behavior, chosen by the last user message:
 *   contains "[fail]"      → 500 on the request (no stream starts)
 *   contains "[flaky]"     → fails the first attempt for that text on *each* key and
 *                            then succeeds, so one failure still reaches the browser
 *                            (key rotation is not allowed to hide it) and one user
 *                            retry recovers
 *   contains "[streamfail]"→ streams two deltas, then drops the connection
 *                            (once per distinct text, so a retry can succeed)
 *   contains "[empty]"     → a complete stream with no content
 *   contains "[slow]"      → first delta, a long pause, then the rest
 *   contains "[rotate]"    → refuses the first attempt for that text (429) whatever
 *                            key it used, then answers from the next key
 *   otherwise              → "Mock reply: <last user message>" in small deltas
 *
 * Every streamed chunk carries provider-only fields (ids, model name, usage) that
 * the application must never forward to the browser — the tests assert that.
 *
 * `GET /model-log` reports the model identifier of every request the stub received
 * (most recent last) and `POST /model-log/clear` empties it, so a browser test can
 * prove which model a reply actually used without trusting the UI.
 */
const port = Number(process.env.MOCK_OPENROUTER_PORT ?? 3210);
const failedOnce = new Set();

/**
 * The first key configured for the suite (see OPENROUTER_API_KEYS in
 * playwright.config.ts). The stub labels it so `GET /rotation` can report which key
 * refused an attempt and which one answered, without publishing key values.
 */
const FIRST_KEY = process.env.MOCK_OPENROUTER_FIRST_KEY ?? "playwright-stub-key-one-not-a-secret";

/**
 * The last "[rotate]" exchange, observed on the wire because the browser only ever
 * sees the normalized reply: `{ rejected, accepted }` with the labels `"first"` and
 * `"other"`. A request that never retried leaves `accepted` null.
 */
let rotation = null;
const rotatedTexts = new Set();

/** Model identifiers the stub was asked for, in order. */
const modelLog = [];

/** Characters per streamed delta for the ordinary reply. */
const CHUNK_SIZE = 7;
const CHUNK_DELAY_MS = 15;
/**
 * Long enough that a browser test can observe the first delta, and the marked
 * provisional bubble, well before the rest of the answer arrives.
 */
const SLOW_PAUSE_MS = 2500;

function send(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One OpenAI-compatible stream chunk, with provider-only metadata attached. */
function chunkEvent(model, delta, finishReason = null) {
  return `data: ${JSON.stringify({
    id: "mock-completion-id-should-never-be-forwarded",
    object: "chat.completion.chunk",
    created: 1_759_000_000,
    model,
    system_fingerprint: "mock-fingerprint-should-never-be-forwarded",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

const STREAM_DONE = "data: [DONE]\n\n";

/**
 * Streams `content` as several small deltas. `mode` decides how the stream ends:
 * `"done"` finishes normally, `"cut"` destroys the connection without a
 * completion marker, `"empty"` sends an empty delta and completes.
 */
async function streamContent(response, payload, content, mode = "done") {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });

  const pieces = [];
  for (let index = 0; index < content.length; index += CHUNK_SIZE)
    pieces.push(content.slice(index, index + CHUNK_SIZE));

  if (mode === "empty") {
    response.write(chunkEvent(payload.model, { role: "assistant", content: "" }));
    response.write(chunkEvent(payload.model, {}, "stop"));
    response.write(STREAM_DONE);
    response.end();
    return;
  }

  const slow = content.includes("[slow]");
  for (let index = 0; index < pieces.length; index += 1) {
    if (mode === "cut" && index === 2) {
      // Halfway through: the client must see an error, not a stored partial reply.
      response.destroy();
      return;
    }
    response.write(chunkEvent(payload.model, { content: pieces[index] }));
    if (index === 0 && slow) await sleep(SLOW_PAUSE_MS);
    else await sleep(CHUNK_DELAY_MS);
  }

  if (mode === "cut") {
    response.destroy();
    return;
  }

  response.write(chunkEvent(payload.model, {}, "stop"));
  response.write(STREAM_DONE);
  response.end();
}

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    send(response, 200, { status: "ok" });
    return;
  }

  if (request.method === "GET" && request.url === "/rotation") {
    send(response, 200, rotation ?? { rejected: null, accepted: null });
    return;
  }

  if (request.method === "GET" && request.url === "/model-log") {
    send(response, 200, { models: modelLog });
    return;
  }

  if (request.method === "POST" && request.url === "/model-log/clear") {
    modelLog.length = 0;
    send(response, 200, { models: [] });
    return;
  }

  if (request.method !== "POST" || !(request.url ?? "").endsWith("/chat/completions")) {
    send(response, 404, { error: { message: "Not found" } });
    return;
  }

  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    void handle(request, response, body);
  });
});

async function handle(request, response, body) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    send(response, 400, { error: { message: "Invalid JSON" } });
    return;
  }

  const turns = Array.isArray(payload?.messages) ? payload.messages : [];
  const lastUser = [...turns].reverse().find((turn) => turn?.role === "user");
  const content = typeof lastUser?.content === "string" ? lastUser.content : "";
  const streaming = payload?.stream === true;
  if (typeof payload?.model === "string") modelLog.push(payload.model);
  const key = (request.headers.authorization ?? "").replace(/^Bearer /, "");
  const keyLabel = key === FIRST_KEY ? "first" : "other";

  // A key the provider refuses: one request must recover by trying another key,
  // while a single-key configuration would only be able to report the failure.
  if (content.includes("[rotate]")) {
    if (!rotatedTexts.has(content)) {
      rotatedTexts.add(content);
      rotation = { rejected: keyLabel, accepted: null };
      send(response, 429, { error: { message: `rate limited key ${key}` } });
      return;
    }
    rotation = { rejected: rotation?.rejected ?? null, accepted: keyLabel };
  }

  if (content.includes("[fail]")) {
    send(response, 500, { error: { message: "Mock provider failure" } });
    return;
  }

  // A failure before the stream starts: the provider is reachable but refuses this
  // attempt. Every configured key refuses it once (the application may rotate
  // through them), so the failure still reaches the user and a retry succeeds.
  if (content.includes("[flaky]") && !failedOnce.has(`flaky|${key}|${content}`)) {
    failedOnce.add(`flaky|${key}|${content}`);
    send(response, 503, { error: { message: "Mock provider is temporarily unavailable" } });
    return;
  }

  // The retry after a refused key is labelled, so a browser test can tell that the
  // answer came from the second attempt rather than from the refused key.
  const reply = content.includes("[rotate]")
    ? `Mock reply (fallback key): ${content}`
    : `Mock reply: ${content}`;

  if (streaming) {
    if (content.includes("[streamfail]") && !failedOnce.has(`cut|${content}`)) {
      failedOnce.add(`cut|${content}`);
      await streamContent(response, payload, `Partial answer for ${content} `, "cut");
      return;
    }
    if (content.includes("[empty]")) {
      await streamContent(response, payload, "", "empty");
      return;
    }
    await streamContent(response, payload, reply, "done");
    return;
  }

  if (content.includes("[empty]")) {
    send(response, 200, {
      id: "mock-completion",
      model: payload.model,
      choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
    });
    return;
  }

  send(response, 200, {
    id: "mock-completion",
    model: payload.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: reply },
        finish_reason: "stop",
      },
    ],
  });
}

server.listen(port, "127.0.0.1", () => {
  console.log(`Mock OpenRouter listening on http://127.0.0.1:${port}/api/v1`);
});
