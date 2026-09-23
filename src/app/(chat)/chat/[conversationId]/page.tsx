import { notFound } from "next/navigation";
import { ChatShell } from "@/components/layout/chat-shell";
import { loadModelSelection } from "@/server/ai/models/view";
import { requireUser } from "@/server/auth/session";
import { isValidConversationId } from "@/server/conversations/request";
import { getConversation } from "@/server/conversations/service";
import { loadSidebarConversations } from "@/server/conversations/sidebar";
import { loadConversationMessages } from "@/server/messages/view";

/**
 * Selecting a conversation and loading the messages its owner wrote. Ownership is
 * checked in the query, and an id the user does not own resolves to the same 404
 * as an id that never existed, so nothing is revealed about other accounts.
 */
export default async function ConversationPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;
  // Anonymous visitors are sent to sign in; their request never reaches a query.
  const user = await requireUser();

  if (!isValidConversationId(conversationId)) notFound();

  const conversation = await getConversation(user.id, conversationId);
  if (!conversation) notFound();

  const [sidebar, messages, models] = await Promise.all([
    loadSidebarConversations(user),
    loadConversationMessages(user.id, conversation.id),
    loadModelSelection(user),
  ]);

  return (
    <ChatShell
      account={{ name: user.name, email: user.email }}
      sidebar={sidebar}
      conversation={conversation}
      messages={messages}
      models={models}
    />
  );
}
