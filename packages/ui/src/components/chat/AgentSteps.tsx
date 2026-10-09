import { useChatDraft } from "#ui/components/ChatSession.tsx";
import { useT } from "#ui/i18n/index.tsx";
import { stepCount } from "#ui/lib/chat.ts";

export function AgentSteps({ replyId, steps }: { replyId: number; steps: string }) {
  const t = useT();
  const [open, setOpen] = useChatDraft(`steps:${replyId}`, false);
  if (!steps) return null;
  return (
    <details data-chat-steps open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="text-xs">
      <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-muted-foreground select-none md:min-h-0">{t("chat.steps", { count: stepCount(steps) })} · {t("chat.agentLog")}</summary>
      <div className="chat-steps mt-2 max-h-64 overflow-auto">
        {steps.split("\n").filter(Boolean).map((line, i) => {
          const mark = /^[✓✕▶]/.exec(line)?.[0];
          return <span key={i} className="chat-step wrap-anywhere"><span data-mark={mark}>{mark ?? "·"}</span>{mark ? line.slice(1).trim() : line}</span>;
        })}
      </div>
    </details>
  );
}
