import { ChatShell } from "@/components/layout/chat-shell";
import { loadModelSelection } from "@/server/ai/models/view";
import { getCurrentUser } from "@/server/auth/session";
import { loadSidebarConversations } from "@/server/conversations/sidebar";

/**
 * New chat. Anonymous visitors get the presentation-only shell; signed-in users
 * additionally get their own conversation list in the sidebar.
 */
export default async function Home() {
  const user = await getCurrentUser();
  const [sidebar, models] = await Promise.all([
    loadSidebarConversations(user),
    // The catalog is server-owned; a failed preference read is reported, not hidden.
    loadModelSelection(user),
  ]);

  return (
    <ChatShell
      account={user ? { name: user.name, email: user.email } : null}
      sidebar={sidebar}
      models={models}
    />
  );
}
