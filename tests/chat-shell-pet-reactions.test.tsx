// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatShell } from "../src/components/layout/chat-shell";
import type { ModelSelection } from "../src/features/models/types";
import type {
  ConversationList,
  ConversationSummary,
  MessageList as MessageThread,
  MessageSummary,
} from "../src/features/conversations/types";

/**
 * The real shell, driving the real behavior controller through the real streaming
 * lifecycle. The conversations client is the only thing replaced: it stands in for
 * the server so a test can decide when the reply request starts, when each delta
 * arrives, and how the stream ends. Everything after that — the phase the shell
 * reports, the adapter's guards, the engine's mapping, the state that reaches the
 * renderer — is the code that ships.
 *
 * Nothing here touches the network, the database, or a provider.
 */

const network = vi.hoisted(() => ({
  userMessage: vi.fn(),
  replyStream: vi.fn(),
  newConversation: vi.fn(),
  deleteConversation: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("../src/features/conversations/client", () => ({
  requestUserMessage: network.userMessage,
  requestAssistantReplyStream: network.replyStream,
  requestNewConversation: network.newConversation,
  requestDeleteConversation: network.deleteConversation,
}));

const account = { name: "Ada Lovelace", email: "ada@example.com" };

const conversation: ConversationSummary = {
  id: "cm1a2b3c4d5e6f7g8h9i0jkl",
  title: "New chat",
  createdAt: "2026-09-23T10:00:00.000Z",
  updatedAt: "2026-09-23T10:00:00.000Z",
};

function message(overrides: Partial<MessageSummary> = {}): MessageSummary {
  return {
    id: "cm9z8y7x6w5v4u3t2s1r0qpo",
    role: "USER",
    content: "A stored thought.",
    position: 0,
    createdAt: "2026-09-23T10:00:00.000Z",
    updatedAt: "2026-09-23T10:00:00.000Z",
    ...overrides,
  };
}

const sidebar: ConversationList = { status: "ready", conversations: [], truncated: false };
const models: ModelSelection = {
  status: "ready",
  selectedKey: "gpt-4o-mini",
  models: [{ key: "gpt-4o-mini", name: "GPT-4o mini", description: "Fast and inexpensive." }],
};
const thread: MessageThread = { status: "ready", messages: [], truncated: false };

/** Sleepy: `restingState: "sleeping"`, so `response-started` is visibly distinct. */
const SLEEPY = "sleepy";

let container: HTMLDivElement;
let root: Root;
let streamHandlers: { onDelta: (text: string) => void } | null;
let finishStream: ((result: unknown) => void) | null;

/** The state the header companion is actually showing. */
function companionState(): string | null {
  return container.querySelector(".chat-companion")?.getAttribute("data-state") ?? null;
}

function mount(personality: string = SLEEPY) {
  act(() => {
    root.render(
      <ChatShell
        account={account}
        sidebar={sidebar}
        models={models}
        conversation={conversation}
        messages={thread}
        companionPetKey="yori-cat"
        companionPersonalityKey={personality}
      />,
    );
  });
}

function rerender(personality: string) {
  act(() => {
    root.render(
      <ChatShell
        account={account}
        sidebar={sidebar}
        models={models}
        conversation={conversation}
        messages={thread}
        companionPetKey="yori-cat"
        companionPersonalityKey={personality}
      />,
    );
  });
}

function type(text: string) {
  const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
  if (!textarea) throw new Error("no composer");
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  act(() => {
    setValue?.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Submits the composer and lets the stored-message round trip settle. */
async function send(text = "Hello there") {
  type(text);
  await act(async () => {
    container.querySelector<HTMLButtonElement>(".send-button")?.click();
  });
}

/** Hands the shell a delta, exactly as the stream reader would. */
async function delta(text: string) {
  await act(async () => {
    streamHandlers?.onDelta(text);
  });
}

/** Ends the stream the way `requestAssistantReplyStream` would. */
async function end(result: unknown) {
  await act(async () => {
    finishStream?.(result);
  });
}

const storedReply = message({
  id: "cmreply0000000000000000000",
  role: "ASSISTANT",
  content: "Hello world",
  position: 1,
});

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

  streamHandlers = null;
  finishStream = null;
  network.userMessage.mockResolvedValue({ ok: true, value: message() });
  // Holds the stream open so each phase can be observed on its own terms.
  network.replyStream.mockImplementation(
    (_conversationId: string, handlers: { onDelta: (text: string) => void }) => {
      streamHandlers = handlers;
      return new Promise((resolve) => {
        finishStream = resolve;
      });
    },
  );

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("the chat companion reacting to a real conversation", () => {
  it("shows the companion while a conversation is open, and not beside the welcome mark", () => {
    mount();
    expect(companionState()).toBe("idle");

    act(() => {
      root.render(
        <ChatShell account={account} sidebar={sidebar} models={models} companionPetKey="yori-cat" />,
      );
    });
    // The empty state keeps its own static figure; the page never carries two pets.
    expect(container.querySelector(".chat-companion")).toBeNull();
    expect(container.querySelector(".welcome-pet")).not.toBeNull();
  });

  it("thinks once the reply request is really issued", async () => {
    mount();
    await send();

    expect(network.replyStream).toHaveBeenCalledTimes(1);
    expect(companionState()).toBe("thinking");
  });

  it("moves to the first content phase when the first delta arrives, and only then", async () => {
    mount();
    await send();
    expect(companionState()).toBe("thinking");

    await delta("Hello ");
    // A sleepy companion keeps dozing through `response-started`; a calm one would
    // stay on `thinking`. Either way the phase reached the renderer.
    expect(companionState()).toBe("sleeping");

    await delta("world");
    await delta("!");
    expect(companionState()).toBe("sleeping");
  });

  it("celebrates a completed stream and then settles back to idle", async () => {
    mount();
    await send();
    await delta("Hello world");
    await end({ ok: true, value: storedReply });

    expect(companionState()).toBe("happy");

    await act(async () => {
      vi.advanceTimersByTime(1_600);
    });
    expect(companionState()).toBe("idle");
  });

  it("shows a failure when generation ends in an error, and then settles", async () => {
    mount();
    await send();
    await delta("Hel");
    await end({ ok: false, status: 500, message: "The assistant reply failed." });

    expect(companionState()).toBe("sad");

    await act(async () => {
      vi.advanceTimersByTime(2_400);
    });
    expect(companionState()).toBe("idle");
  });

  it("settles rather than sulking when the generation is cancelled", async () => {
    mount("calm");
    await send();
    await delta("Hel");
    // A calm companion is paying attention, so a cancellation is a visible change.
    expect(companionState()).toBe("thinking");

    await end({ ok: false, status: 0, message: "You are offline.", aborted: true });
    expect(companionState()).toBe("idle");
  });

  it("leaves a dozing companion asleep through a cancellation", async () => {
    // The engine's documented rule, reached from the real lifecycle: a cancelled
    // request does not wake a pet that was already resting.
    mount();
    await send();
    await delta("Hel");
    expect(companionState()).toBe("sleeping");

    await end({ ok: false, status: 0, message: "You are offline.", aborted: true });
    expect(companionState()).toBe("sleeping");
  });

  it("reacts to nothing at all when the message was never stored", async () => {
    network.userMessage.mockResolvedValue({
      ok: false,
      status: 500,
      message: "The message could not be saved.",
    });
    mount();
    await send();

    // No stored message means no turn began, so no reply was requested either.
    expect(network.replyStream).not.toHaveBeenCalled();
    expect(companionState()).toBe("idle");
  });

  it("does not carry a reaction across a personality change mid-generation", async () => {
    mount();
    await send();
    await delta("Hello ");
    expect(companionState()).toBe("sleeping");

    rerender("calm");
    expect(companionState()).toBe("idle");

    // The stream finishing afterwards belongs to the previous companion's
    // configuration, so it must not paint the new one.
    await end({ ok: true, value: storedReply });
    expect(companionState()).toBe("idle");
  });

  it("keeps the composer's own error behavior untouched", async () => {
    network.userMessage.mockResolvedValue({
      ok: false,
      status: 500,
      message: "The message could not be saved.",
    });
    mount();
    await send();

    expect(container.querySelector(".composer-error")?.textContent).toContain(
      "The message could not be saved.",
    );
  });
});
