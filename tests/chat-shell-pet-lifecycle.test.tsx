// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatShell } from "../src/components/layout/chat-shell";
import { PET_REACTION_DURATIONS } from "../src/features/pets/reactions";
import type { ModelSelection } from "../src/features/models/types";
import type {
  ConversationList,
  ConversationSummary,
  MessageList as MessageThread,
  MessageSummary,
} from "../src/features/conversations/types";

/**
 * The chat lifecycle's edge cases, against the real shell: what the companion does
 * when generations overlap, when one is retried, cancelled, or left behind by
 * navigation, and when the pet or its personality changes underneath a reaction.
 *
 * The harness replaces only the conversations client and the router, so the shell's
 * own generation identity, the reporter scoped to it, the behavior controller, and the
 * engine's mapping are all the code that ships. Each reply request is held open until
 * the test ends it, which is what makes the awkward orders reachable at all: a stream
 * that finishes after it was replaced, a delta that arrives after its generation was
 * abandoned, a message that is stored after the user has already moved on.
 *
 * Nothing here touches the network, the database, or a provider.
 */

const network = vi.hoisted(() => ({
  userMessage: vi.fn(),
  replyStream: vi.fn(),
  newConversation: vi.fn(),
  deleteConversation: vi.fn(),
  router: { push: vi.fn(), refresh: vi.fn() },
}));

vi.mock("next/navigation", () => ({ useRouter: () => network.router }));

vi.mock("../src/features/conversations/client", () => ({
  requestUserMessage: network.userMessage,
  requestAssistantReplyStream: network.replyStream,
  requestNewConversation: network.newConversation,
  requestDeleteConversation: network.deleteConversation,
}));

const account = { name: "Ada Lovelace", email: "ada@example.com" };
const sidebar: ConversationList = { status: "ready", conversations: [], truncated: false };
const models: ModelSelection = {
  status: "ready",
  selectedKey: "gpt-4o-mini",
  models: [{ key: "gpt-4o-mini", name: "GPT-4o mini", description: "Fast and inexpensive." }],
};

const CONVERSATION_A: ConversationSummary = {
  id: "cmconversationaaaaaaaaaaaa",
  title: "First thread",
  createdAt: "2026-09-23T10:00:00.000Z",
  updatedAt: "2026-09-23T10:00:00.000Z",
};

const CONVERSATION_B: ConversationSummary = {
  id: "cmconversationbbbbbbbbbbbb",
  title: "Second thread",
  createdAt: "2026-09-23T11:00:00.000Z",
  updatedAt: "2026-09-23T11:00:00.000Z",
};

let idCounter = 0;

/** A fresh, well-formed id per call: stored messages are keyed by it. */
function nextId(): string {
  idCounter += 1;
  return `cm${String(idCounter).padStart(23, "0")}`;
}

function message(overrides: Partial<MessageSummary> = {}): MessageSummary {
  return {
    id: nextId(),
    role: "USER",
    content: "A stored thought.",
    position: 0,
    createdAt: "2026-09-23T10:00:00.000Z",
    updatedAt: "2026-09-23T10:00:00.000Z",
    ...overrides,
  };
}

function thread(messages: MessageSummary[] = []): MessageThread {
  return { status: "ready", messages, truncated: false };
}

/** One reply request the test controls: its deltas, its ending, and its signal. */
type OpenStream = {
  conversationId: string;
  signal: AbortSignal | undefined;
  delta: (text: string) => Promise<void>;
  end: (result: unknown) => Promise<void>;
};

let container: HTMLDivElement;
let root: Root;
let mounted: boolean;
let streams: OpenStream[] = [];
/** Held when a test wants the stored-message round trip to stay open. */
let resolveUserMessage: ((result: unknown) => void) | null = null;

type ShellProps = {
  conversation?: ConversationSummary | null;
  messages?: MessageThread;
  companionPetKey?: string;
  companionAppearanceKey?: string;
  companionPersonalityKey?: string;
};

/**
 * Renders (or re-renders) the shell. Re-rendering with a different conversation is
 * what the router does in the application: the same shell instance stays mounted and
 * only the props change, so the runtime reaction state and the generation in flight
 * carry over exactly as they do in the browser.
 */
function renderShell(props: ShellProps = {}) {
  act(() => {
    root.render(
      <ChatShell
        account={account}
        sidebar={sidebar}
        models={models}
        messages={thread()}
        {...props}
      />,
    );
  });
}

/** Opens conversation A with the calm cat, the way the shell is served by default. */
function openConversation(overrides: ShellProps = {}) {
  renderShell({ conversation: CONVERSATION_A, ...overrides });
}

/** Lets pending microtasks flush inside `act`, with no timer movement. */
async function settle() {
  await act(async () => {});
}

function type(text: string) {
  const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
  if (!textarea) throw new Error("no composer");
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  act(() => {
    setValue?.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Submits the composer and lets the stored-message round trip and request start. */
async function send(text = "Hello there") {
  type(text);
  await act(async () => {
    container.querySelector<HTMLButtonElement>(".send-button")?.click();
  });
}

/**
 * Clicks "Try again" twice without letting React re-render in between: the reachable
 * version of two generations overlapping, and the race the shell's replacement logic
 * exists for.
 */
async function retryTwice() {
  await act(async () => {
    const retry = () => container.querySelector<HTMLButtonElement>(".reply-retry");
    retry()?.click();
    retry()?.click();
  });
}

function companions(): NodeListOf<Element> {
  return container.querySelectorAll(".chat-companion");
}

function companion(): Element | null {
  return container.querySelector(".chat-companion");
}

/** The state the header companion is actually showing. */
function companionState(): string | null {
  return companion()?.getAttribute("data-state") ?? null;
}

function composerBusy(): boolean {
  return container.querySelector("form[aria-label='Message composer']")?.getAttribute("aria-busy") ===
    "true";
}

/** The failure banner, if one is shown. The generating status line is a different one. */
function replyError(): string | null {
  return container.querySelector(".reply-notice.is-error")?.textContent ?? null;
}

function streamingText(): string | null {
  return (
    container.querySelector("article[data-stream-state='streaming'] .message-content")
      ?.textContent ?? null
  );
}

function storedAssistantMessages(): NodeListOf<Element> {
  return container.querySelectorAll(
    ".conversation-messages article[aria-label='Assistant message']:not([data-stream-state='streaming'])",
  );
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** The successful end of a stream: the server confirmed one stored reply. */
function storedReply(content = "Hello world") {
  return {
    ok: true,
    value: message({ id: nextId(), role: "ASSISTANT", content, position: 1 }),
  };
}

function providerError(messageText = "The assistant reply failed.") {
  return { ok: false, status: 500, message: messageText };
}

function cancelledResult() {
  return { ok: false, status: 0, message: "We couldn’t reach the server.", aborted: true };
}

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // The shell measures the viewport and scrolls; neither matters to a reaction.
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    media: "",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  });
  window.scrollTo = vi.fn();

  streams = [];
  resolveUserMessage = null;
  idCounter = 0;
  network.router.push.mockClear();
  network.router.refresh.mockClear();
  network.userMessage.mockImplementation(async () => ({ ok: true, value: message() }));
  // Every reply request stays open until the test ends it, and ignores its abort
  // signal on purpose: a cancelled stream that never calls back cannot prove that a
  // late callback is ignored.
  network.replyStream.mockImplementation(
    (
      conversationId: string,
      handlers: { onDelta: (text: string) => void },
      options?: { signal?: AbortSignal },
    ) =>
      new Promise((resolve) => {
        streams.push({
          conversationId,
          signal: options?.signal,
          delta: async (text: string) => {
            await act(async () => {
              handlers.onDelta(text);
            });
          },
          end: async (result: unknown) => {
            await act(async () => {
              resolve(result);
            });
          },
        });
      }),
  );

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mounted = true;
});

afterEach(() => {
  if (mounted) act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("rapid, overlapping generations", () => {
  it("lets the newer generation stay authoritative when a retry replaces an in-flight one", async () => {
    openConversation();
    await send();
    await streams[0].end(providerError());
    expect(companionState()).toBe("sad");

    // Two retry clicks before React re-renders: the second generation replaces the
    // first while its request is still open.
    await retryTwice();
    expect(streams).toHaveLength(3);
    // The replaced request really was aborted through the existing mechanism.
    expect(streams[1].signal?.aborted).toBe(true);
    expect(streams[2].signal?.aborted).toBe(false);
    expect(companionState()).toBe("thinking");
    expect(composerBusy()).toBe(true);

    // A delta from the replaced stream is not this reply's text.
    await streams[1].delta("STALE ");
    expect(streamingText()).toBeNull();
    await streams[2].delta("Hello ");
    expect(streamingText()).toBe("Hello ");
  });

  it("ignores a replaced generation that completes afterwards", async () => {
    openConversation();
    await send();
    await streams[0].end(providerError());
    await retryTwice();
    await streams[2].delta("Hello ");

    // The generation that was replaced reports success late. The companion is
    // following the newer one, so it must not celebrate somebody else's reply, and the
    // reply must not be stored on screen either.
    await streams[1].end(storedReply("A late answer"));
    expect(companionState()).toBe("thinking");
    expect(streamingText()).toBe("Hello ");
    expect(storedAssistantMessages()).toHaveLength(0);

    // The newer generation is still valid and still completes normally.
    await streams[2].end(storedReply());
    expect(companionState()).toBe("happy");
    expect(storedAssistantMessages()).toHaveLength(1);
    expect(composerBusy()).toBe(false);

    advance(PET_REACTION_DURATIONS.brief);
    expect(companionState()).toBe("idle");
  });

  it("ignores a replaced generation that fails afterwards", async () => {
    openConversation();
    await send();
    await streams[0].end(providerError());
    await retryTwice();

    // The replaced generation reports a failure late: no second error banner, and no
    // sad reaction over the generation that is actually in flight.
    await streams[1].end(providerError("A late failure"));
    expect(companionState()).toBe("thinking");
    expect(replyError()).toBeNull();

    await streams[2].end(storedReply());
    expect(companionState()).toBe("happy");
    expect(replyError()).toBeNull();
  });
});

describe("retrying a failed generation", () => {
  it("gives the retry a clean lifecycle of its own", async () => {
    openConversation();
    await send();
    await streams[0].delta("Hel");
    await streams[0].end(providerError());
    expect(companionState()).toBe("sad");

    act(() => {
      container.querySelector<HTMLButtonElement>(".reply-retry")?.click();
    });
    await settle();

    // thinking → response-started → completed, with nothing inherited from the failure.
    expect(companionState()).toBe("thinking");
    await streams[1].delta("Hello world");
    expect(companionState()).toBe("thinking");
    await streams[1].end(storedReply());
    expect(companionState()).toBe("happy");
    expect(storedAssistantMessages()).toHaveLength(1);

    advance(PET_REACTION_DURATIONS.brief);
    expect(companionState()).toBe("idle");
  });

  it("keeps the failed generation from producing a success reaction afterwards", async () => {
    openConversation();
    await send();
    await streams[0].end(providerError());

    act(() => {
      container.querySelector<HTMLButtonElement>(".reply-retry")?.click();
    });
    await settle();
    expect(companionState()).toBe("thinking");

    // The failed stream delivers a late delta and cannot be resolved twice, but its
    // reporter is sealed: nothing it does reaches the companion or the visible reply.
    await streams[0].delta("a late delta");
    expect(companionState()).toBe("thinking");
    expect(streamingText()).toBeNull();

    await streams[1].end(storedReply());
    expect(companionState()).toBe("happy");
    expect(storedAssistantMessages()).toHaveLength(1);
  });
});

describe("cancellation", () => {
  it("settles on a cancelled stream and ignores a completion that follows it", async () => {
    openConversation();
    await send();
    await streams[0].delta("Hel");
    await streams[0].end(cancelledResult());
    expect(companionState()).toBe("idle");
    expect(replyError()).toBeNull();

    // A cancelled generation is finished: a late delta reports nothing.
    await streams[0].delta("late");
    expect(companionState()).toBe("idle");
    expect(streamingText()).toBeNull();
  });

  it("ignores an error reported after the generation was cancelled", async () => {
    openConversation();
    await send();
    await streams[0].end(cancelledResult());
    expect(companionState()).toBe("idle");

    // The same stream cannot fail afterwards; the shell has already dropped it.
    await streams[0].delta("late");
    await settle();
    expect(companionState()).toBe("idle");
    expect(replyError()).toBeNull();
    expect(composerBusy()).toBe(false);
  });

  it("settles instead of waiting when the shell unmounts mid-generation", async () => {
    openConversation();
    await send();
    expect(companionState()).toBe("thinking");

    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    act(() => {
      root.unmount();
      mounted = false;
    });
    expect(streams[0].signal?.aborted).toBe(true);
    expect(container.querySelector(".chat-companion")).toBeNull();

    // The abandoned stream answers anyway, after the shell is gone: no state is
    // written, no settle timer is scheduled that nothing would ever clear, and React
    // has nothing to complain about.
    timeoutSpy.mockClear();
    await streams[0].end(storedReply());
    expect(timeoutSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    timeoutSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe("switching conversation during a generation", () => {
  it("settles the companion and keeps the abandoned stream out of the next conversation", async () => {
    openConversation();
    await send("A question for the first thread");
    expect(companionState()).toBe("thinking");

    // The same shell instance, now showing another conversation.
    renderShell({ conversation: CONVERSATION_B, messages: thread() });

    // Generation A was aborted through the existing mechanism, and the companion
    // settled rather than staying stuck in `thinking` for a reply that will not come.
    expect(streams[0].signal?.aborted).toBe(true);
    expect(companionState()).toBe("idle");
    expect(replyError()).toBeNull();

    // A finishes successfully into a conversation that is no longer on screen. In the
    // browser this is the moment the aborted request settles, which is also what
    // releases the submit lock the abandoned turn was holding.
    await streams[0].end(storedReply("An answer for A"));
    expect(companionState()).toBe("idle");
    expect(storedAssistantMessages()).toHaveLength(0);
    expect(streamingText()).toBeNull();
    expect(composerBusy()).toBe(false);

    // B is fully usable, and its generation gets a fresh lifecycle of its own.
    await send("A question for the second thread");
    expect(streams).toHaveLength(2);
    expect(streams[1].conversationId).toBe(CONVERSATION_B.id);
    expect(companionState()).toBe("thinking");
    await streams[1].delta("Hello ");
    await streams[1].end(storedReply());
    expect(companionState()).toBe("happy");
    expect(storedAssistantMessages()).toHaveLength(1);
  });

  it("keeps an abandoned generation's failure out of the next conversation", async () => {
    openConversation();
    await send();
    renderShell({ conversation: CONVERSATION_B, messages: thread() });
    expect(companionState()).toBe("idle");

    // A fails after the user left: no error banner in B, no sad companion.
    await streams[0].end(providerError("A failure for A"));
    expect(companionState()).toBe("idle");
    expect(replyError()).toBeNull();

    await send("A question for B");
    expect(companionState()).toBe("thinking");
  });

  it("does not start a reply for a conversation the user already left", async () => {
    // The stored-message round trip stays open, so the navigation lands mid-submit.
    network.userMessage.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUserMessage = resolve;
        }),
    );
    openConversation();
    type("A question that is still being stored");
    act(() => {
      container.querySelector<HTMLButtonElement>(".send-button")?.click();
    });
    expect(network.replyStream).not.toHaveBeenCalled();

    renderShell({ conversation: CONVERSATION_B, messages: thread() });

    // The message is stored, but its reply belongs to the thread that asked for it.
    await act(async () => {
      resolveUserMessage?.({ ok: true, value: message() });
    });

    expect(network.replyStream).not.toHaveBeenCalled();
    expect(companionState()).toBe("idle");
    expect(composerBusy()).toBe(false);

    // The conversation now on screen still generates normally.
    network.userMessage.mockImplementation(async () => ({ ok: true, value: message() }));
    await send("A question for B");
    expect(network.replyStream).toHaveBeenCalledTimes(1);
    expect(streams[0].conversationId).toBe(CONVERSATION_B.id);
    expect(companionState()).toBe("thinking");
  });

  it("reports an unauthenticated failure and leaves nothing waiting behind it", async () => {
    openConversation();
    await send();
    await streams[0].end({ ok: false, status: 401, message: "Sign in to continue." });

    // The failure is reported once, and the redirect that follows it takes the shell
    // away: nothing may keep the companion in the reaction the failure left.
    expect(companionState()).toBe("sad");
    expect(network.router.push).toHaveBeenCalledWith("/login");

    advance(PET_REACTION_DURATIONS.lingering);
    expect(companionState()).toBe("idle");
  });
});

describe("changing pet or personality around a reaction", () => {
  it("uses the new pet immediately and leaves the old reaction behind", async () => {
    openConversation({ companionPetKey: "yori-cat", companionPersonalityKey: "sleepy" });
    await send();
    await streams[0].delta("Hel");
    // A drowsy companion keeps dozing through `response-started`.
    expect(companionState()).toBe("sleeping");

    renderShell({
      conversation: CONVERSATION_A,
      companionPetKey: "ember-fox",
      companionPersonalityKey: "playful",
    });

    expect(companion()?.getAttribute("data-pet")).toBe("ember-fox");
    expect(companion()?.getAttribute("aria-label")).toBe("Ember, a fox");
    expect(companionState()).toBe("idle");

    // The abandoned stream settles late; the new pet must not inherit the dozing
    // record the sleepy cat left behind.
    await streams[0].end(cancelledResult());
    expect(companionState()).toBe("idle");
  });

  it("resolves the next reaction with the new personality, not the old one", async () => {
    openConversation({ companionPetKey: "ember-fox", companionPersonalityKey: "curious" });
    await send();
    await streams[0].end(storedReply());
    // Curious is not a high-motion personality, so a success is merely pleasing.
    expect(companionState()).toBe("happy");

    renderShell({
      conversation: CONVERSATION_A,
      companionPetKey: "ember-fox",
      companionPersonalityKey: "playful",
    });
    expect(companion()?.getAttribute("data-personality")).toBe("playful");
    expect(companionState()).toBe("idle");

    // The playful fox cannot sit still: the same lifecycle resolves differently now.
    await send("Another question");
    await streams[1].end(storedReply());
    expect(companionState()).toBe("excited");
  });

  it("does not let the previous selection's settle timer move the new one", async () => {
    openConversation({ companionPetKey: "yori-cat", companionPersonalityKey: "calm" });
    await send();
    await streams[0].end(storedReply());
    expect(companionState()).toBe("happy");

    // The cat's settle timer is still outstanding when the fox takes over.
    renderShell({
      conversation: CONVERSATION_A,
      companionPetKey: "ember-fox",
      companionPersonalityKey: "playful",
    });
    expect(companionState()).toBe("idle");

    await send("Another question");
    expect(companionState()).toBe("thinking");

    // The pending settle from the previous selection must not interrupt it.
    advance(PET_REACTION_DURATIONS.lingering * 2);
    expect(companionState()).toBe("thinking");
    expect(companion()?.getAttribute("data-pet")).toBe("ember-fox");
  });

  it("keeps reacting after a pet change, with no stale generation state", async () => {
    openConversation({ companionPetKey: "yori-cat" });
    await send();
    await streams[0].end(storedReply());

    renderShell({ conversation: CONVERSATION_A, companionPetKey: "ember-fox" });
    expect(companionState()).toBe("idle");

    await send("Another question");
    expect(companionState()).toBe("thinking");
    await streams[1].delta("Hello ");
    await streams[1].end(storedReply());
    expect(companionState()).toBe("happy");
    expect(companion()?.getAttribute("data-pet")).toBe("ember-fox");

    advance(PET_REACTION_DURATIONS.brief);
    expect(companionState()).toBe("idle");
  });
});

describe("the companion in the header", () => {
  it("is drawn once for an open conversation and never beside the welcome mark", async () => {
    openConversation();
    expect(companions()).toHaveLength(1);
    expect(container.querySelector(".welcome-pet")).toBeNull();

    // Streaming, completing, and settling never add a second one.
    await send();
    expect(companions()).toHaveLength(1);
    await streams[0].delta("Hello ");
    expect(companions()).toHaveLength(1);
    await streams[0].end(storedReply());
    expect(companions()).toHaveLength(1);
    advance(PET_REACTION_DURATIONS.brief);
    expect(companions()).toHaveLength(1);

    // Neither does a route change to another conversation.
    renderShell({ conversation: CONVERSATION_B, messages: thread() });
    expect(companions()).toHaveLength(1);

    // The empty welcome state keeps its own static figure and no header companion, so
    // a page never carries two pets with the same accessible name.
    renderShell({});
    expect(companions()).toHaveLength(0);
    expect(container.querySelectorAll(".welcome-pet")).toHaveLength(1);

    openConversation();
    expect(companions()).toHaveLength(1);
  });

  it("keeps one accessible name, no live region, and no layout churn across reactions", async () => {
    openConversation({
      companionPetKey: "yori-cat",
      companionAppearanceKey: "night",
      companionPersonalityKey: "calm",
    });
    const drawn = companion();
    expect(drawn?.getAttribute("aria-label")).toBe("Yori, a cat");
    expect(drawn?.getAttribute("role")).toBe("img");
    expect(drawn?.getAttribute("data-appearance")).toBe("night");
    // A reaction is seen, never announced: no live region on the companion, and the
    // state is not part of its name.
    expect(drawn?.getAttribute("aria-live")).toBeNull();
    expect(drawn?.getAttribute("role")).toBe("img");
    expect(container.querySelectorAll(".chat-companion[aria-live]")).toHaveLength(0);
    expect(drawn?.classList.contains("pet-renderer--sm")).toBe(true);

    await send();
    await streams[0].delta("Hello ");
    await streams[0].end(storedReply());

    // Same element, same footprint: a reaction changes attributes and classes, never
    // the node or the size, so nothing around it can shift.
    expect(companion()).toBe(drawn);
    expect(companion()?.getAttribute("aria-label")).toBe("Yori, a cat");
    expect(companion()?.classList.contains("pet-renderer--sm")).toBe(true);
    expect(companion()?.classList.contains("chat-companion")).toBe(true);
  });

  it("still draws every reaction as a pose, so nothing depends on motion", async () => {
    openConversation();
    const poses: Record<string, string> = {};

    await send();
    poses.thinking = companion()?.className ?? "";
    await streams[0].end(providerError());
    poses.sad = companion()?.className ?? "";
    expect(companion()?.getAttribute("data-motion")).toBe("off");
    await streams[0].delta("late");

    expect(poses.thinking).toContain("pet-pose-thinking");
    expect(poses.sad).toContain("pet-pose-sad");

    advance(PET_REACTION_DURATIONS.lingering);
    expect(companion()?.className).toContain("pet-pose-idle");
  });
});
