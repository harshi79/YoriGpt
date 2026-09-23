import { ChatShell } from "@/components/layout/chat-shell";
import { loadModelSelection } from "@/server/ai/models/view";
import { getCurrentUser } from "@/server/auth/session";
import { loadSidebarConversations } from "@/server/conversations/sidebar";
import { loadCompanion } from "@/server/pets/service";

/**
 * New chat. Anonymous visitors get the presentation-only shell; signed-in users
 * additionally get their own conversation list in the sidebar, and the empty-state
 * companion is their stored pet and appearance.
 */
export default async function Home() {
  const user = await getCurrentUser();
  const [sidebar, models, companion] = await Promise.all([
    loadSidebarConversations(user),
    // The catalog is server-owned; a failed preference read is reported, not hidden.
    loadModelSelection(user),
    loadCompanion(user),
  ]);

  return (
    <ChatShell
      account={user ? { name: user.name, email: user.email } : null}
      sidebar={sidebar}
      models={models}
      companionPetKey={companion.pet}
      companionAppearanceKey={companion.appearance}
    />
  );
}
