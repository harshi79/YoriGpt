import { Icon } from "../ui/icon";
import { MessageList, type ChatMessageData } from "./messages";
import type { ConversationSummary, MessageList as MessageListState } from "../../features/conversations/types";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * Deterministic label derived from the stored timestamp only. It avoids
 * `Date`/`Intl` so the server and browser always render the same text.
 */
function shortDate(iso: string): string {
  const [date = ""] = iso.split("T");
  const [, month = "", day = ""] = date.split("-");
  const monthName = MONTHS[Number(month) - 1];
  return monthName && day ? `${Number(day)} ${monthName}` : date;
}

/**
 * Reply state for the newest user turn. `generating` is a plain status line (no
 * fake typing or token animation), and a failure offers the retry the server
 * supports because the user's own message is already stored.
 */
export type ReplyState = {
  generating: boolean;
  /**
   * Assistant text received so far for the reply in progress, or `null` while no
   * delta has arrived. This text is provisional: it is rendered so the user can
   * read the answer as it is produced, and it is thrown away unless the server
   * confirms the stored row — a failed or cancelled stream never leaves it behind.
   */
  streamingText: string | null;
  /** How many deltas produced `streamingText`; exposed as a data attribute. */
  streamingChunks: number;
  error: string | null;
  onRetry: () => void;
};

/**
 * The selected conversation: its stored title and the stored messages. Nothing is
 * invented — an empty conversation keeps its empty state, and a reply appears only
 * once the server has stored it.
 */
export function ConversationView({
  conversation,
  messages,
  reply,
}: {
  conversation: ConversationSummary;
  messages: MessageListState;
  reply: ReplyState;
}) {
  const stored: ChatMessageData[] = messages.messages.map((message) => ({
    id: message.id,
    role: message.role === "USER" ? "user" : "assistant",
    content: message.content,
    variant: "stored",
  }));
  // The in-progress answer is appended after the stored messages, so the user
  // reads it as it arrives. It has no id, position, or timestamps — the real row
  // arrives with the final event and replaces this presentation. Nothing is shown
  // until real provider text arrives: an empty bubble would pretend a reply exists
  // before one does.
  const visible =
    reply.streamingText === null || reply.streamingChunks === 0
      ? stored
      : [
          ...stored,
          {
            id: "streaming-reply",
            role: "assistant" as const,
            content: reply.streamingText,
            variant: "streaming" as const,
            chunks: reply.streamingChunks,
          },
        ];

  return (
    <section className="conversation-view" aria-labelledby="conversation-title">
      <div className="conversation-heading">
        <p className="eyebrow">Saved conversation</p>
        <h1 id="conversation-title">{conversation.title}</h1>
        <p>
          Started <time dateTime={conversation.createdAt}>{shortDate(conversation.createdAt)}</time>
        </p>
      </div>
      {messages.status === "error" ? (
        <div className="conversation-empty" role="alert" data-state="error">
          <span className="conversation-empty-icon">
            <Icon name="chat" />
          </span>
          <p>
            <strong>We couldn’t load this conversation’s messages.</strong> Your stored
            messages are safe; reload the page to try again.
          </p>
        </div>
      ) : stored.length === 0 ? (
        <div className="conversation-empty">
          <span className="conversation-empty-icon">
            <Icon name="chat" />
          </span>
          <p>
            <strong>No messages yet.</strong> Write the first message below. It is saved to
            your account.
          </p>
        </div>
      ) : (
        <div className="conversation-messages">
          <MessageList messages={visible} label="Messages" />
          {messages.truncated ? (
            <p className="conversation-note">
              Showing the most recent messages. Older messages in this conversation are
              hidden for now.
            </p>
          ) : null}
          {reply.generating ? (
            <p className="reply-notice" role="status" aria-live="polite">
              <span className="loading-spinner" aria-hidden="true" />
              Generating a reply…
            </p>
          ) : null}
          {reply.error ? (
            <div className="reply-notice is-error" role="alert">
              <p>{reply.error}</p>
              <button type="button" className="reply-retry" onClick={reply.onRetry}>
                Try again
              </button>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
