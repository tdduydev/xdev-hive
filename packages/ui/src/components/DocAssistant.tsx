// Trợ lý viết (docs/design/2026-09-redesign, xDev Hive Client: Tài liệu → Trợ lý; roadmap 22k): ask Claude, on a
// machine that has the project, to write or check the page from sources picked here (this page, related pages,
// memory, repo files). Its answer comes as a diff to apply to the draft, or drop; nothing is saved until the person
// saves the draft.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Brain, ChevronDown, ChevronRight, CircleAlert, Code, FileText, GitCommitHorizontal, List, Loader2, Pencil, Plus, Send, Sparkles } from "lucide-react";
import { cn } from "cn";
import { keyPrefix, type DocAssist, type DocAssistKind, type Memory } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Diff } from "./Diff.tsx";
import { errorMessage, formatTime, useHive, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { fold } from "#ui/lib/text.ts";
import { useToast } from "#ui/shell/toast.tsx";

interface Source {
  id: string;
  label: string;
  hint: string;
  icon: typeof FileText;
  mono?: boolean;
}

/** Lines added and removed from `a` to `b` (a plain LCS count, for the card's +/−). */
export function lineDelta(a: string, b: string): { add: number; del: number } {
  const x = a.split("\n");
  const y = b.split("\n");
  if (x.length * y.length > 400_000) return { add: y.length, del: x.length };
  const dp = Array.from({ length: x.length + 1 }, () => new Uint16Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const same = dp[0]![0]!;
  return { add: y.length - same, del: x.length - same };
}

export function DocAssistant({
  docKey,
  title,
  content,
  paths,
  related,
  onApply,
}: {
  docKey: string;
  title: string;
  /** The page as it is being edited now. */
  content: string;
  /** The page's globs (Áp dụng cho): offered as repo files. */
  paths: string[];
  /** Pages next to it (linked, above, below), key → title. */
  related: Array<{ key: string; title: string }>;
  /** Puts the proposed page in the draft; returns an undo. */
  onApply: (markdown: string) => () => void;
}) {
  const { client, me } = useHive();
  const t = useT();
  const toast = useToast();
  const project = /^project\/([^/]+)\//.exec(docKey)?.[1] ?? null;
  const [tick, setTick] = useState(0);
  const asks = useQuery(() => client.call("docs.assists", { key: docKey }).catch(() => [] as DocAssist[]), [client, docKey, tick]);
  const live = (asks.data ?? []).some((a) => a.status === "pending" || a.status === "running");
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setTick((n) => n + 1), 2000);
    return () => clearInterval(id);
  }, [live]);

  // Memory that names the page's words: offered, not all taken.
  const memory = useQuery(() => client.call("memory.list", { project, limit: 200 }).catch(() => [] as Memory[]), [client, project]);
  const words = useMemo(() => fold(title).split(/\s+/).filter((w) => w.length > 3), [title]);
  const memHits = useMemo(
    () =>
      (memory.data ?? [])
        .filter((m) => m.status === "approved" && !m.supersededBy)
        .map((m) => ({ m, score: words.filter((w) => fold(m.content).includes(w)).length + (m.content.includes(docKey) ? 3 : 0) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map((x) => x.m),
    [memory.data, words, docKey],
  );
  const [extraCode, setExtraCode] = useState<string[]>([]);
  const [codeInput, setCodeInput] = useState("");
  const sources: Source[] = useMemo(
    () => [
      ...related.slice(0, 5).map((r) => ({ id: `doc:${r.key}`, label: r.title, hint: r.key, icon: FileText })),
      ...memHits.map((m) => ({ id: `memory:${m.id}`, label: t("docs.assist.memory", { id: m.id }), hint: m.content, icon: Brain })),
      ...(project ? [...new Set([...paths, ...extraCode])].map((p) => ({ id: `code:${p}`, label: p.split("/").filter(Boolean).pop() || p, hint: p, icon: Code, mono: true })) : []),
    ],
    [related, memHits, project, paths, extraCode, t],
  );
  const [off, setOff] = useState<Record<string, boolean>>({});
  const on = sources.filter((s) => !off[s.id]);
  const [open, setOpen] = useState(false);
  const [draft, setDraftText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const ask = async (kind: DocAssistKind, prompt: string) => {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      await client.call("docs.assist", {
        key: docKey,
        kind,
        prompt,
        content,
        docs: on.filter((s) => s.id.startsWith("doc:")).map((s) => s.id.slice(4)),
        memory: on.filter((s) => s.id.startsWith("memory:")).map((s) => Number(s.id.slice(7))),
        code: on.filter((s) => s.id.startsWith("code:")).map((s) => s.id.slice(5)),
      });
      setDraftText("");
      setTick((n) => n + 1);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSending(false);
    }
  };
  const settle = async (a: DocAssist, apply: boolean) => {
    try {
      if (apply && a.markdown) {
        const undo = onApply(a.markdown);
        toast(t("docs.assist.applied"), {
          undo: () => {
            undo();
            void client.call("docs.assistSettle", { id: a.id, outcome: null }).then(() => setTick((n) => n + 1));
          },
        });
      }
      await client.call("docs.assistSettle", { id: a.id, outcome: apply ? "applied" : "dropped" });
      setTick((n) => n + 1);
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const cancel = async (a: DocAssist) => {
    try {
      await client.call("docs.assistCancel", { id: a.id });
      setTick((n) => n + 1);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const empty = content.split("\n").filter((l) => l.trim()).length <= 1;
  const quick: Array<{ kind: DocAssistKind; label: string; sub: string; icon: typeof Pencil }> = [
    { kind: "draft", label: empty ? t("docs.assist.draftAll") : t("docs.assist.draftMore"), sub: empty ? t("docs.assist.draftAllSub") : t("docs.assist.draftMoreSub"), icon: Pencil },
    ...(project ? [{ kind: "code" as const, label: t("docs.assist.code"), sub: t("docs.assist.codeSub"), icon: GitCommitHorizontal }] : []),
    { kind: "check", label: t("docs.assist.check"), sub: t("docs.assist.checkSub"), icon: CircleAlert },
    { kind: "summary", label: t("docs.assist.summary"), sub: t("docs.assist.summarySub"), icon: List },
  ];
  const label = (id: string): ReactNode => {
    if (id === "page") return t("docs.assist.thisPage");
    const s = sources.find((x) => x.id === id);
    if (s) return s.label;
    if (id.startsWith("memory:")) return t("docs.assist.memory", { id: id.slice(7) });
    return id.replace(/^(doc|code):/, "");
  };
  const list = asks.data ?? [];

  return (
    <section aria-label={t("docs.assist.title")} className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-b border-line-subtle px-3 pt-3 pb-2.5">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-fg-brand" />
          <span className="text-[13px] font-semibold text-fg-strong">{t("docs.assist.title")}</span>
        </div>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex cursor-pointer items-center gap-1.5 rounded-sm text-left text-xs text-fg-secondary outline-none hover:text-fg-strong focus-visible:focus-ring"
        >
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          <span className="font-semibold">{t("docs.assist.sources", { count: on.length + 1 })}</span>
          {!open ? <span className="min-w-0 flex-1 truncate text-fg-muted">{[t("docs.assist.thisPage"), ...on.map((s) => s.label)].join(", ")}</span> : null}
        </button>
        {open ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap gap-1">
              <span title={t("docs.assist.thisPageHint")} className="inline-flex h-[22px] items-center gap-1 rounded-xs border border-line-selected bg-surface px-[7px] text-[11px] font-medium text-fg-strong">
                <FileText className="size-3" />
                {t("docs.assist.thisPage")}
              </span>
              {sources.map((s) => {
                const Icon = s.icon;
                const isOff = !!off[s.id];
                return (
                  <button
                    key={s.id}
                    type="button"
                    aria-pressed={!isOff}
                    title={s.hint}
                    onClick={() => setOff((o) => ({ ...o, [s.id]: !o[s.id] }))}
                    className={cn(
                      "inline-flex h-[22px] max-w-full cursor-pointer items-center gap-1 rounded-xs border px-[7px] text-[11px] font-medium outline-none focus-visible:focus-ring",
                      isOff ? "border-line-default text-fg-muted line-through" : "border-line-selected bg-surface text-fg-strong",
                      s.mono && "font-mono",
                    )}
                  >
                    <Icon className="size-3 shrink-0" />
                    <span className="truncate">{s.label}</span>
                  </button>
                );
              })}
            </div>
            {project ? (
              <form
                className="flex gap-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  const v = codeInput.trim();
                  if (v && !v.startsWith("/") && !v.split("/").includes("..")) setExtraCode((c) => [...new Set([...c, v])].slice(0, 12));
                  setCodeInput("");
                }}
              >
                <Input className="h-7 font-mono text-[11px]" value={codeInput} onChange={(e) => setCodeInput(e.target.value)} placeholder={t("docs.assist.addFile")} aria-label={t("docs.assist.addFile")} />
                <Button type="submit" size="icon-sm" variant="outline" aria-label={t("docs.assist.addFile")} disabled={!codeInput.trim()}>
                  <Plus />
                </Button>
              </form>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
        {!list.length && !asks.loading ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-fg-muted">{t("docs.assist.intro")}</span>
            {quick.map((q) => {
              const Icon = q.icon;
              return (
                <button
                  key={q.kind}
                  type="button"
                  disabled={sending}
                  onClick={() => void ask(q.kind, q.label)}
                  className="flex cursor-pointer items-start gap-2.5 rounded-md border border-line-subtle bg-surface px-3 py-2.5 text-left outline-none hover:border-line-default hover:bg-hover focus-visible:focus-ring disabled:opacity-60"
                >
                  <Icon className="mt-0.5 size-3.5 shrink-0 text-fg-brand" />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-[13px] font-medium text-fg-strong">{q.label}</span>
                    <span className="text-[11px]/4 text-fg-muted">{q.sub}</span>
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}
        {list.map((a) => (
          <AskCard key={a.id} ask={a} current={content} label={label} onApply={() => void settle(a, true)} onDrop={() => void settle(a, false)} onCancel={() => void cancel(a)} onRetry={() => void ask(a.kind, a.prompt)} />
        ))}
        {error ? <span className="text-xs text-danger">{error}</span> : null}
      </div>
      <div className="flex shrink-0 flex-col gap-1.5 border-t border-line-subtle p-2.5">
        {list.length ? (
          <div className="flex flex-wrap gap-1">
            {quick.map((q) => (
              <button
                key={q.kind}
                type="button"
                disabled={sending}
                onClick={() => void ask(q.kind, q.label)}
                className="h-6 cursor-pointer rounded-full border border-line-default px-2.5 text-[11px] font-medium text-fg-secondary outline-none hover:text-fg-strong focus-visible:focus-ring disabled:opacity-60"
              >
                {q.label}
              </button>
            ))}
          </div>
        ) : null}
        <div className="flex items-end gap-1.5">
          <textarea
            value={draft}
            rows={2}
            onChange={(e) => setDraftText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && draft.trim()) {
                e.preventDefault();
                void ask("free", draft.trim());
              }
            }}
            placeholder={t("docs.assist.placeholder")}
            aria-label={t("docs.assist.placeholder")}
            className="min-h-[52px] w-full flex-1 resize-none rounded-md border border-line-control bg-surface px-2.5 py-2 text-[13px]/5 text-fg-strong outline-none placeholder:text-fg-muted focus-visible:focus-ring"
          />
          <Button size="icon-sm" aria-label={t("docs.assist.send")} title={t("docs.assist.sendHint")} disabled={!draft.trim() || sending} onClick={() => void ask("free", draft.trim())}>
            {sending ? <Loader2 className="animate-spin" /> : <Send />}
          </Button>
        </div>
        <span className="text-[11px]/4 text-fg-muted">{t("docs.assist.where", { where: me.mode === "local" ? t("docs.assist.whereLocal") : project ? t("docs.assist.whereProject", { project }) : t("docs.assist.whereTeam") })}</span>
      </div>
    </section>
  );
}

function AskCard({
  ask: a,
  current,
  label,
  onApply,
  onDrop,
  onCancel,
  onRetry,
}: {
  ask: DocAssist;
  current: string;
  label: (id: string) => ReactNode;
  onApply: () => void;
  onDrop: () => void;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const t = useT();
  const [showDiff, setShowDiff] = useState(true);
  const delta = useMemo(() => (a.markdown ? lineDelta(a.base, a.markdown) : null), [a.base, a.markdown]);
  const moved = a.markdown !== null && current !== a.base;
  const errorText = a.error ? (a.error.key ? t(a.error.key as never, a.error.vars as never) : a.error.message) : null;
  return (
    <div className="flex flex-col gap-2">
      <div className="self-end rounded-lg rounded-br-xs bg-selected px-3 py-2 text-[13px]/5 text-selected-fg">{a.prompt}</div>
      <div className="flex flex-col gap-2 rounded-lg border border-line-subtle bg-surface p-3">
        <div className="flex items-center gap-1.5 text-[11px] text-fg-muted">
          <Sparkles className="size-3 text-fg-brand" />
          <span className="font-mono">{[a.profile, a.machine].filter(Boolean).join(" · ") || t("docs.assist.assistant")}</span>
          <span className="ml-auto">{formatTime(a.updatedAt)}</span>
        </div>
        {a.status === "pending" || a.status === "running" ? (
          <div className="flex items-center gap-2 text-[13px] text-fg-secondary">
            <Loader2 className="size-3.5 animate-spin text-fg-muted" />
            <span className="flex-1">{a.status === "pending" ? t("docs.assist.waiting") : t("docs.assist.writing", { machine: a.machine ?? "" })}</span>
            <Button size="xs" variant="ghost" onClick={onCancel}>
              {t("docs.assist.cancel")}
            </Button>
          </div>
        ) : null}
        {a.status === "done" ? <p className="m-0 text-[13px]/5 whitespace-pre-wrap text-fg-primary">{a.reply || t("docs.assist.noReply")}</p> : null}
        {a.status === "failed" || a.status === "expired" ? (
          <div className="flex items-start gap-2 text-[13px]/5 text-danger">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span className="flex-1">{errorText ?? t("docs.assist.failed")}</span>
            <Button size="xs" variant="outline" onClick={onRetry}>
              {t("docs.assist.retry")}
            </Button>
          </div>
        ) : null}
        {a.status === "cancelled" ? <span className="text-xs text-fg-muted">{t("docs.assist.cancelled")}</span> : null}
        {a.sources.length ? (
          <div className="flex flex-wrap items-center gap-1 text-[11px] text-fg-muted">
            <span>{t("docs.assist.from")}</span>
            {a.sources.map((s) => (
              <span key={s} className={cn("rounded-xs bg-sunken px-1.5 py-px text-fg-secondary", s.startsWith("code:") && "font-mono")}>
                {label(s)}
              </span>
            ))}
          </div>
        ) : null}
        {a.status === "done" && a.markdown && delta ? (
          <>
            <button type="button" onClick={() => setShowDiff((v) => !v)} className="flex cursor-pointer items-center gap-1.5 text-left text-xs font-medium text-fg-secondary hover:text-fg-strong">
              {showDiff ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              {t("docs.assist.changes")}
              <span className="font-mono text-success">+{delta.add}</span>
              <span className="font-mono text-danger">−{delta.del}</span>
            </button>
            {showDiff ? (
              <div className="max-h-72 overflow-auto rounded-md border border-line-subtle text-[11px] [&_pre]:text-[11px]">
                <Diff before={a.base} after={a.markdown} />
              </div>
            ) : null}
            {a.outcome ? (
              <span className={cn("text-xs font-medium", a.outcome === "applied" ? "text-success" : "text-fg-muted")}>{a.outcome === "applied" ? t("docs.assist.wasApplied") : t("docs.assist.wasDropped")}</span>
            ) : (
              <div className="flex flex-wrap items-center gap-1.5">
                <Button size="sm" onClick={onApply} title={moved ? t("docs.assist.movedHint") : undefined}>
                  {t("docs.assist.apply")}
                </Button>
                <Button size="sm" variant="ghost" onClick={onDrop}>
                  {t("docs.assist.drop")}
                </Button>
                {moved ? <span className="text-[11px] text-warning">{t("docs.assist.moved")}</span> : null}
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
