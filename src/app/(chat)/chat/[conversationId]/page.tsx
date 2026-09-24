import { notFound } from "next/navigation";
import { ChatShell } from "@/components/layout/chat-shell";
import { loadModelSelection } from "@/server/ai/models/view";
import { requireUser } from "@/server/auth/session";
import { isValidConversationId } from "@/server/conversations/request";
import { getConversation } from "@/server/conversations/service";
import { loadSidebarConversations } from "@/server/conversations/sidebar";
import { loadConversationMessages } from "@/server/messages/view";
import { loadCompanion } from "@/server/pets/service";

/**
 * Selecting a conversation and loading the messages its owner wrote. Ownership is
 * checked in the query, and an id the user does not own resolves to the same 404
 * as an id that never existed, so nothing is revealed about other accounts. The
 * user's stored companion is loaded beside them, so the header pet of an open
 * conversation is the same one the empty state shows.
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

  const [sidebar, messages, models, companion] = await Promise.all([
    loadSidebarConversations(user),
    loadConversationMessages(user.id, conversation.id),
    loadModelSelection(user),
    // The header companion is the same stored pet, appearance, and personality the
    // empty state shows. Loading it here is what keeps the two in sync: without it the
    // shell would fall back to the catalog default the moment a conversation opens.
    loadCompanion(user),
  ]);

  return (
    <ChatShell
      account={{ name: user.name, email: user.email }}
      sidebar={sidebar}
      conversation={conversation}
      messages={messages}
      models={models}
      companionPetKey={companion.pet}
      companionAppearanceKey={companion.appearance}
      companionPersonalityKey={companion.personality}
    />
  );
}
