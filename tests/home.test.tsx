import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChatShell } from "../src/components/layout/chat-shell";
import { MessageComposer } from "../src/components/chat/message-composer";
import { MessageList } from "../src/components/chat/messages";
import { ConversationView } from "../src/components/chat/conversation-view";
import { sampleConversation } from "../src/features/chat/presentation";
import type { ModelSelection } from "../src/features/models/types";
import type {
  ConversationList,
  ConversationSummary,
  MessageList as MessageThread,
  MessageSummary,
} from "../src/features/conversations/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const account = { name: "Ada Lovelace", email: "ada@example.com" };
const conversation: ConversationSummary = {
  id: "cm1a2b3c4d5e6f7g8h9i0jkl",
  title: "New chat",
  createdAt: "2026-09-23T10:00:00.000Z",
  updatedAt: "2026-09-23T10:00:00.000Z",
};

function list(overrides: Partial<ConversationList> = {}): ConversationList {
  return { status: "anonymous", conversations: [], truncated: false, ...overrides };
}

/** The server-rendered model selection the shell displays. */
const catalog = {
  models: [
    { key: "gpt-4o-mini", name: "GPT-4o mini", description: "Fast and inexpensive." },
    { key: "gpt-4o", name: "GPT-4o", description: "Most capable." },
  ],
  selectedKey: "gpt-4o-mini",
};

function selection(overrides: Partial<ModelSelection> = {}): ModelSelection {
  return { status: "ready", ...catalog, ...overrides };
}

function thread(overrides: Partial<MessageThread> = {}): MessageThread {
  return { status: "ready", messages: [], truncated: false, ...overrides };
}

function storedMessage(overrides: Partial<MessageSummary> = {}): MessageSummary {
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

describe("chat presentation", () => {
  it("renders the application shell and accessible controls", () => {
    const html = renderToStaticMarkup(<ChatShell account={null} sidebar={list()} models={selection({ status: "anonymous" })} />);
    for (const text of [
      'id="main-content"',
      'aria-label="Chat sidebar"',
      'aria-label="Conversations"',
      'aria-label="Message composer"',
      'aria-label="Reply model"',
      "Message YoriGPT",
      'aria-label="Open sidebar"',
      'aria-label="Collapse sidebar"',
      "New chat",
      "curiosity take you?",
      "Messages aren’t sent or saved.",
      "Sign in",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain('aria-label="Assistant message"');
  });

  it("shows the real model catalog, with the saved model selected", () => {
    const html = renderToStaticMarkup(
      <ChatShell
        account={account}
        sidebar={list({ status: "ready" })}
        models={selection({ selectedKey: "gpt-4o" })}
      />,
    );

    expect(html).toContain('aria-label="Reply model"');
    expect(html).toContain("GPT-4o mini");
    expect(html).toContain("GPT-4o");
    expect(html).toMatch(/<option[^>]*value="gpt-4o"[^>]*selected/);
    expect(html).toContain("Used for new replies");
    // The retired placeholder models are gone for good.
    expect(html).not.toContain('value="preview-');
    expect(html).not.toContain("Yori Balanced");
    expect(html).not.toContain("Yori Creative");
  });

  it("offers the catalog but no choice to a signed-out visitor", () => {
    const html = renderToStaticMarkup(
      <ChatShell account={null} sidebar={list()} models={selection({ status: "anonymous" })} />,
    );

    expect(html).toContain("GPT-4o mini");
    expect(html).toContain("Sign in to choose a model");
    expect(html).toContain("disabled");
  });

  it("says so when the saved model could not be read, and still offers the catalog", () => {
    const html = renderToStaticMarkup(
      <ChatShell
        account={account}
        sidebar={list({ status: "ready" })}
        models={selection({ status: "error" })}
      />,
    );

    expect(html).toContain("Couldn’t load your model; using the default");
    expect(html).toContain("GPT-4o mini");
    expect(html).toContain("is-error");
  });

  it("shows the signed-out example instead of conversations", () => {
    const html = renderToStaticMarkup(<ChatShell account={null} sidebar={list()} models={selection({ status: "anonymous" })} />);
    expect(html).toContain("UI examples");
    expect(html).toContain("Static conversation preview");
    expect(html).toContain("Sign in to keep your conversations.");
    expect(html).not.toContain("Your conversations");
  });

  it("lists the signed-in user's own conversations and account", () => {
    const html = renderToStaticMarkup(
      <ChatShell
        account={account}
        sidebar={list({ status: "ready", conversations: [conversation] })}
        models={selection()}
      />,
    );
    expect(html).toContain("Your conversations");
    expect(html).toContain("New chat");
    expect(html).toContain(`href="/chat/${conversation.id}"`);
    expect(html).toContain("ada@example.com");
    expect(html).toContain('aria-label="Delete New chat"');
    // No static example data once real conversations are available.
    expect(html).not.toContain("Static conversation preview");
    expect(html).not.toContain("UI examples");
  });

  it("has explicit empty, error, and loading states", () => {
    const empty = renderToStaticMarkup(
      <ChatShell account={account} sidebar={list({ status: "ready" })} models={selection()} />,
    );
    expect(empty).toContain("No conversations yet");

    const failed = renderToStaticMarkup(
      <ChatShell account={account} sidebar={list({ status: "error" })} models={selection()} />,
    );
    expect(failed).toContain("We couldn’t load your conversations.");
    expect(failed).toContain("Try again");
  });

  it("shows the selected conversation without inventing messages", () => {
    const html = renderToStaticMarkup(
      <ChatShell
        account={account}
        sidebar={list({ status: "ready", conversations: [conversation] })}
        models={selection()}
        conversation={conversation}
      />,
    );
    expect(html).toContain('id="conversation-title"');
    expect(html).toContain("No messages yet.");
    expect(html).toContain('aria-current="page"');
    expect(html).not.toContain('aria-label="Assistant message"');
    expect(html).not.toContain('aria-label="User message"');
    expect(html).not.toContain("curiosity take you?");
  });

  it("renders the stored messages of the selected conversation", () => {
    const html = renderToStaticMarkup(
      <ChatShell
        account={account}
        sidebar={list({ status: "ready", conversations: [conversation] })}
        conversation={conversation}
        models={selection()}
        messages={thread({
          messages: [
            storedMessage({ content: "First stored thought." }),
            storedMessage({ id: "cm-second", content: "Second stored thought.", position: 1 }),
          ],
        })}
      />,
    );

    expect(html).toContain("First stored thought.");
    expect(html).toContain("Second stored thought.");
    expect(html).toContain('aria-label="Messages"');
    expect(html).toContain('aria-label="User message"');
    // Stored messages are not labelled as examples and never fabricate a reply.
    expect(html).not.toContain("Example<");
    expect(html).not.toContain("Copy example message");
    expect(html).not.toContain('aria-label="Assistant message"');
    expect(html).not.toContain("No messages yet.");
  });

  it("says so honestly when messages could not be loaded", () => {
    const html = renderToStaticMarkup(
      <ChatShell
        account={account}
        sidebar={list({ status: "ready", conversations: [conversation] })}
        conversation={conversation}
        models={selection()}
        messages={thread({ status: "error" })}
      />,
    );
    expect(html).toContain("We couldn’t load this conversation’s messages.");
    expect(html).not.toContain("No messages yet.");
  });

  it("offers a stored conversation's composer while the empty state has no handler", () => {
    const withConversation = renderToStaticMarkup(
      <ChatShell
        account={account}
        sidebar={list({ status: "ready", conversations: [conversation] })}
        conversation={conversation}
        models={selection()}
        messages={thread()}
      />,
    );
    expect(withConversation).toContain('aria-label="Send message"');
    expect(withConversation).toContain(
      "Your message is stored and the reply is generated by the configured model.",
    );
    expect(withConversation).not.toContain("Messages aren’t sent or saved.");

    // Without a selected conversation nothing can be submitted.
    const withoutConversation = renderToStaticMarkup(
      <ChatShell account={account} sidebar={list({ status: "ready" })} models={selection()} />,
    );
    expect(withoutConversation).toContain("Messages aren’t sent or saved.");
    expect(withoutConversation).not.toContain('aria-label="Send message"');
  });

  it("reports reply progress and a failed reply truthfully, with a retry", () => {
    const generating = renderToStaticMarkup(
      <ConversationView
        conversation={conversation}
                messages={thread({ messages: [storedMessage()] })}
        reply={{ generating: true, streamingText: null, streamingChunks: 0, error: null, onRetry: () => {} }}
      />,
    );
    expect(generating).toContain("Generating a reply…");
    expect(generating).not.toContain("Try again");
    // Progress is a status line, not an invented assistant message.
    expect(generating).not.toContain('aria-label="Assistant message"');

    const failed = renderToStaticMarkup(
      <ConversationView
        conversation={conversation}
                messages={thread({ messages: [storedMessage()] })}
        reply={{
          generating: false,
          streamingText: null,
          streamingChunks: 0,
          error: "The assistant reply could not be generated. Try again.",
          onRetry: () => {},
        }}
      />,
    );
    expect(failed).toContain("The assistant reply could not be generated. Try again.");
    expect(failed).toContain("Try again");
    expect(failed).not.toContain('aria-label="Assistant message"');
    // The stored user message stays visible after a failure.
    expect(failed).toContain("A stored thought.");
  });

  it("renders a stored assistant reply with the assistant presentation", () => {
    const html = renderToStaticMarkup(
      <ConversationView
        conversation={conversation}
                messages={thread({
          messages: [
            storedMessage({ content: "A question" }),
            storedMessage({
              id: "cmreply000000000000001",
              role: "ASSISTANT",
              content: "A stored answer",
              position: 1,
            }),
          ],
        })}
        reply={{ generating: false, streamingText: null, streamingChunks: 0, error: null, onRetry: () => {} }}
      />,
    );
    expect(html).toContain('aria-label="Assistant message"');
    expect(html).toContain("A stored answer");
    expect(html).toContain("YoriGPT");
    // A stored reply is not labelled as an example and has no streaming marker.
    expect(html).not.toContain("Example<");
    expect(html).not.toContain("Streaming<");
  });

  it("shows partial provider text while a reply is streaming, without treating it as stored", () => {
    const html = renderToStaticMarkup(
      <ConversationView
        conversation={conversation}
                messages={thread({ messages: [storedMessage({ content: "A question" })] })}
        reply={{
          generating: true,
          streamingText: "An answer so far",
          streamingChunks: 3,
          error: null,
          onRetry: () => {},
        }}
      />,
    );

    // The provisional text is rendered as an assistant message and marked as
    // still arriving; it is never labelled as a stored example.
    expect(html).toContain('aria-label="Assistant message"');
    expect(html).toContain("An answer so far");
    expect(html).toContain('data-stream-state="streaming"');
    expect(html).toContain('data-chunks="3"');
    expect(html).toContain("Streaming<");
    expect(html).toContain("Generating a reply…");
    expect(html).not.toContain("Example<");
    // Assistive technology hears the status line once, not one announcement per
    // delta: the growing text is a busy region, never its own live region.
    expect(html).toContain('aria-busy="true"');
    expect(html.match(/aria-live/g) ?? []).toHaveLength(1);
    // The stored user message is still there, with no stored-reply attributes.
    expect(html).toContain("A question");
  });

  it("renders no assistant bubble before the first delta arrives", () => {
    const html = renderToStaticMarkup(
      <ConversationView
        conversation={conversation}
                messages={thread({ messages: [storedMessage({ content: "A question" })] })}
        reply={{
          generating: true,
          streamingText: "",
          streamingChunks: 0,
          error: null,
          onRetry: () => {},
        }}
      />,
    );

    // An empty answer is not invented: only the status line is shown.
    expect(html).toContain("Generating a reply…");
    expect(html).not.toContain('aria-label="Assistant message"');
  });

  it("keeps sending and attachments disabled without connected handlers", () => {
    const html = renderToStaticMarkup(
      <MessageComposer value="A draft" onValueChange={() => {}} />,
    );
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*aria-label="Sending unavailable in this preview"/,
    );
    expect(html).toMatch(
      /<button[^>]*aria-label="Attachments unavailable in this preview"[^>]*disabled=""/,
    );
    expect(html).toContain("A draft</textarea>");
  });

  it("supports an explicit busy state for future use without simulating sending", () => {
    const html = renderToStaticMarkup(
      <MessageComposer value="A draft" onValueChange={() => {}} busy />,
    );
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
    expect(html).toContain('aria-label="Sending message"');
  });

  it("distinguishes static message roles with labels and actions", () => {
    const html = renderToStaticMarkup(<MessageList messages={sampleConversation.messages} />);
    expect(html).toContain('aria-label="User message"');
    expect(html).toContain('aria-label="Assistant message"');
    expect(html).toContain('aria-label="Copy example message"');
    expect(html).toContain("No AI model generated this response.");
  });
});
