import Link from "next/link";
import { useId, useState } from "react";
import { Icon, YoriMark } from "../ui/icon";
import { IconButton } from "../ui/icon-button";
import { sampleConversation } from "../../features/chat/presentation";
import type { ConversationList } from "../../features/conversations/types";

type Account = { name: string; email: string };

type Props = {
  account: Account | null;
  conversations: ConversationList;
  activeConversationId: string | null;
  sampleSelected: boolean;
  creating: boolean;
  deletingId: string | null;
  actionError: string | null;
  onNewChat: () => void;
  onShowSample: () => void;
  onDelete: (conversationId: string) => void;
  onRetry: () => void;
  onClose: () => void;
  mobile?: boolean;
};

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

/** Deterministic day label from the stored timestamp; no locale or time zone. */
function shortDate(iso: string): string {
  const [date = ""] = iso.split("T");
  const [, month = "", day = ""] = date.split("-");
  const monthName = MONTHS[Number(month) - 1];
  return monthName && day ? `${Number(day)} ${monthName}` : date;
}

export function Sidebar({
  account,
  conversations,
  activeConversationId,
  sampleSelected,
  creating,
  deletingId,
  actionError,
  onNewChat,
  onShowSample,
  onDelete,
  onRetry,
  onClose,
  mobile = false,
}: Props) {
  const [query, setQuery] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const searchId = useId();

  const needle = query.toLowerCase().trim();
  const matchesSample = sampleConversation.title.toLowerCase().includes(needle);
  const matches = conversations.conversations.filter((conversation) =>
    conversation.title.toLowerCase().includes(needle),
  );

  return (
    <aside className="sidebar" aria-label="Chat sidebar">
      <div className="sidebar-brand">
        <span className="brand">
          <YoriMark />
          <span>
            Yori<span className="brand-light">GPT</span>
          </span>
        </span>
        <IconButton
          icon={mobile ? "close" : "panel"}
          label={mobile ? "Close sidebar" : "Collapse sidebar"}
          onClick={onClose}
        />
      </div>
      <button
        className="new-chat-button"
        type="button"
        onClick={() => {
          setQuery("");
          onNewChat();
        }}
        disabled={creating}
        aria-busy={creating}
      >
        <Icon name="plus" />
        <span>{creating ? "Starting…" : "New chat"}</span>
        <span className="new-chat-symbol" aria-hidden="true">
          ↗
        </span>
      </button>
      <div className="sidebar-search">
        <Icon name="search" />
        <label className="sr-only" htmlFor={searchId}>
          Search conversations
        </label>
        <input
          id={searchId}
          type="search"
          placeholder={account ? "Search conversations" : "Search examples"}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {actionError ? (
        <p className="sidebar-error" role="alert">
          {actionError}
        </p>
      ) : null}
      <nav className="conversation-nav" aria-label="Conversations">
        {account ? (
          <>
            <h2 className="section-label">
              Your conversations <span>{String(conversations.conversations.length).padStart(2, "0")}</span>
            </h2>
            {conversations.status === "error" ? (
              <div className="sidebar-panel" role="alert">
                <p>We couldn’t load your conversations.</p>
                <button className="sidebar-retry" type="button" onClick={onRetry}>
                  Try again
                </button>
              </div>
            ) : conversations.conversations.length === 0 ? (
              <p className="sidebar-panel" role="status">
                No conversations yet. Select New chat to start one.
              </p>
            ) : matches.length === 0 ? (
              <p className="search-empty" role="status">
                No conversations match your search.
              </p>
            ) : (
              <ul className="conversation-list">
                {matches.map((conversation) => {
                  const active = conversation.id === activeConversationId;
                  const confirming = confirmingId === conversation.id;
                  const deleting = deletingId === conversation.id;
                  return (
                    <li className="conversation-item" key={conversation.id}>
                      <Link
                        className={`conversation-row ${active ? "is-active" : ""}`}
                        href={`/chat/${conversation.id}`}
                        aria-current={active ? "page" : undefined}
                        onClick={onClose}
                      >
                        <Icon name="chat" />
                        <span className="conversation-text">
                          <strong>{conversation.title}</strong>
                          <small>
                            <time dateTime={conversation.updatedAt}>
                              {shortDate(conversation.updatedAt)}
                            </time>
                          </small>
                        </span>
                      </Link>
                      <button
                        type="button"
                        className={`conversation-delete ${confirming ? "is-confirming" : ""}`}
                        aria-label={
                          confirming
                            ? `Confirm delete ${conversation.title}`
                            : `Delete ${conversation.title}`
                        }
                        title={confirming ? "Select again to delete" : "Delete conversation"}
                        disabled={deleting}
                        onClick={() => {
                          if (!confirming) {
                            setConfirmingId(conversation.id);
                            return;
                          }
                          setConfirmingId(null);
                          onDelete(conversation.id);
                        }}
                        onBlur={() => setConfirmingId((current) => (current === conversation.id ? null : current))}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            event.stopPropagation();
                            setConfirmingId(null);
                          }
                        }}
                      >
                        <Icon name={confirming ? "check" : "trash"} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {conversations.truncated ? (
              <p className="sidebar-note">
                Showing your most recent conversations. Older ones are hidden for now.
              </p>
            ) : null}
          </>
        ) : (
          <>
            <h2 className="section-label">
              UI examples <span>01</span>
            </h2>
            {matchesSample ? (
              <button
                className={`conversation-row ${sampleSelected ? "is-active" : ""}`}
                aria-pressed={sampleSelected}
                onClick={onShowSample}
                type="button"
              >
                <Icon name="chat" />
                <span>
                  {sampleConversation.title}
                  <small>Static conversation preview</small>
                </span>
              </button>
            ) : (
              <p className="search-empty" role="status">
                No examples found.
              </p>
            )}
            <div className="history-note">
              <span className="history-line" />
              <p>Sign in to keep your conversations.</p>
              <span>Saved history appears here after you sign in.</span>
            </div>
          </>
        )}
      </nav>
      <div className="sidebar-bottom">
        <div className="workspace-note">
          <span className="preview-dot" />
          <span>A little space for big ideas.</span>
        </div>
        {account ? (
          <div className="account-control">
            <span className="avatar">
              <Icon name="user" />
            </span>
            <span className="account-text">
              <strong>{account.name}</strong>
              <small>{account.email}</small>
            </span>
            <Link
              className="account-settings"
              href="/settings"
              aria-label="Settings"
              title="Settings"
              onClick={onClose}
            >
              <Icon name="settings" />
            </Link>
          </div>
        ) : (
          <Link className="account-control account-signin" href="/login" onClick={onClose}>
            <span className="avatar">
              <Icon name="user" />
            </span>
            <span className="account-text">
              <strong>Sign in</strong>
              <small>Save conversations to your account</small>
            </span>
            <Icon name="arrowRight" />
          </Link>
        )}
      </div>
    </aside>
  );
}
