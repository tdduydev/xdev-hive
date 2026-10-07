import type { ChatMessage, ChatThread, Machine } from "@xdev-hive/core";
import { formatTime, formatUsd } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { chatUsage } from "#ui/lib/chat-presentation.ts";
import { useChatDraft } from "#ui/components/ChatSession.tsx";

export function ChatSessionBar({ thread, messages, machine }: { thread: ChatThread; messages: ChatMessage[]; machine?: Machine }) {
  const t = useT();
  const [open, setOpen] = useChatDraft(`sessionBar:${thread.id}`, false);
  const reply = messages.findLast((m) => m.role === "assistant");
  const actualProfileId = reply?.author.split("@")[0] ?? thread.profileId;
  const profile = machine?.profiles.find((p) => p.id === actualProfileId);
  const usage = chatUsage(messages);
  const tokens = reply?.tokens;
  return (
    <details data-chat-session open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="max-h-48 shrink-0 overflow-y-auto border-t px-4 py-2 text-xs text-muted-foreground">
      <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 md:min-h-0">
        <span className="font-mono wrap-anywhere">{thread.machine} · {profile?.kind ?? t("chat.modelDefault")} · {actualProfileId ?? t("chat.anyPlan")}</span>
        <span className="font-mono wrap-anywhere">{thread.model ?? t("chat.modelDefault")}{thread.effort ? ` · ${t(`effort.${thread.effort}`)}` : ""}</span>
        <span>{t("chat.turnTokens")}: {tokens ? tokens.inputTokens + tokens.cacheReadTokens + tokens.outputTokens : t("chat.usageUnknown")}</span>
        <span>{t("chat.sessionQuota")}: {profile?.overLimit ? t("board.profileOverLimit") : profile?.sessionPercent != null ? `${profile.sessionPercent}%` : t("chat.usageUnknown")}</span>
      </summary>
      <div className="flex flex-col gap-2 pt-2 wrap-anywhere">
        <p>{t("chat.configuredSession", { machine: thread.machine, plan: thread.profileId ?? t("chat.anyPlan"), model: thread.model ?? t("chat.modelDefault") })}{thread.effort ? ` · ${t(`effort.${thread.effort}`)}` : ""}</p>
        {tokens ? <p>{t("chat.tokens", { input: tokens.inputTokens, cached: tokens.cacheReadTokens, output: tokens.outputTokens })}</p> : <p>{t("chat.usageUnknown")}</p>}
        <p>{t("chat.threadTokens", { count: usage.measured ? usage.tokens : t("chat.usageUnknown"), missing: usage.missing })}</p>
        <p>{t("chat.threadCost", { cost: usage.missingCost < messages.filter((m) => m.role === "assistant").length ? formatUsd(usage.cost) : t("chat.usageUnknown"), missing: usage.missingCost })}</p>
        <p>{t("chat.quotaMeasured", { time: profile?.usageCheckedAt ? formatTime(profile.usageCheckedAt) : t("chat.usageUnknown") })}</p>
        {profile?.sessionResets ? <p>{profile.sessionResets}</p> : null}
        <a href="#/quota" className="inline-flex min-h-11 items-center self-start text-primary underline md:min-h-0">{t("quota.title")}</a>
      </div>
    </details>
  );
}
