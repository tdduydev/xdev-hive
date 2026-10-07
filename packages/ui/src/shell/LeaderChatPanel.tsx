import { useState } from "react";
import { ExternalLink, X } from "lucide-react";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@xdev-hive/ui/components/ui/sheet";
import { LeaderChat } from "#ui/components/LeaderChat.tsx";
import { useChatSession } from "#ui/components/ChatSession.tsx";
import { useHive } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { InShellContext } from "#ui/shell/frame.ts";
import { scopeId } from "#ui/lib/scope.ts";

export function LeaderChatPanel() {
  const { scope } = useHive();
  const session = useChatSession();
  const t = useT();
  const [removed, setRemoved] = useState<string | null>(null);
  const context = session.pageContext?.href === removed ? null : session.pageContext;
  const open = session.selections[scopeId(scope)];
  const href = open?.kind === "thread" ? `#/chat?thread=${open.id}` : open?.kind === "new" || open === undefined ? "#/chat?thread=new" : "#/chat";
  return (
    <Sheet open={session.panelOpen} onOpenChange={session.setPanelOpen}>
      <SheetContent data-leader-panel showCloseButton={false} className="gap-0 max-md:!w-full md:!w-[min(40rem,100vw)] md:!max-w-none h-dvh overflow-hidden pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] motion-reduce:animate-none motion-reduce:transition-none">
        <SheetHeader className="shrink-0">
          <div className="flex items-center gap-2">
            <SheetTitle className="min-w-0 flex-1">{t("chat.askLeader")}</SheetTitle>
            <Button size="icon-sm" variant="ghost" className="max-md:size-11" asChild>
              <a href={href} aria-label={t("chat.openPage")} title={t("chat.openPage")} onClick={() => session.setPanelOpen(false)} data-chat-open-page><ExternalLink /></a>
            </Button>
            <SheetClose asChild><Button size="icon-sm" variant="ghost" className="max-md:size-11" aria-label={t("common.close")} data-chat-panel-close><X /></Button></SheetClose>
          </div>
          <SheetDescription>{t("chat.panelHint")}</SheetDescription>
          {context ? (
            <div data-chat-context className="flex items-center gap-2 rounded-md border border-line-subtle bg-subtle p-2 text-xs">
              <span className="min-w-0 flex-1"><span className="text-fg-secondary">{t("chat.pageContext")}: </span><a href={context.href} className="inline-flex min-h-11 items-center font-mono underline wrap-anywhere md:min-h-0">{context.id}</a></span>
              <Button size="icon-sm" variant="ghost" className="max-md:size-11" aria-label={t("chat.removeContext")} onClick={() => setRemoved(context.href)}><X /></Button>
            </div>
          ) : null}
        </SheetHeader>
        {session.panelOpen ? <InShellContext.Provider value={true}><LeaderChat key={scopeId(scope)} panel context={context} /></InShellContext.Provider> : null}
      </SheetContent>
    </Sheet>
  );
}
