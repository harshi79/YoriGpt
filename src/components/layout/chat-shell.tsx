"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "./sidebar";
import { ModelSelector } from "../chat/model-selector";
import { EmptyState } from "../chat/empty-state";
import { MessageComposer } from "../chat/message-composer";
import { MessageList } from "../chat/messages";
import { ConversationView } from "../chat/conversation-view";
import { Icon } from "../ui/icon";
import { IconButton } from "../ui/icon-button";
import { sampleConversation } from "../../features/chat/presentation";
import type { ModelSelection } from "../../features/models/types";
import { requestModelSelection } from "../../features/models/client";
import {
  requestAssistantReplyStream,
  requestDeleteConversation,
  requestNewConversation,
  requestUserMessage,
} from "../../features/conversations/client";
import {
  EMPTY_MESSAGE_LIST,
  type ConversationList,
  type ConversationSummary,
  type MessageSummary,
  // The wire type shares its name with the message list component below.
  type MessageList as MessageListState,
} from "../../features/conversations/types";

type Account = { name: string; email: string };

type Props = {
  account: Account | null;
  sidebar: ConversationList;
  /**
   * Server-loaded model catalog and this user's saved selection. The server is the
   * source of truth: the shell displays it, asks it to save a change, and never
   * invents a model or a provider identifier of its own.
   */
  models: ModelSelection;
  /** Server-verified conversation for /chat/[conversationId]. */
  conversation?: ConversationSummary | null;
  /** Server-loaded messages of that conversation, already owner-scoped. */
  messages?: MessageListState;
};

export function ChatShell({
  account,
  sidebar,
  models,
  conversation = null,
  messages = EMPTY_MESSAGE_LIST,
}: Props) {
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [sampleRequested, setSampleRequested] = useState(false);
  const [draft, setDraft] = useState("");
  // Optimistic only: a choice is shown immediately, confirmed by the server
  // response, and rolled back on failure so the control never claims a model that
  // is not the one replies will actually use. `from` records the server value the
  // choice was made against, so a fresh server render (reload, navigation, or
  // another tab) always wins over a stale local guess — no syncing effect needed.
  const [modelChoice, setModelChoice] = useState<{ key: string; from: string } | null>(null);
  const [savingModel, setSavingModel] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const model =
    modelChoice && modelChoice.from === models.selectedKey ? modelChoice.key : models.selectedKey;
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Messages stored during this visit, plus the last submission error. Both are
  // tagged with the conversation they belong to, so switching conversations never
  // shows another thread's data or error.
  const [sent, setSent] = useState<{ conversationId: string; messages: MessageSummary[] }>({
    conversationId: "",
    messages: [],
  });
  const [sending, setSending] = useState(false);
  const [replying, setReplying] = useState(false);
  // Text received so far for the reply being streamed. Temporary by construction:
  // it is only shown while the stream is open and is replaced by the stored row
  // the server sends in its final event.
  const [streaming, setStreaming] = useState<{
    conversationId: string;
    text: string;
    chunks: number;
  } | null>(null);
  const [messageError, setMessageError] = useState<{ conversationId: string; message: string } | null>(
    null,
  );
  // Reply generation failures are reported next to the conversation, together
  // with a retry, because the user's own message was already stored.
  const [replyError, setReplyError] = useState<{ conversationId: string; message: string } | null>(
    null,
  );
  const sendingRef = useRef(false);
  // One reply request at a time: the ref holds the stream the shell is reading so
  // an unmount, a conversation switch, or a retry can cancel it.
  const replyAbort = useRef<AbortController | null>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  const mobileDialog = useRef<HTMLDialogElement>(null);
  const mobileTrigger = useRef<HTMLButtonElement>(null);
  const main = useRef<HTMLElement>(null);
  const desktopSidebar = useRef<HTMLDivElement>(null);

  // The static example belongs to the signed-out shell only.
  const showSample = sampleRequested && !account;

  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");
    const closeAtDesktop = () => {
      if (media.matches) mobileDialog.current?.close();
    };
    media.addEventListener("change", closeAtDesktop);
    return () => media.removeEventListener("change", closeAtDesktop);
  }, []);

  // Leaving the page (or navigating between conversations) cancels the stream:
  // the reader stops, the server aborts the provider call, and nothing is stored
  // for it. No state is updated after that, so an unmounted shell stays quiet.
  useEffect(() => {
    return () => replyAbort.current?.abort();
  }, []);

  useEffect(() => {
    return () => {
      replyAbort.current?.abort();
      replyAbort.current = null;
      setStreaming(null);
      setReplying(false);
    };
  }, [conversation?.id]);

  const closeSidebar = () => mobileDialog.current?.close();

  // The server render is the source of truth; anything stored from this page is
  // merged in, and skipped once the server already reports the same id.
  const pending =
    sent.conversationId === conversation?.id
      ? sent.messages.filter(
          (message) => !messages.messages.some((stored) => stored.id === message.id),
        )
      : [];
  const thread: MessageListState = {
    status: messages.status,
    truncated: messages.truncated,
    messages: [...messages.messages, ...pending],
  };
  const activeMessageError =
    messageError && messageError.conversationId === conversation?.id ? messageError.message : null;
  const activeReplyError =
    replyError && replyError.conversationId === conversation?.id ? replyError.message : null;
  const activeStreaming =
    streaming && streaming.conversationId === conversation?.id ? streaming : null;

  const newChat = async () => {
    setActionError(null);
    setSampleRequested(false);
    setDraft("");
    closeSidebar();

    // Signed-out visitors are sent to the existing sign-in flow instead of a
    // conversation being created for an invented guest identity.
    if (!account) {
      router.push("/login");
      return;
    }

    setCreating(true);
    const result = await requestNewConversation();
    setCreating(false);
    if (result.ok) {
      router.push(`/chat/${result.value.id}`);
      return;
    }
    if (result.status === 401) {
      router.push("/login");
      return;
    }
    setActionError(result.message);
  };

  const deleteConversation = async (conversationId: string) => {
    setActionError(null);
    setDeletingId(conversationId);
    const result = await requestDeleteConversation(conversationId);
    setDeletingId(null);
    if (result.ok) {
      if (conversation?.id === conversationId) router.push("/");
      else router.refresh();
      return;
    }
    if (result.status === 401) {
      router.push("/login");
      return;
    }
    setActionError(result.message);
  };

  /**
   * Saves one model choice. Only the catalog key is sent; the server validates it
   * against the catalog and stores it for this account. Signed-out visitors can
   * look but not choose, and a failure leaves the previous model selected.
   */
  const changeModel = async (key: string) => {
    // Signed out there is nowhere to store a choice, so the control sends the
    // visitor to sign in — the same behavior as New chat.
    if (!account) {
      router.push("/login");
      return;
    }
    if (key === model) return;
    setModelChoice({ key, from: models.selectedKey });
    setModelError(null);
    setSavingModel(true);

    const result = await requestModelSelection(key);
    setSavingModel(false);

    if (result.ok) {
      // Keep the server's own answer on screen; a refresh then makes it the prop.
      setModelChoice({ key: result.selectedKey, from: models.selectedKey });
      router.refresh();
      return;
    }
    setModelChoice(null);
    if (result.status === 401) {
      router.push("/login");
      return;
    }
    setModelError(result.message);
  };

  /** Appends a message the server just stored to the visible thread. */
  const appendStored = (conversationId: string, message: MessageSummary) => {
    setSent((current) => ({
      conversationId,
      messages:
        current.conversationId === conversationId
          ? [...current.messages, message]
          : [message],
    }));
  };

  const scrollToLatest = () => {
    requestAnimationFrame(() => {
      const area = scrollArea.current;
      if (area) area.scrollTop = area.scrollHeight;
    });
  };

  /**
   * Streams one assistant reply. The text, role, and position are all decided
   * server-side: this shows the deltas as they arrive and keeps them only until
   * the server confirms the stored row. A failed or cancelled stream discards the
   * partial text and leaves the stored user message untouched.
   */
  const generateReply = async (conversationId: string) => {
    // A retry (or a second submit) replaces the previous stream instead of racing it.
    replyAbort.current?.abort();
    const controller = new AbortController();
    replyAbort.current = controller;

    setReplyError(null);
    setReplying(true);
    setStreaming({ conversationId, text: "", chunks: 0 });

    const result = await requestAssistantReplyStream(
      conversationId,
      {
        onDelta: (text) =>
          setStreaming((current) =>
            current?.conversationId === conversationId
              ? { ...current, text: current.text + text, chunks: current.chunks + 1 }
              : current,
          ),
      },
      { signal: controller.signal },
    );

    // A newer stream (or an unmount) already took over; leave its state alone.
    if (replyAbort.current !== controller) return;
    replyAbort.current = null;
    setReplying(false);
    setStreaming(null);

    if (result.ok) {
      appendStored(conversationId, result.value);
      scrollToLatest();
      // The reply changed the conversation's activity time.
      router.refresh();
      return;
    }
    // The reader was cancelled because the user left or switched conversation.
    if (result.aborted) return;
    if (result.status === 401) {
      router.push("/login");
      return;
    }
    // The stored user message stays visible; nothing pretends a reply arrived.
    setReplyError({ conversationId, message: result.message });
    // This turn may already be answered (a duplicate submit, or another writer won
    // the race): reload the stored truth so the provisional text cannot outlive it.
    if (result.status === 400) router.refresh();
  };

  const sendMessage = async (content: string) => {
    if (!conversation || sendingRef.current) return;
    const conversationId = conversation.id;
    // The ref guard stops a second submit before React re-renders the button.
    sendingRef.current = true;
    setMessageError(null);
    setReplyError(null);
    setSending(true);

    const result = await requestUserMessage(conversationId, content);

    if (!result.ok) {
      sendingRef.current = false;
      setSending(false);
      if (result.status === 401) {
        router.push("/login");
        return;
      }
      setMessageError({ conversationId, message: result.message });
      return;
    }

    appendStored(conversationId, result.value);
    setDraft("");
    scrollToLatest();

    // The message is stored; the reply is a separate, retryable step that also
    // keeps the composer locked so the same turn cannot be submitted twice.
    await generateReply(conversationId);
    sendingRef.current = false;
    setSending(false);
  };

  // One short line, in plain words: what just happened, or what this control affects.
  const modelHint = modelError
    ? modelError
    : savingModel
      ? "Saving…"
      : models.status === "error"
        ? "Couldn’t load your model; using the default"
        : account
          ? "Used for new replies"
          : "Sign in to choose a model";

  const sidebarProps = {
    account,
    conversations: sidebar,
    activeConversationId: conversation?.id ?? null,
    sampleSelected: showSample,
    creating,
    deletingId,
    actionError,
    onNewChat: newChat,
    onShowSample: () => {
      setSampleRequested(true);
      closeSidebar();
    },
    onDelete: deleteConversation,
    onRetry: () => router.refresh(),
  };

  return (
    <div className={`app-shell ${collapsed ? "sidebar-collapsed" : ""}`}>
      <a href="#main-content" className="skip-link">
        Skip to chat
      </a>
      <div className="desktop-sidebar" ref={desktopSidebar}>
        <Sidebar
          {...sidebarProps}
          onClose={() => {
            setCollapsed(true);
            requestAnimationFrame(() =>
              main.current?.querySelector<HTMLButtonElement>(".desktop-expand")?.focus(),
            );
          }}
        />
      </div>
      <dialog
        className="mobile-sidebar-dialog"
        ref={mobileDialog}
        id="mobile-navigation"
        aria-label="Chat navigation"
        onClose={() => {
          if (!window.matchMedia("(min-width: 768px)").matches) mobileTrigger.current?.focus();
          else main.current?.querySelector("select")?.focus();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const controls = event.currentTarget.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input, select, textarea, a[href]",
          );
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) closeSidebar();
        }}
      >
        <Sidebar {...sidebarProps} mobile onClose={closeSidebar} />
      </dialog>
      <main className="main-panel" id="main-content" tabIndex={-1} ref={main}>
        <header className="chat-header">
          <div className="header-left">
            <button
              ref={mobileTrigger}
              type="button"
              className="icon-button mobile-menu"
              aria-label="Open sidebar"
              aria-haspopup="dialog"
              aria-controls="mobile-navigation"
              onClick={() => mobileDialog.current?.showModal()}
            >
              <Icon name="menu" />
            </button>
            {collapsed && (
              <IconButton
                className="desktop-expand"
                icon="panel"
                label="Expand sidebar"
                onClick={() => {
                  setCollapsed(false);
                  requestAnimationFrame(() =>
                    desktopSidebar.current
                      ?.querySelector<HTMLButtonElement>("[aria-label='Collapse sidebar']")
                      ?.focus(),
                  );
                }}
              />
            )}
            <ModelSelector
              models={models.models}
              value={model}
              onChange={(key) => void changeModel(key)}
              disabled={savingModel}
              hint={modelHint}
              hintIsError={Boolean(modelError) || models.status === "error"}
            />
          </div>
          <span className="preview-badge">
            <span className="preview-dot" />
            UI preview
          </span>
        </header>
        <div
          className="chat-scroll-area"
          ref={scrollArea}
          key={conversation ? `conversation-${conversation.id}` : showSample ? "sample" : "empty"}
        >
          {conversation ? (
            <ConversationView
              conversation={conversation}
              messages={thread}
              reply={{
                generating: replying,
                streamingText: activeStreaming ? activeStreaming.text : null,
                streamingChunks: activeStreaming?.chunks ?? 0,
                error: activeReplyError,
                onRetry: () => void generateReply(conversation.id),
              }}
            />
          ) : showSample ? (
            <section className="sample-conversation" aria-labelledby="sample-title">
              <div className="sample-heading">
                <p className="eyebrow">Conversation preview</p>
                <h1 id="sample-title">{sampleConversation.title}</h1>
                <p>Static examples of message styling. Not a live conversation.</p>
              </div>
              <MessageList messages={sampleConversation.messages} />
            </section>
          ) : (
            <EmptyState
              onChoosePrompt={(value) => {
                setDraft(value);
                main.current?.querySelector("textarea")?.focus();
              }}
            />
          )}
        </div>
        <MessageComposer
          value={draft}
          onValueChange={setDraft}
          onSubmit={conversation ? sendMessage : undefined}
          busy={sending || replying}
          error={activeMessageError}
        />
      </main>
    </div>
  );
}
