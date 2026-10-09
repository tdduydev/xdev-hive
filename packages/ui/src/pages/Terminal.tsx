import { useRef, useState } from "react";
import { isTerminalFinal, type TerminalSession } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { ErrorNote } from "#ui/components/common.tsx";
import { TerminalForm } from "#ui/components/RemoteTerminal.tsx";
import TerminalScreen, { TerminalHintBar } from "#ui/components/TerminalScreen.tsx";
import { useHive, usePoll, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { scopeProject } from "#ui/lib/scope.ts";
import type { TerminalAttachment } from "#ui/lib/terminal-client.ts";

type Form = { session?: TerminalSession } | null;

/** The terminal as a page: sessions on the left, the live screen on the right. Attaching and creating keep the step-up flow of the dialog. */
export function TerminalPage() {
  const { client, projects, scope } = useHive();
  const t = useT();
  const api = client.terminal;
  const project = scopeProject(scope) ?? projects[0] ?? "";
  const [form, setForm] = useState<Form>(null);
  const [attachment, setAttachment] = useState<TerminalAttachment | null>(null);
  const busy = useRef(false);
  const tick = usePoll(5000);
  const sessions = useQuery(() => api && project ? api.list(project) : Promise.resolve([]), [api, project, tick]);
  if (!api) return <p role="status" className="p-6">{t("errors.terminal.notHuman")}</p>;
  if (!project) return <p role="status" className="p-6">{t("terminal.noProject")}</p>;
  const dot = (s: TerminalSession) => s.state === "active" ? "var(--accent-green)" : isTerminalFinal(s.state) ? "var(--text-muted)" : "var(--accent-blue)";
  const pick = (s: TerminalSession) => {
    // A finished session has no ticket: it opens read-only for the audit, never a new attach.
    if (isTerminalFinal(s.state)) { setForm(null); setAttachment({ session: s, ticket: null }); } else { setAttachment(null); setForm({ session: s }); }
  };
  const current = attachment?.session.id;
  return <div data-terminal-page className="flex flex-wrap items-start gap-4 p-6 max-md:p-4">
    <div className="flex max-w-full flex-[1_1_250px] flex-col gap-[10px]">
      <div className="flex flex-col gap-1 rounded-[24px] bg-[var(--surface-1)] px-2 py-3 shadow-[var(--ring-glass)]">
        <div className="flex items-center py-0.5 pr-1.5 pb-2 pl-2.5">
          <span className="flex-1 text-[11px]/4 font-semibold tracking-[.5px] uppercase text-[var(--text-muted)]">{t("terminal.sessions")}</span>
          <Button size="sm" variant="ghost" data-testid="terminal-page-new" onClick={() => { setAttachment(null); setForm({}); }}>{t("terminal.newOpen")}</Button>
        </div>
        {sessions.data?.length ? sessions.data.map((s) => <button key={s.id} type="button" data-testid="terminal-page-session" onClick={() => pick(s)} className={`flex cursor-pointer items-center gap-[10px] rounded-[14px] border-0 px-3 py-[10px] text-left text-[var(--text-strong)] hover:bg-[var(--glass-bg)] ${current === s.id || form?.session?.id === s.id ? "bg-[var(--glass-bg)] shadow-[var(--ring-glass)]" : "bg-transparent"}`}>
          <span className="flex size-[30px] shrink-0 items-center justify-center rounded-[9px] bg-[var(--code-bg)] font-mono text-[11px]/none font-bold shadow-[var(--ring-glass)]" style={{ color: dot(s) }}>sh</span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[13px]/[18px] font-semibold">{s.machineId}</span>
            <span className="truncate font-mono text-[11px]/[15px] font-medium text-[var(--text-muted)]">{s.checkoutRef} · {t(`terminal.states.${s.state}`)}</span>
          </span>
          <span aria-hidden="true" className="size-[7px] rounded-full" style={{ background: dot(s), boxShadow: `0 0 8px ${dot(s)}` }} />
        </button>) : <p className="px-3 py-2 text-[12px]/4 text-[var(--text-muted)]">{t("terminal.noSessions")}</p>}
        <ErrorNote error={sessions.error} />
      </div>
      {form ? <div className="flex flex-col gap-3 rounded-[24px] bg-[var(--surface-1)] p-4 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent-violet)_40%,transparent)]">
        <span className="text-[14px]/5 font-semibold">{t("terminal.newSession")}</span>
        <TerminalForm key={form.session?.id ?? "new"} api={api} target={{ project }} initial={form.session} hideSessions busyRef={busy} onCreated={(a) => { setForm(null); setAttachment(a); sessions.reload(); }} />
        <Button size="sm" variant="ghost" className="self-start" onClick={() => setForm(null)}>{t("common.cancel")}</Button>
      </div> : null}
    </div>
    <div className="flex h-[calc(100vh-210px)] min-h-[480px] min-w-0 flex-[999_1_560px] flex-col max-md:h-[calc(100dvh-160px)] max-md:min-h-[360px]">
      {attachment ? <TerminalScreen key={attachment.session.id} api={api} attachment={attachment} onDetach={() => { setAttachment(null); sessions.reload(); }} />
        : <div data-testid="terminal-idle" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[20px] bg-[var(--code-bg)] shadow-[var(--ring-glass-strong)]">
          <div className="flex shrink-0 flex-wrap items-center gap-[10px] bg-[var(--surface-1)] py-[10px] pr-3 pl-4 shadow-[inset_0_-1px_0_var(--border-subtle)]">
            <p className="inline-flex items-center gap-1.5 text-[12px]/none font-semibold text-[var(--text-muted)]"><span aria-hidden="true" className="size-[7px] rounded-full bg-[var(--text-muted)]" />{t("terminal.idle")}</p>
            <span className="min-w-40 flex-1 truncate font-mono text-[12px]/none font-medium text-[var(--text-secondary)]">{project}</span>
          </div>
          <div className="flex flex-1 items-center justify-center p-6 text-center text-[13px]/5 text-[var(--text-muted)]">{t("terminal.pick")}</div>
          <TerminalHintBar />
        </div>}
    </div>
  </div>;
}
