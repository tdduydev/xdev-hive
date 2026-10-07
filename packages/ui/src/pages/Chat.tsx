import { LeaderChat } from "#ui/components/LeaderChat.tsx";
import { useChatSession } from "#ui/components/ChatSession.tsx";

export function ChatPage() {
  const { panelOpen } = useChatSession();
  return panelOpen ? null : <LeaderChat />;
}
