import { ORPCError } from "@orpc/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type AssistAction,
  type DocDraft,
  type DocEditorState,
  type DocSuggestion,
  type DocThread,
  diffBlocks,
  initialsOf,
  lineDiff,
  mergeBlocks,
  TERMINAL_RUN_STATES,
  wordDiff,
} from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { Input } from "@xdev-hive/ui/input";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Textarea } from "@xdev-hive/ui/textarea";
import { cn } from "cn";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { quoteFor, suggestionsByBlock, suggestionsFromEdit } from "./blocks.ts";
import { setDocMarks } from "./editor-views.tsx";
import { useDocEditorEnv, useText } from "./env.tsx";
import { EditorSurface, EditorToolbar, Sep, Tb, useMarkdownEditor } from "./markdown-editor.tsx";
import { parseSdlcDocKey, SdlcPanel } from "./sdlc-panel.tsx";
import { sdlcPanelText } from "./text.ts";

/** Lưu sau khi ngừng gõ chừng này; đủ ngắn để người khác thấy bản mới, đủ dài để không lưu mỗi phím. */
const AUTOSAVE_MS = 1200;

const hubCode = (e: unknown) =>
  e instanceof ORPCError && typeof e.data === "object" && e.data && "code" in e.data ? String(e.data.code) : null;

/** Trình soạn tài liệu (DocEditor.dc.html, SRS DOC-01..05), dùng trong DocEditorProvider của app chủ. */
export function DocEditor({ docKey }: { docKey: string }) {
  const t = useText();
  const env = useDocEditorEnv();
  const { api } = env;
  const state = useQuery({ ...api.docEditor.state.queryOptions({ input: { key: docKey } }), refetchInterval: 10_000 });
  return (
    <main className="flex min-h-full min-w-0 flex-col">
      {!state.data && (
        <div className="p-6">
          <QueryState query={state} />
        </div>
      )}
      {state.data && <Editor docKey={docKey} initial={state.data} refetch={() => state.refetch()} />}
      <span className="sr-only">{t.docs}</span>
    </main>
  );
}

type SaveState = "saved" | "saving" | "unsaved";

function Editor({
  docKey,
  initial,
  refetch,
}: {
  docKey: string;
  initial: DocEditorState;
  refetch: () => Promise<{ data?: DocEditorState | undefined }>;
}) {
  const t = useText();
  const env = useDocEditorEnv();
  const { api } = env;
  const queryClient = useQueryClient();
  const live = useQuery({ ...api.docEditor.state.queryOptions({ input: { key: docKey } }), initialData: initial });
  const s = live.data ?? initial;
  const canEdit = s.draft.canEdit;

  // Bản nháp tại máy: `synced` là bản đã khớp với hub (để gộp ba phía khi người khác lưu chen vào).
  const [content, setContent] = useState(s.draft.content);
  const [title, setTitle] = useState(s.draft.title);
  const synced = useRef({ content: s.draft.content, title: s.draft.title, revision: s.draft.revision });
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [suggest, setSuggest] = useState(false);
  // Tài liệu của hạng mục AI SDLC mở ở khung "Hạng mục": người soạn cần giai đoạn, khuôn và câu đã trả lời trước tiên.
  const sdlcDoc = !!env.sdlc && parseSdlcDocKey(docKey) !== null;
  const [tab, setTab] = useState<"item" | "comments" | "ai" | "history">(sdlcDoc ? "item" : "comments");
  const [composer, setComposer] = useState<{ quote: string | null } | null>(null);
  const [submitOpen, setSubmitOpen] = useState(false);

  const dirty = content !== synced.current.content || title !== synced.current.title;

  // Người khác lưu khi mình không sửa gì: lấy bản mới về luôn.
  useEffect(() => {
    if (s.draft.revision !== synced.current.revision && !dirty) {
      synced.current = { content: s.draft.content, title: s.draft.title, revision: s.draft.revision };
      setContent(s.draft.content);
      setTitle(s.draft.title);
    }
  }, [s.draft.revision, s.draft.content, s.draft.title, dirty]);

  const setDraft = (draft: DocDraft) => {
    synced.current = { content: draft.content, title: draft.title, revision: draft.revision };
    queryClient.setQueryData(api.docEditor.state.queryKey({ input: { key: docKey } }), (old?: DocEditorState) =>
      old ? { ...old, draft } : old,
    );
  };

  const save = useMutation({
    mutationFn: (v: { content: string; title: string; revision: number }) =>
      api.docEditor.save.call({ key: docKey, content: v.content, title: v.title, revision: v.revision }),
    onMutate: () => setSaveState("saving"),
    onSuccess: (draft, v) => {
      setDraft(draft);
      setError(null);
      setSaveState(v.content === contentRef.current && v.title === titleRef.current ? "saved" : "unsaved");
    },
    onError: async (e) => {
      if (hubCode(e) !== "DRAFT_CHANGED") {
        setSaveState("unsaved");
        setError(env.errorMessage(e));
        return;
      }
      // Có người vừa lưu: gộp ba phía theo khối rồi lưu lại trên revision mới.
      const fresh = (await refetch()).data;
      if (!fresh) return;
      const merged = mergeBlocks(synced.current.content, contentRef.current, fresh.draft.content);
      synced.current = { content: fresh.draft.content, title: fresh.draft.title, revision: fresh.draft.revision };
      setContent(merged.content);
      setNotice(t.conflictMerged);
      save.mutate({ content: merged.content, title: titleRef.current, revision: fresh.draft.revision });
    },
  });
  const contentRef = useRef(content);
  const titleRef = useRef(title);
  contentRef.current = content;
  titleRef.current = title;

  useEffect(() => {
    if (!dirty || !canEdit || save.isPending) return;
    setSaveState("unsaved");
    const h = setTimeout(
      () => save.mutate({ content, title: title.trim() || s.draft.title, revision: synced.current.revision }),
      AUTOSAVE_MS,
    );
    return () => clearTimeout(h);
  }, [content, title, dirty, canEdit, save.isPending, save.mutate, s.draft.title]);

  const rebase = useMutation({
    mutationFn: () => api.docEditor.rebase.call({ key: docKey, revision: synced.current.revision }),
    onSuccess: ({ draft, conflicts }) => {
      setDraft(draft);
      setContent(draft.content);
      setNotice(t.rebased(conflicts));
      void queryClient.invalidateQueries({ queryKey: api.docEditor.key() });
    },
    onError: (e) => setError(env.errorMessage(e)),
  });

  const suggestions = useQuery(
    api.docEditor.suggestions.list.queryOptions({ input: { key: docKey, status: "pending" } }),
  );
  const threads = useQuery({
    ...api.docEditor.comments.list.queryOptions({ input: { key: docKey } }),
    refetchInterval: 15_000,
  });
  const refreshSide = () => queryClient.invalidateQueries({ queryKey: api.docEditor.key() });

  const decide = useMutation({
    mutationFn: (v: { id: string; accept: boolean }) => api.docEditor.suggestions.decide.call(v),
    onSuccess: ({ draft }) => {
      setDraft(draft);
      setContent(draft.content);
      void refreshSide();
    },
    onError: (e) => setError(env.errorMessage(e)),
  });

  // Chế độ đề xuất: chỗ sửa nằm ở `pending` (chưa lưu), bấm Gửi đề xuất thì thành đề xuất theo khối.
  const [pending, setPending] = useState<string | null>(null);
  const proposed = useMemo(() => (pending === null ? [] : suggestionsFromEdit(content, pending)), [content, pending]);
  const sendSuggestions = useMutation({
    mutationFn: async (list: { before: string; after: string }[]) => {
      for (const v of list) await api.docEditor.suggestions.create.call({ key: docKey, ...v });
    },
    onSuccess: () => {
      setPending(null);
      void refreshSide();
    },
    onError: (e) => setError(env.errorMessage(e)),
  });
  const [aiQuote, setAiQuote] = useState<string | undefined>(undefined);
  const h = useMarkdownEditor({
    value: pending ?? content,
    onChange: (md) => (suggest ? setPending(md === content ? null : md) : setContent(md)),
    editable: canEdit,
    lang: env.lang,
    label: t.editorLabel,
    onAi: () => openAi(),
    docKey,
  });
  const { editor } = h;

  // Thẻ đề xuất nằm ngay dưới khối chứa đoạn gốc (widget trong trình soạn, React vẽ vào qua portal).
  const hosts = useRef(new Map<string, HTMLElement>());
  const host = (id: string) => {
    let el = hosts.current.get(id);
    if (!el) {
      el = document.createElement("div");
      el.contentEditable = "false";
      hosts.current.set(id, el);
    }
    return el;
  };
  const [anchored, setAnchored] = useState<ReadonlySet<string>>(new Set());
  // biome-ignore lint/correctness/useExhaustiveDependencies: host chỉ đọc ref; đặt lại khi tài liệu, đề xuất hay bình luận đổi.
  useEffect(() => {
    if (!editor) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const place = () => {
      if (editor.isDestroyed) return;
      // Đổi decoration giữa lúc bộ gõ (Telex, VNI) đang ghép chữ làm trình duyệt chốt sai chỗ: đợi ghép xong.
      if (editor.view.composing) {
        timer = setTimeout(place, 150);
        return;
      }
      const byBlock = suggestionsByBlock(
        h.codec.blocks(editor.state.doc),
        (suggestions.data ?? []).filter((x) => x.before),
      );
      const anchors: { index: number; key: string; host: HTMLElement }[] = [];
      for (const [index, list] of byBlock)
        if (index >= 0) for (const x of list) anchors.push({ index, key: x.id, host: host(x.id) });
      const quotes = (threads.data ?? [])
        .filter((x) => !x.resolvedAt && x.anchored && x.quote)
        .map((x) => x.quote ?? "");
      setDocMarks(editor, { highlight: [...new Set(anchors.map((a) => a.index))], anchors, quotes });
      const ids = new Set(anchors.map((a) => a.key));
      setAnchored((prev) => (prev.size === ids.size && [...ids].every((id) => prev.has(id)) ? prev : ids));
    };
    place();
    // Đặt lại sau khi gõ; chạy ngoài lượt dispatch đang diễn ra của ProseMirror.
    const onTransaction = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (!transaction.docChanged) return;
      clearTimeout(timer);
      timer = setTimeout(place, 150);
    };
    editor.on("transaction", onTransaction);
    return () => {
      clearTimeout(timer);
      editor.off("transaction", onTransaction);
    };
  }, [editor, suggestions.data, threads.data, h.codec]);

  function openAi() {
    // Ngữ cảnh cho AI là khối đang chọn chữ hoặc đang đặt con trỏ, như khối đang sửa trước đây.
    setAiQuote(editor && (editor.isFocused || !editor.state.selection.empty) ? h.currentBlock() : undefined);
    setTab("ai");
  }
  function startComment() {
    const selected = h.selectedText() || window.getSelection()?.toString() || "";
    const block = editor && (editor.isFocused || selected) ? h.currentBlock() : "";
    setComposer({ quote: block ? quoteFor(block, selected) : selected.trim() || null });
    setTab("comments");
  }
  function addBlockAtEnd() {
    if (!editor) return;
    const last = editor.state.doc.lastChild;
    const c = editor.chain();
    if (!(last?.type.name === "paragraph" && !last.content.size))
      c.insertContentAt(editor.state.doc.content.size, { type: "paragraph" });
    c.focus("end").run();
  }

  const editingCount = s.presence.filter((p) => p.editing).length;
  const openThreads = (threads.data ?? []).filter((x) => !x.resolvedAt).length;
  const loose = (suggestions.data ?? []).filter((x) => !anchored.has(x.id));
  const card = (x: DocSuggestion) => (
    <SuggestionCard
      key={x.id}
      s={x}
      canDecide={canEdit}
      busy={decide.isPending || dirty || pending !== null}
      onDecide={(accept) => decide.mutate({ id: x.id, accept })}
    />
  );

  return (
    <>
      <header className="flex min-h-13 flex-wrap items-center gap-3 border-b border-border px-5 py-2">
        <nav className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground" aria-label="breadcrumb">
          {env.link({ to: { kind: "docs" }, className: "hover:underline", children: t.docs })}/{" "}
          <span className="truncate font-mono">{docKey}</span>
        </nav>
        <StageBadge stage={s.stage} draftNumber={s.draftNumber} />
        <span className="flex-1" />
        <Presence state={s} />
        <span className="text-sm text-muted-foreground" role="status">
          {!canEdit
            ? t.readOnly
            : saveState === "saving"
              ? t.saving
              : saveState === "unsaved" || dirty
                ? t.unsaved
                : `${t.saved}${editingCount ? ` · ${t.editingNow(editingCount)}` : ""}`}
        </span>
        {canEdit && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSuggest(!suggest)}
            aria-pressed={suggest}
            disabled={pending !== null}
          >
            {suggest ? t.modeSuggest : t.modeEdit}
          </Button>
        )}
        {canEdit && (
          <Button size="sm" onClick={() => setSubmitOpen(true)} disabled={dirty || s.stage === "in_review"}>
            {t.submit}
          </Button>
        )}
      </header>
      <WorkflowSteps state={s} />
      {s.draft.latestVersion > s.draft.baseVersion && canEdit && (
        <Alert className="m-3">
          {t.outdated(s.draft.latestVersion)}{" "}
          <Button size="sm" variant="outline" disabled={rebase.isPending || dirty} onClick={() => rebase.mutate()}>
            {t.rebase}
          </Button>
        </Alert>
      )}
      {s.review?.status === "changes_requested" && s.review.note && (
        <Alert className="m-3">{t.changesNote(s.review.note)}</Alert>
      )}
      {(notice || error) && (
        <Alert variant={error ? "destructive" : "default"} className="m-3">
          {error ?? notice}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setNotice(null);
              setError(null);
            }}
          >
            {t.close}
          </Button>
        </Alert>
      )}
      <div className="flex min-h-0 flex-1 flex-wrap">
        <section className="flex min-w-0 flex-[999_1_560px] flex-col">
          <EditorToolbar h={h}>
            <Sep />
            <Tb label={t.comment} onClick={startComment}>
              ❝
            </Tb>
            <span className="flex-1" />
            <Button
              variant="ghost"
              size="sm"
              className="text-primary"
              onMouseDown={(e) => e.preventDefault()}
              onClick={openAi}
            >
              ✦ {t.askAi}
            </Button>
          </EditorToolbar>
          {suggest && canEdit && (
            <div className="flex flex-wrap items-center gap-2 border-b border-border bg-warning-soft/40 px-5 py-1.5 text-sm">
              <span className="min-w-[200px] flex-1 text-muted-foreground">
                {pending !== null ? t.pendingEdits(proposed.length) : t.suggestHint}
              </span>
              {pending !== null && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={sendSuggestions.isPending}
                    onClick={() => setPending(null)}
                  >
                    {t.discardEdits}
                  </Button>
                  <Button
                    size="sm"
                    disabled={sendSuggestions.isPending || !proposed.length}
                    onClick={() => sendSuggestions.mutate(proposed)}
                  >
                    {t.sendSuggestions}
                  </Button>
                </>
              )}
            </div>
          )}
          <article className="relative mx-auto box-border w-full max-w-[780px] px-8 pt-9 pb-20">
            <p className="mb-1 text-sm text-muted-foreground">
              {s.draft.updatedBy?.name ?? ""} · {t.draftV(s.draftNumber)}
            </p>
            {canEdit && !suggest ? (
              <input
                aria-label={t.titleLabel}
                className="mb-4 w-full rounded-md bg-transparent text-3xl font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={title}
                onChange={(e) => setTitle(e.currentTarget.value)}
              />
            ) : (
              <h1 className="mb-4 text-3xl font-semibold tracking-tight">{title}</h1>
            )}
            <EditorSurface h={h} onComment={startComment} />
            {(suggestions.data ?? [])
              .filter((x) => anchored.has(x.id))
              .map((x) => createPortal(card(x), host(x.id), x.id))}
            {loose.map(card)}
            {canEdit && (
              <Button variant="ghost" size="sm" className="mt-2 text-muted-foreground" onClick={addBlockAtEnd}>
                + {t.newBlock}
              </Button>
            )}
          </article>
        </section>
        <aside className="flex min-w-[280px] max-w-[360px] flex-[1_1_320px] flex-col border-l border-border">
          <div role="tablist" className="flex gap-0.5 border-b border-border px-3">
            {(
              [
                ...(sdlcDoc ? ([["item", sdlcPanelText[env.lang].tab]] as const) : []),
                ["comments", t.tabComments(openThreads)],
                ["ai", t.tabAi],
                ["history", t.tabHistory],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={tab === k}
                onClick={() => setTab(k)}
                className={cn(
                  "-mb-px h-10 cursor-pointer border-0 border-b-2 bg-transparent px-2.5 text-sm",
                  tab === k
                    ? "border-foreground font-semibold text-foreground"
                    : "border-transparent text-muted-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === "item" && sdlcDoc && <SdlcPanel docKey={docKey} content={content} sdlc={env.sdlc} />}
          {tab === "comments" && (
            <CommentsPanel
              docKey={docKey}
              threads={threads.data ?? []}
              composer={composer}
              onComposer={setComposer}
              onChange={refreshSide}
            />
          )}
          {tab === "ai" && (
            <AiPanel
              docKey={docKey}
              canEdit={canEdit}
              quote={aiQuote}
              onDone={() => {
                void refreshSide();
                void refetch();
              }}
            />
          )}
          {tab === "history" && <HistoryPanel docKey={docKey} canEdit={canEdit} content={content} />}
        </aside>
      </div>
      {submitOpen && (
        <SubmitDialog
          docKey={docKey}
          state={s}
          revision={synced.current.revision}
          onClose={() => setSubmitOpen(false)}
          onDone={() => {
            setSubmitOpen(false);
            setNotice(t.sbDone);
            void refreshSide();
          }}
        />
      )}
    </>
  );
}

function StageBadge({ stage, draftNumber }: { stage: DocEditorState["stage"]; draftNumber: number }) {
  const t = useText();
  const tone =
    stage === "approved"
      ? "bg-success-soft text-success"
      : stage === "changes_requested"
        ? "bg-destructive-soft text-destructive"
        : stage === "in_review"
          ? "bg-accent text-accent-foreground"
          : "bg-warning-soft text-warning";
  return (
    <span className={cn("inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium", tone)}>
      <span className="size-1.5 rounded-full bg-current" />
      {t.stage[stage]} · v{draftNumber}
    </span>
  );
}

const AVATAR_TONES = [
  "bg-[#DBEAFE] text-[#1E3A8A]",
  "bg-[#DCFCE7] text-[#166534]",
  "bg-[#FEF3C7] text-[#92400E]",
  "bg-[#FCE7F3] text-[#9D174D]",
];

function Presence({ state }: { state: DocEditorState }) {
  const t = useText();
  const people = state.presence.slice(0, 5);
  return (
    <ul className="m-0 flex list-none items-center p-0" aria-label={t.presence}>
      {people.map((p, i) => (
        <li
          key={p.userId}
          title={`${p.name}${p.editing ? " ✎" : ""}`}
          className={cn(
            "inline-flex size-7 items-center justify-center rounded-full border-2 border-background text-xs font-semibold",
            i > 0 && "-ml-2",
            AVATAR_TONES[i % AVATAR_TONES.length],
          )}
        >
          <span aria-hidden="true">{initialsOf(p.name)}</span>
          <span className="sr-only">{p.name}</span>
        </li>
      ))}
    </ul>
  );
}

function WorkflowSteps({ state }: { state: DocEditorState }) {
  const t = useText();
  const wf = state.workflow;
  const tone = {
    done: "bg-success-soft text-success",
    current: "bg-warning-soft text-warning font-semibold",
    failed: "bg-destructive-soft text-destructive font-semibold",
    skipped: "bg-card text-muted-foreground border border-border line-through",
    todo: "bg-card text-muted-foreground border border-border",
  } as const;
  return (
    <nav
      aria-label={t.flow}
      className="flex flex-wrap items-center gap-1.5 border-b border-border bg-muted px-5 py-2.5 text-sm"
    >
      {!wf && <span className="text-muted-foreground">{t.noFlow}</span>}
      {wf && (
        <>
          <span className="mr-1.5 text-muted-foreground">{t.flowName(wf.name)}</span>
          {wf.steps.map((st, i) => (
            <span key={st.gateId} className="inline-flex items-center gap-1.5">
              <span
                className={cn("inline-flex h-6 items-center gap-1.5 rounded-full px-2.5", tone[st.state])}
                title={`${st.phase} · ${t.step[st.state]}`}
              >
                <span className="size-1.5 rounded-full bg-current" />
                {st.name}
                <span className="sr-only"> · {t.step[st.state]}</span>
              </span>
              {i < wf.steps.length - 1 && <span className="text-muted-foreground">→</span>}
            </span>
          ))}
        </>
      )}
    </nav>
  );
}

function SuggestionCard({
  s,
  canDecide,
  busy,
  onDecide,
}: {
  s: DocSuggestion;
  canDecide: boolean;
  busy: boolean;
  onDecide: (accept: boolean) => void;
}) {
  const t = useText();
  const parts = useMemo(() => wordDiff(s.before, s.after), [s.before, s.after]);
  return (
    <fieldset className="my-2 min-w-0 rounded-lg border border-border bg-card p-3 text-sm shadow-sm">
      <legend className="sr-only">{t.suggestedBy(s.author.name)}</legend>
      <p className="mb-2 text-sm leading-relaxed whitespace-pre-wrap">
        {parts.map((p, i) =>
          p.kind === "eq" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: các mảnh diff không có mã; vị trí là định danh.
            <span key={i}>{p.text}</span>
          ) : p.kind === "del" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: như trên.
            <del key={i} className="bg-destructive-soft text-destructive">
              {p.text}
            </del>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: như trên.
            <ins key={i} className="bg-success-soft text-success no-underline">
              {p.text}
            </ins>
          ),
        )}
      </p>
      <div className="flex flex-wrap items-center gap-2.5">
        <span
          className={cn(
            "inline-flex size-5.5 items-center justify-center rounded-full font-mono text-xs font-semibold",
            s.author.runId ? "bg-brand-navy text-[#B8F1FF]" : "bg-muted",
          )}
        >
          {s.author.runId ? "AI" : initialsOf(s.author.name)}
        </span>
        <span className="min-w-[200px] flex-1">
          <strong className="font-semibold">{t.suggestedBy(s.author.name)}</strong>
          {s.reason && <span className="text-muted-foreground"> — {s.reason}</span>}
          {s.stale && <span className="block text-destructive">{t.stale}</span>}
        </span>
        {canDecide && (
          <>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onDecide(false)}>
              {t.reject}
            </Button>
            <Button size="sm" disabled={busy || s.stale} onClick={() => onDecide(true)}>
              {t.accept}
            </Button>
          </>
        )}
      </div>
    </fieldset>
  );
}

function CommentsPanel({
  docKey,
  threads,
  composer,
  onComposer,
  onChange,
}: {
  docKey: string;
  threads: DocThread[];
  composer: { quote: string | null } | null;
  onComposer: (c: { quote: string | null } | null) => void;
  onChange: () => unknown;
}) {
  const t = useText();
  const env = useDocEditorEnv();
  const { api } = env;
  const [body, setBody] = useState("");
  const [showResolved, setShowResolved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: (v: { body: string; quote?: string; threadId?: string }) =>
      api.docEditor.comments.add.call({ key: docKey, ...v }),
    onSuccess: () => {
      setBody("");
      onComposer(null);
      setError(null);
      void onChange();
    },
    onError: (e) => setError(env.errorMessage(e)),
  });
  const open = threads.filter((x) => !x.resolvedAt);
  const resolved = threads.filter((x) => x.resolvedAt);
  return (
    <div className="flex flex-col gap-3 p-3.5">
      {error && <Alert variant="destructive">{error}</Alert>}
      {composer && (
        <form
          className="flex flex-col gap-2 rounded-lg border border-primary p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (body.trim()) add.mutate({ body: body.trim(), ...(composer.quote ? { quote: composer.quote } : {}) });
          }}
        >
          <p className="text-xs font-medium">{t.newComment}</p>
          <p className="border-l-2 border-warning pl-2 text-xs text-muted-foreground">
            {composer.quote ? `"${composer.quote}"` : t.general}
          </p>
          <Textarea
            aria-label={t.commentPh}
            placeholder={t.commentPh}
            value={body}
            onChange={(e) => setBody(e.currentTarget.value)}
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => onComposer(null)}>
              {t.cancel}
            </Button>
            <Button type="submit" size="sm" disabled={!body.trim() || add.isPending}>
              {t.send}
            </Button>
          </div>
        </form>
      )}
      {!composer && (
        <Button size="sm" variant="outline" onClick={() => onComposer({ quote: null })}>
          + {t.newComment}
        </Button>
      )}
      {!threads.length && !composer && <p className="text-sm text-muted-foreground">{t.noComments}</p>}
      {open.map((th) => (
        <ThreadCard key={th.id} thread={th} onChange={onChange} />
      ))}
      {resolved.length > 0 && (
        <p className="text-center text-sm text-muted-foreground">
          {t.resolvedCount(resolved.length)} ·{" "}
          <button type="button" className="cursor-pointer underline" onClick={() => setShowResolved(!showResolved)}>
            {showResolved ? t.hideResolved : t.showResolved}
          </button>
        </p>
      )}
      {showResolved && resolved.map((th) => <ThreadCard key={th.id} thread={th} onChange={onChange} />)}
    </div>
  );
}

function ThreadCard({ thread, onChange }: { thread: DocThread; onChange: () => unknown }) {
  const t = useText();
  const env = useDocEditorEnv();
  const { api } = env;
  const [reply, setReply] = useState("");
  const add = useMutation({
    mutationFn: () => api.docEditor.comments.add.call({ key: thread.key, threadId: thread.id, body: reply.trim() }),
    onSuccess: () => {
      setReply("");
      void onChange();
    },
  });
  const resolve = useMutation({
    mutationFn: (resolved: boolean) => api.docEditor.comments.resolve.call({ id: thread.id, resolved }),
    onSuccess: () => void onChange(),
  });
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg border p-3",
        thread.resolvedAt ? "border-border opacity-70" : "border-warning",
      )}
    >
      <p className="border-l-2 border-warning pl-2 text-xs text-muted-foreground">
        {thread.quote ? `"${thread.quote}"` : t.general}
        {thread.quote && !thread.anchored && <span className="block text-destructive">{t.detached}</span>}
      </p>
      {thread.comments.map((c) => (
        <div key={c.id} className="flex gap-2">
          <span
            className={cn(
              "inline-flex size-6 flex-none items-center justify-center rounded-full text-xs font-semibold",
              c.author.runId ? "bg-brand-navy font-mono text-[#B8F1FF]" : "bg-[#DCFCE7] text-[#166534]",
            )}
          >
            {c.author.runId ? "AI" : initialsOf(c.author.name)}
          </span>
          <div className="min-w-0 text-sm">
            <strong className="font-semibold">{c.author.name}</strong>{" "}
            <span className="text-xs text-muted-foreground">{new Date(c.createdAt).toLocaleString()}</span>
            <div className="break-words whitespace-pre-wrap">{c.body}</div>
          </div>
        </div>
      ))}
      <form
        className="flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (reply.trim()) add.mutate();
        }}
      >
        <Input
          aria-label={t.reply}
          placeholder={t.reply}
          className="h-7.5 text-sm"
          value={reply}
          onChange={(e) => setReply(e.currentTarget.value)}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={resolve.isPending}
          onClick={() => resolve.mutate(!thread.resolvedAt)}
        >
          {thread.resolvedAt ? t.reopen : t.resolve}
        </Button>
      </form>
    </div>
  );
}

function AiPanel({
  docKey,
  canEdit,
  quote,
  onDone,
}: {
  docKey: string;
  canEdit: boolean;
  quote: string | undefined;
  onDone: () => void;
}) {
  const t = useText();
  const env = useDocEditorEnv();
  const { api } = env;
  const queryClient = useQueryClient();
  const ids = useId();
  const targets = useQuery(api.docEditor.assist.targets.queryOptions({ input: undefined }));
  const runs = useQuery({
    ...api.docEditor.assist.list.queryOptions({ input: { key: docKey } }),
    refetchInterval: (q) => (q.state.data?.some((r) => !TERMINAL_RUN_STATES.includes(r.state as never)) ? 4000 : false),
  });
  const ready = (targets.data ?? []).filter((m) => m.online && m.ready);
  const [machineId, setMachineId] = useState<string>("");
  const machine = ready.find((m) => m.machineId === machineId) ?? ready[0];
  const clis = (machine?.clis ?? []).filter((c): c is "claude" | "codex" | "gemini" =>
    ["claude", "codex", "gemini"].includes(c),
  );
  const [cli, setCli] = useState<string>("");
  const pickedCli = clis.find((c) => c === cli) ?? clis[0];
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: (action: AssistAction) =>
      api.docEditor.assist.start.call({
        key: docKey,
        action,
        cli: pickedCli ?? "claude",
        ...(machine ? { machineId: machine.machineId } : {}),
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
        ...(quote?.trim() ? { quote } : {}),
      }),
    onSuccess: () => {
      setPrompt("");
      setError(null);
      void queryClient.invalidateQueries({ queryKey: api.docEditor.assist.list.key() });
    },
    onError: (e) => setError(env.errorMessage(e)),
  });
  // Lượt AI vừa xong: tải lại đề xuất và bình luận nó để lại.
  const finished = (runs.data ?? []).filter((r) => TERMINAL_RUN_STATES.includes(r.state as never)).length;
  const lastFinished = useRef(finished);
  useEffect(() => {
    if (finished > lastFinished.current) onDone();
    lastFinished.current = finished;
  }, [finished, onDone]);
  const disabled = !canEdit || !machine || !pickedCli || start.isPending;
  return (
    <div className="flex flex-col gap-3 p-3.5">
      {error && <Alert variant="destructive">{error}</Alert>}
      <QueryState query={targets} />
      {targets.data && !targets.data.length && <p className="text-sm text-muted-foreground">{t.aiNoMachine}</p>}
      {targets.data && targets.data.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm">
          <div className="flex items-center gap-2">
            <span className={cn("size-2 rounded-full", machine ? "bg-success" : "bg-muted-foreground")} />
            <label htmlFor={`${ids}-m`} className="flex-1 whitespace-nowrap">
              {t.aiMachine}
            </label>
            <NativeSelect
              id={`${ids}-m`}
              size="sm"
              className="w-44! text-sm"
              value={machine?.machineId ?? ""}
              onChange={(e) => setMachineId(e.currentTarget.value)}
            >
              {targets.data.map((m) => (
                <option key={m.machineId} value={m.machineId} disabled={!m.online || !m.ready}>
                  {m.name}
                  {!m.online ? ` · ${t.aiOffline}` : !m.ready ? ` · ${t.aiOld}` : ""}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor={`${ids}-c`} className="flex-1 whitespace-nowrap">
              {t.provider}
            </label>
            <NativeSelect
              id={`${ids}-c`}
              size="sm"
              className="w-44! text-sm"
              value={pickedCli ?? ""}
              onChange={(e) => setCli(e.currentTarget.value)}
            >
              {clis.map((c) => (
                <option key={c} value={c}>
                  {c === "claude" ? "Claude" : c === "codex" ? "Codex" : "Gemini"}
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>
      )}
      {(Object.keys(t.aiActions) as (keyof typeof t.aiActions)[]).map((k) => (
        <button
          key={k}
          type="button"
          disabled={disabled}
          onClick={() => start.mutate(k)}
          className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border bg-transparent px-3 py-2 text-left text-sm hover:bg-muted disabled:cursor-default disabled:opacity-50"
        >
          <span className="text-primary">✦</span>
          <span className="flex flex-col leading-snug">
            <span>{t.aiActions[k][0]}</span>
            <span className="text-xs text-muted-foreground">{t.aiActions[k][1]}</span>
          </span>
        </button>
      ))}
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (prompt.trim()) start.mutate("custom");
        }}
      >
        <Textarea
          aria-label={t.askAi}
          placeholder={t.aiPh}
          value={prompt}
          onChange={(e) => setPrompt(e.currentTarget.value)}
          className="h-18"
        />
        <Button type="submit" size="sm" disabled={disabled || !prompt.trim()}>
          ✦ {t.aiRun}
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">{t.aiNote}</p>
      {(runs.data?.length ?? 0) > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-muted-foreground">{t.aiHistory}</h3>
          {runs.data?.map((r) => (
            <div key={r.runId} className="rounded-lg border border-border p-2.5 text-sm">
              <div className="flex flex-wrap items-center gap-1.5">
                <strong className="font-semibold">
                  {r.action === "custom" ? (r.prompt ?? "") : t.aiActions[r.action][0]}
                </strong>
                <span className="text-muted-foreground">
                  · {r.cli ?? ""} · {r.machine ?? ""} ·{" "}
                  {env.link({ to: { kind: "run", id: r.runId }, className: "underline", children: r.state })}
                </span>
              </div>
              {r.summary && <p className="mt-1 whitespace-pre-wrap">{r.summary}</p>}
              <p className="mt-1 text-muted-foreground">{t.aiResult(r.suggestions, r.comments)}</p>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

function HistoryPanel({ docKey, canEdit, content }: { docKey: string; canEdit: boolean; content: string }) {
  const t = useText();
  const env = useDocEditorEnv();
  const { api } = env;
  const queryClient = useQueryClient();
  const nameId = useId();
  const list = useQuery(api.docEditor.snapshots.list.queryOptions({ input: { key: docKey } }));
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const detail = useQuery({
    ...api.docEditor.snapshots.get.queryOptions({ input: { id: picked ?? "" } }),
    enabled: !!picked,
  });
  const create = useMutation({
    mutationFn: () => api.docEditor.snapshots.create.call({ key: docKey, name: name.trim() }),
    onSuccess: () => {
      setName("");
      void queryClient.invalidateQueries({ queryKey: api.docEditor.snapshots.list.key() });
    },
  });
  const blocks = useMemo(
    () => (detail.data ? diffBlocks(lineDiff(detail.data.content, content), 2) : []),
    [detail.data, content],
  );
  return (
    <div className="flex flex-col gap-3 p-3.5">
      {canEdit && (
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <label htmlFor={nameId} className="text-xs font-medium">
            {t.snapshotName}
          </label>
          <div className="flex gap-1.5">
            <Input
              id={nameId}
              placeholder={t.snapshotPh}
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              className="h-8 text-sm"
            />
            <Button type="submit" size="sm" variant="outline" disabled={!name.trim() || create.isPending}>
              {t.snapshotCreate}
            </Button>
          </div>
          {create.isError && <Alert variant="destructive">{env.errorMessage(create.error)}</Alert>}
        </form>
      )}
      <QueryState query={list} />
      {list.data && !list.data.length && <p className="text-sm text-muted-foreground">{t.noSnapshots}</p>}
      <ol className="flex flex-col gap-3 text-sm">
        {list.data?.map((sn) => (
          <li key={sn.id}>
            <button
              type="button"
              aria-expanded={picked === sn.id}
              onClick={() => setPicked(picked === sn.id ? null : sn.id)}
              className="cursor-pointer border-0 bg-transparent p-0 text-left"
            >
              <strong className="font-semibold">
                #{sn.number} {sn.name}
              </strong>{" "}
              · {sn.author.name}{" "}
              <span className="text-muted-foreground">· {new Date(sn.createdAt).toLocaleString()}</span>
            </button>
            {sn.submission && (
              <div className="text-sm text-muted-foreground">
                {t.submission[sn.submission.status] ?? sn.submission.status}
                {sn.submission.note ? ` · ${sn.submission.note}` : ""}
              </div>
            )}
          </li>
        ))}
      </ol>
      {picked && (
        <section aria-label={t.diffAgainst} className="rounded-lg border border-border py-2 text-sm leading-[1.7]">
          <h3 className="px-3 pb-1 text-xs font-medium text-muted-foreground">{t.diffAgainst}</h3>
          <QueryState query={detail} />
          {blocks.map((b, bi) =>
            b.kind === "gap" ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: khối diff không có mã; vị trí là định danh.
              <div key={bi} className="bg-muted/60 px-3 font-mono text-xs text-muted-foreground">
                ⋯ {b.count}
              </div>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: như trên.
              <div key={bi}>
                {b.lines.map((l) => (
                  <div
                    key={`${l.oldNo ?? ""}:${l.newNo ?? ""}`}
                    data-diff={l.kind}
                    className={cn(
                      "border-l-3 px-3 break-words whitespace-pre-wrap",
                      l.kind === "added" && "border-success bg-success-soft text-success",
                      l.kind === "removed" && "border-destructive bg-destructive-soft text-destructive line-through",
                      l.kind === "same" && "border-transparent",
                    )}
                  >
                    {l.text || " "}
                  </div>
                ))}
              </div>
            ),
          )}
        </section>
      )}
    </div>
  );
}

function SubmitDialog({
  docKey,
  state,
  revision,
  onClose,
  onDone,
}: {
  docKey: string;
  state: DocEditorState;
  revision: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useText();
  const env = useDocEditorEnv();
  const { api } = env;
  const noteId = useId();
  const preview = useQuery(api.docEditor.submitPreview.queryOptions({ input: { key: docKey } }));
  const [note, setNote] = useState("");
  const submit = useMutation({
    mutationFn: () =>
      api.docEditor.submit.call({ key: docKey, revision, ...(note.trim() ? { note: note.trim() } : {}) }),
    onSuccess: onDone,
  });
  const kindTone = {
    ai: "bg-accent text-accent-foreground",
    human: "bg-warning-soft text-warning",
    rule: "bg-secondary text-secondary-foreground",
    ext: "bg-secondary text-secondary-foreground",
  } as const;
  return (
    <Dialog open onOpenChange={(o) => !o && !submit.isPending && onClose()}>
      <DialogContent>
        <DialogTitle>{t.sbTitle}</DialogTitle>
        <DialogDescription>{t.sbDesc(state.draftNumber)}</DialogDescription>
        <QueryState query={preview} />
        {preview.data && (
          <>
            <p className="text-xs text-muted-foreground">
              {t.sbDiff(preview.data.addedLines, preview.data.deletedLines)}
            </p>
            {!preview.data.workflow && <p className="text-sm">{t.sbNoFlow}</p>}
            <ol className="m-0 flex list-none flex-col gap-2 p-0">
              {preview.data.gates.map((g) => (
                <li
                  key={g.gateId}
                  className={cn(
                    "flex items-center gap-2.5 rounded-lg border border-border px-2.5 py-2",
                    !g.runs && "opacity-60",
                  )}
                  title={g.reason}
                >
                  <span className={cn("rounded-full px-2 py-0.5 text-xs", kindTone[g.kind])}>{t.kind[g.kind]}</span>
                  <span className="flex-1">
                    {g.name}
                    {!g.runs && <span className="text-xs text-muted-foreground"> · {t.sbSkip}</span>}
                  </span>
                  <span className="text-sm text-muted-foreground">{g.who}</span>
                </li>
              ))}
            </ol>
          </>
        )}
        <label htmlFor={noteId} className="flex flex-col gap-1.5 text-sm font-medium">
          {t.sbNote}
          <Textarea id={noteId} value={note} onChange={(e) => setNote(e.currentTarget.value)} className="h-16" />
        </label>
        {submit.isError && <Alert variant="destructive">{env.errorMessage(submit.error)}</Alert>}
        <DialogActions>
          <Button variant="outline" onClick={onClose} disabled={submit.isPending}>
            {t.cancel}
          </Button>
          <Button onClick={() => submit.mutate()} disabled={submit.isPending || !preview.data}>
            {t.sbGo}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}

function QueryState({ query }: { query: { isPending: boolean; error: unknown; refetch: () => unknown } }) {
  const t = useText();
  const env = useDocEditorEnv();
  if (query.isPending)
    return (
      <p role="status" aria-busy="true" className="text-muted-foreground">
        {t.loading}
      </p>
    );
  if (query.error)
    return (
      <Alert variant="destructive">
        {env.errorMessage(query.error)}
        <Button variant="outline" size="sm" onClick={() => query.refetch()}>
          {t.retry}
        </Button>
      </Alert>
    );
  return null;
}
