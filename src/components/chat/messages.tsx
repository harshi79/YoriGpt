import { useState } from "react";
import { Icon, YoriMark } from "../ui/icon";
import { IconButton } from "../ui/icon-button";

export type ChatMessageData = {
  id: string;
  role: "user" | "assistant";
  content: string;
  /**
   * `sample` is the static signed-out example (labelled as an example, with the
   * copy action). `stored` is a message loaded from the account's own
   * conversation, so it is shown plainly and never labelled as an example.
   * `streaming` is the provisional reply the browser is rendering from provider
   * deltas: it is not stored yet, and it is replaced by the stored row when the
   * server confirms completion.
   */
  variant?: "sample" | "stored" | "streaming";
  /** Applied deltas so far; only meaningful for the streaming variant. */
  chunks?: number;
};

export function MessageActions({ content }: { content: string }) {
  const [feedback, setFeedback] = useState("");
  return (
    <div className="message-actions" aria-label="Message actions">
      <IconButton
        icon={feedback === "Copied" ? "check" : "copy"}
        label="Copy example message"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(content);
            setFeedback("Copied");
          } catch {
            setFeedback("Copy unavailable in this browser");
          }
        }}
      />
      <span role="status">{feedback || "Static example"}</span>
    </div>
  );
}

export function ChatMessage({ message }: { message: ChatMessageData }) {
  const sample = (message.variant ?? "sample") === "sample";
  const streaming = message.variant === "streaming";
  return (
    <article
      className={`message message-${message.role}${streaming ? " message-streaming" : ""}`}
      aria-label={
        message.role === "user" ? "User message" : "Assistant message"
      }
      // The provisional reply is announced once through the composer's status
      // line, not once per delta, so it is only marked busy here.
      aria-busy={streaming || undefined}
      data-stream-state={streaming ? "streaming" : undefined}
      data-chunks={streaming ? message.chunks ?? 0 : undefined}
    >
      {message.role === "assistant" && (
        <span className="assistant-mark">
          <YoriMark />
        </span>
      )}
      <div className="message-body">
        <h2>
          {message.role === "user" ? "You" : "YoriGPT"}
          {sample && <span>Example</span>}
          {streaming && <span>Streaming</span>}
        </h2>
        <div className="message-content">
          {message.content.split("\n\n").map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
        </div>
        {message.role === "assistant" && sample && (
          <MessageActions content={message.content} />
        )}
      </div>
      {message.role === "user" && (
        <span className="message-avatar">
          <Icon name="user" />
        </span>
      )}
    </article>
  );
}

export function MessageList({
  messages,
  label = "Example messages",
}: {
  messages: readonly ChatMessageData[];
  label?: string;
}) {
  return (
    <div className="message-list" aria-label={label}>
      {messages.map((message) => (
        <ChatMessage key={message.id} message={message} />
      ))}
    </div>
  );
}
