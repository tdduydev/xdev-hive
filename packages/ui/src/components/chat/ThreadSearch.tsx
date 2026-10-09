import { useEffect, useId, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Search, X } from "lucide-react";
import type { ChatMessage } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { useChatDraft } from "#ui/components/ChatSession.tsx";
import { useT } from "#ui/i18n/index.tsx";
import { loadedMatches, matchExcerpt } from "#ui/lib/chat-presentation.ts";

/** The header's door to the search below it; both read the same open flag. */
export function ThreadSearchButton({ threadId }: { threadId: number }) {
  const t = useT();
  const [open, setOpen] = useChatDraft(`searchOpen:${threadId}`, false);
  return <Button variant="ghost" size="icon-sm" data-chat-search-trigger aria-expanded={open} aria-label={t("chat.findLoaded")} title={t("chat.findLoaded")} onClick={() => setOpen(!open)}><Search aria-hidden /></Button>;
}

export function ThreadSearch({ threadId, messages, onMatch }: { threadId: number; messages: ChatMessage[]; onMatch: (id: number) => void }) {
  const t = useT();
  const [open, setOpen] = useChatDraft(`searchOpen:${threadId}`, false);
  const [query, setQuery] = useChatDraft(`search:${threadId}`, "");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const matches = loadedMatches(messages, query);
  const selected = matches.length ? index % matches.length : 0;
  const message = messages.find((m) => m.id === matches[selected]);
  const excerpt = message ? matchExcerpt(message.text, query) : null;
  const match = matches[selected];
  const callback = useRef(onMatch);
  callback.current = onMatch;
  useEffect(() => { if (open && match !== undefined) callback.current(match); }, [open, match, query]);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  const focusTrigger = () => document.querySelector<HTMLElement>("[data-chat-search-trigger]")?.focus();
  if (!open) return null;
  return (
    <div data-chat-search className="flex flex-col gap-2 px-5 py-2" style={{ boxShadow: "inset 0 -1px 0 var(--chat-divider)" }}>
      {open ? <div id={id} className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Input ref={input} type="search" value={query} aria-label={t("chat.findLoaded")} className="min-w-0 flex-1" onChange={(e) => { setQuery(e.target.value); setIndex(0); }} onKeyDown={(e) => {
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); focusTrigger(); }
            if (e.key === "Enter") { e.preventDefault(); setIndex((i) => matches.length ? (i + (e.shiftKey ? matches.length - 1 : 1)) % matches.length : 0); }
          }} />
          <Button size="icon-sm" variant="ghost" disabled={!matches.length} aria-label={t("chat.previousMatch")} onClick={() => setIndex((i) => (i + matches.length - 1) % matches.length)}><ArrowUp /></Button>
          <Button size="icon-sm" variant="ghost" disabled={!matches.length} aria-label={t("chat.nextMatch")} onClick={() => setIndex((i) => (i + 1) % matches.length)}><ArrowDown /></Button>
          <Button size="icon-sm" variant="ghost" aria-label={t("common.close")} onClick={() => { setOpen(false); focusTrigger(); }}><X /></Button>
        </div>
        <p role="status" className="text-xs text-muted-foreground">{t("chat.loadedResults", { current: matches.length ? selected + 1 : 0, count: matches.length })}</p>
        {excerpt ? <p className="text-xs wrap-anywhere" data-chat-search-excerpt>{excerpt.before}<mark>{excerpt.match}</mark>{excerpt.after}</p> : null}
      </div> : null}
    </div>
  );
}
