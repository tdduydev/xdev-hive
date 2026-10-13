import { ORPCError } from "@orpc/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type AssistAction,
  blockKind,
  type DocDraft,
  type DocEditorState,
  type DocSuggestion,
  type DocThread,
  diffBlocks,
  initialsOf,
  lineDiff,
  mergeBlocks,
  splitBlocks,
  TERMINAL_RUN_STATES,
  wordDiff,
} from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { Input } from "@xdev-hive/ui/input";
import { Markdown } from "@xdev-hive/ui/markdown";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Textarea } from "@xdev-hive/ui/textarea";
import { cn } from "cn";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  type BlockTemplate,
  blockTemplate,
  embedKey,
  insertBlock,
  quoteFor,
  replaceBlock,
  setTextKind,
  suggestionsByBlock,
  textKindOf,
  toggleCheck,
  wrapSelection,
} from "./blocks.ts";
import { useDocEditorEnv, useText } from "./env.tsx";

/** Lưu sau khi ngừng gõ chừng này; đủ ngắn để người khác thấy bản mới, đủ dài để không lưu mỗi phím. */
const AUTOSAVE_MS = 1200;
const SLASH: BlockTemplate[] = ["h2", "checklist", "table", "requirement", "code", "mermaid", "embed", "callout"];

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
  const [tab, setTab] = useState<"comments" | "ai" | "history">("comments");
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

  const createSuggestion = useMutation({
    mutationFn: (v: { before: string; after: string }) => api.docEditor.suggestions.create.call({ key: docKey, ...v }),
    onSuccess: () => void refreshSide(),
    onError: (e) => setError(env.errorMessage(e)),
  });
  const decide = useMutation({
    mutationFn: (v: { id: string; accept: boolean }) => api.docEditor.suggestions.decide.call(v),
    onSuccess: ({ draft }) => {
      setDraft(draft);
      setContent(draft.content);
      void refreshSide();
    },
    onError: (e) => setError(env.errorMessage(e)),
  });

  const blocks = useMemo(() => splitBlocks(content), [content]);
  const byBlock = useMemo(() => suggestionsByBlock(blocks, suggestions.data ?? []), [blocks, suggestions.data]);
  const [active, setActive] = useState<number | null>(null);
  const [editing, setEditing] = useState("");
  const area = useRef<HTMLTextAreaElement | null>(null);

  function open(index: number) {
    if (!canEdit) return;
    commit();
    setActive(index);
    setEditing(blocks[index] ?? "");
  }
  /** Xong khối đang sửa: sửa thẳng thì đổi bản nháp, chế độ đề xuất thì gửi thành đề xuất sửa. */
  function commit(next = editing) {
    if (active === null) return;
    const before = blocks[active] ?? "";
    setActive(null);
    if (next.trim() === before.trim()) return;
    if (suggest) createSuggestion.mutate({ before, after: next.trim() });
    else setContent(replaceBlock(content, active, next));
  }
  function insert(kind: BlockTemplate) {
    const block = blockTemplate(kind, content);
    if (active !== null && editing.trim().startsWith("/")) {
      setEditing(block);
      return;
    }
    const after = active ?? blocks.length - 1;
    commit();
    if (suggest) {
      setActive(blocks.length);
      setEditing(block);
      return;
    }
    const out = insertBlock(content, after, block);
    setContent(out.content);
    setActive(out.index);
    setEditing(block);
  }
  function mark(m: "bold" | "italic" | "strike" | "code" | "link") {
    const el = area.current;
    if (!el || active === null) return;
    const out = wrapSelection(editing, el.selectionStart, el.selectionEnd, m);
    setEditing(out.text);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(out.start, out.end);
    });
  }
  function startComment(index: number | null) {
    const block = index === null ? "" : (blocks[index] ?? "");
    const selected = window.getSelection()?.toString() ?? "";
    setComposer({ quote: block ? quoteFor(block, selected) : selected.trim() || null });
    setTab("comments");
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") commit();
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit();
  };

  const slashQuery = active !== null && /^\/\S*$/.test(editing.trim()) ? editing.trim().slice(1).toLowerCase() : null;
  const kindOfActive = active !== null ? textKindOf(editing) : null;
  const editingCount = s.presence.filter((p) => p.editing).length;
  const openThreads = (threads.data ?? []).filter((x) => !x.resolvedAt).length;
  const pendingNew = byBlock.get(blocks.length - 1)?.filter((x) => !x.before) ?? [];

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
          <Button variant="outline" size="sm" onClick={() => setSuggest(!suggest)} aria-pressed={suggest}>
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
          <div
            role="toolbar"
            aria-label={t.toolbar}
            className="sticky top-0 z-3 flex flex-wrap items-center gap-0.5 border-b border-border bg-background px-5 py-1.5"
          >
            <NativeSelect
              aria-label={t.blockType}
              size="sm"
              className="w-36! shrink-0 text-sm"
              disabled={!canEdit || kindOfActive === null}
              value={kindOfActive ?? ""}
              onChange={(e) => setEditing(setTextKind(editing, e.currentTarget.value as "h1" | "h2" | "h3" | "para"))}
            >
              <option value="" disabled>
                {t.blockType}
              </option>
              <option value="para">{t.para}</option>
              <option value="h1">{t.h1}</option>
              <option value="h2">{t.h2}</option>
              <option value="h3">{t.h3}</option>
            </NativeSelect>
            <Sep />
            <Tb label={t.bold} disabled={active === null} onClick={() => mark("bold")} className="font-bold">
              B
            </Tb>
            <Tb label={t.italic} disabled={active === null} onClick={() => mark("italic")} className="italic">
              I
            </Tb>
            <Tb label={t.strike} disabled={active === null} onClick={() => mark("strike")} className="line-through">
              S
            </Tb>
            <Tb label={t.code} disabled={active === null} onClick={() => mark("code")} className="font-mono">
              {"</>"}
            </Tb>
            <Tb label={t.link} disabled={active === null} onClick={() => mark("link")}>
              ↗
            </Tb>
            <Sep />
            <Tb label={t.insert.bullet} disabled={!canEdit} onClick={() => insert("bullet")}>
              •≡
            </Tb>
            <Tb label={t.insert.ordered} disabled={!canEdit} onClick={() => insert("ordered")}>
              1≡
            </Tb>
            <Tb label={t.insert.checklist} disabled={!canEdit} onClick={() => insert("checklist")}>
              ☑
            </Tb>
            <Tb label={t.insert.table} disabled={!canEdit} onClick={() => insert("table")}>
              ▦
            </Tb>
            <Tb label={t.insert.callout} disabled={!canEdit} onClick={() => insert("callout")}>
              ⓘ
            </Tb>
            <Tb
              label={t.insert.mermaid}
              disabled={!canEdit}
              onClick={() => insert("mermaid")}
              className="w-auto px-1.5 font-mono text-xs"
            >
              mmd
            </Tb>
            <Sep />
            <Tb label={t.comment} onClick={() => startComment(active)}>
              ❝
            </Tb>
            <span className="flex-1" />
            <Button variant="ghost" size="sm" className="text-primary" onClick={() => setTab("ai")}>
              ✦ {t.askAi}
            </Button>
          </div>
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
            {!blocks.length && active === null && <p className="text-muted-foreground">{t.emptyDoc}</p>}
            {blocks.map((block, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: khối Markdown không có mã; vị trí là định danh của nó.
              <div key={`${i}:${block.slice(0, 24)}`} className="group relative">
                {active === i ? (
                  <BlockEditor
                    value={editing}
                    onChange={setEditing}
                    onDone={() => commit()}
                    onKeyDown={onKey}
                    area={area}
                    slash={slashQuery}
                    onSlash={insert}
                    onAi={() => {
                      setActive(null);
                      setTab("ai");
                    }}
                  />
                ) : (
                  <div
                    className={cn(
                      "-mx-2 rounded-md px-2 py-0.5",
                      canEdit && "cursor-text hover:bg-muted/60",
                      (byBlock.get(i)?.some((x) => x.before) ?? false) && "bg-warning-soft/40",
                    )}
                  >
                    <BlockView
                      block={block}
                      onToggle={
                        canEdit && !suggest
                          ? (line) => setContent(replaceBlock(content, i, toggleCheck(block, line)))
                          : undefined
                      }
                    />
                  </div>
                )}
                {active !== i && (
                  <div className="absolute top-0 right-0 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    {canEdit && (
                      <Button size="xs" variant="ghost" aria-label={t.editBlock} onClick={() => open(i)}>
                        ✎
                      </Button>
                    )}
                    <Button size="xs" variant="ghost" aria-label={t.comment} onClick={() => startComment(i)}>
                      ❝
                    </Button>
                  </div>
                )}
                {(byBlock.get(i) ?? [])
                  .filter((x) => x.before)
                  .map((x) => (
                    <SuggestionCard
                      key={x.id}
                      s={x}
                      canDecide={canEdit}
                      busy={decide.isPending || dirty}
                      onDecide={(accept) => decide.mutate({ id: x.id, accept })}
                    />
                  ))}
              </div>
            ))}
            {pendingNew.map((x) => (
              <SuggestionCard
                key={x.id}
                s={x}
                canDecide={canEdit}
                busy={decide.isPending || dirty}
                onDecide={(accept) => decide.mutate({ id: x.id, accept })}
              />
            ))}
            {active === blocks.length && (
              <BlockEditor
                value={editing}
                onChange={setEditing}
                onDone={() => {
                  const next = editing.trim();
                  setActive(null);
                  if (!next || next.startsWith("/")) return;
                  if (suggest) createSuggestion.mutate({ before: "", after: next });
                  else setContent(insertBlock(content, blocks.length - 1, next).content);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setActive(null);
                }}
                area={area}
                slash={slashQuery}
                onSlash={(k) => setEditing(blockTemplate(k, content))}
                onAi={() => {
                  setActive(null);
                  setTab("ai");
                }}
              />
            )}
            {canEdit && active !== blocks.length && (
              <Button
                variant="ghost"
                size="sm"
                className="mt-2 text-muted-foreground"
                onClick={() => {
                  commit();
                  setActive(blocks.length);
                  setEditing("");
                }}
              >
                + {t.newBlock}
              </Button>
            )}
          </article>
        </section>
        <aside className="flex min-w-[280px] max-w-[360px] flex-[1_1_320px] flex-col border-l border-border">
          <div role="tablist" className="flex gap-0.5 border-b border-border px-3">
            {(
              [
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
              quote={active !== null ? editing : undefined}
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

function Sep() {
  return <span aria-hidden="true" className="mx-1.5 h-4.5 w-px bg-border" />;
}

function Tb({
  label,
  onClick,
  disabled,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      // Giữ chữ đang chọn trong ô sửa khối khi bấm nút định dạng.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "inline-flex h-7.5 w-7.5 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-sm text-foreground hover:bg-muted disabled:cursor-default disabled:opacity-40",
        className,
      )}
    >
      {children}
    </button>
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

function BlockEditor({
  value,
  onChange,
  onDone,
  onKeyDown,
  area,
  slash,
  onSlash,
  onAi,
}: {
  value: string;
  onChange: (v: string) => void;
  onDone: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  area: React.RefObject<HTMLTextAreaElement | null>;
  slash: string | null;
  onSlash: (k: BlockTemplate) => void;
  onAi: () => void;
}) {
  const t = useText();
  const listId = useId();
  const options = SLASH.filter(
    (k) => slash === null || !slash || t.insert[k].toLowerCase().includes(slash) || k.includes(slash),
  );
  return (
    <div className="relative my-1">
      <Textarea
        ref={area}
        autoFocus
        aria-label={t.editBlock}
        aria-controls={slash !== null ? listId : undefined}
        className="min-h-20 font-mono text-sm"
        rows={Math.min(24, Math.max(3, value.split("\n").length + 1))}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      <div className="mt-1 flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={onDone}>
          {t.doneBlock}
        </Button>
      </div>
      {slash !== null && (
        <div
          id={listId}
          role="listbox"
          aria-label={t.slash}
          className="absolute top-full left-0 z-10 mt-1 w-72 rounded-lg border border-border bg-popover p-1 shadow-lg"
        >
          <div className="px-2.5 py-1.5 text-xs text-muted-foreground">{t.blocks}</div>
          {options.map((k) => (
            <button
              key={k}
              type="button"
              role="option"
              aria-selected="false"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onSlash(k)}
              className="flex w-full cursor-pointer flex-col rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left text-sm hover:bg-muted"
            >
              <span>{t.insert[k]}</span>
              {t.insertHint[k] && <span className="text-xs text-muted-foreground">{t.insertHint[k]}</span>}
            </button>
          ))}
          <button
            type="button"
            role="option"
            aria-selected="false"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onAi}
            className="flex w-full cursor-pointer flex-col rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left text-sm hover:bg-muted"
          >
            <span>✦ {t.writeAi}</span>
            <span className="text-xs text-muted-foreground">{t.writeAiHint}</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** Hiện một khối theo kiểu của nó; nội dung là chữ của người dùng nên không bao giờ dựng HTML thô. */
function BlockView({ block, onToggle }: { block: string; onToggle?: ((line: number) => void) | undefined }) {
  const { link } = useDocEditorEnv();
  const kind = blockKind(block);
  if (kind === "checklist") {
    return (
      <div className="my-2 flex flex-col gap-1.5">
        {block.split("\n").map((line, i) => {
          const m = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
          // biome-ignore lint/suspicious/noArrayIndexKey: dòng checklist không có mã; vị trí là định danh.
          if (!m) return <Markdown key={`${i}:${line}`} content={line} />;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: như trên.
            <label key={`${i}:${line}`} className="flex items-start gap-2.5 text-sm">
              <input
                type="checkbox"
                className="mt-1.5 accent-primary"
                checked={m[1] !== " "}
                disabled={!onToggle}
                onChange={() => onToggle?.(i)}
              />
              <span>{m[2]}</span>
            </label>
          );
        })}
      </div>
    );
  }
  if (kind === "callout") {
    const body = block
      .split("\n")
      .slice(1)
      .map((l) => l.replace(/^>\s?/, ""))
      .join("\n");
    return (
      <div className="my-4 flex gap-2.5 rounded-[10px] bg-accent px-3.5 py-3 text-sm text-accent-foreground">
        <span aria-hidden="true">ⓘ</span>
        <Markdown content={body} />
      </div>
    );
  }
  if (kind === "code" || kind === "mermaid") {
    const lines = block.split("\n");
    const lang = (lines[0] ?? "").replace(/^\s*(`{3,}|~{3,})/, "").trim();
    return (
      <figure className="my-3">
        {lang && (
          <figcaption className="mb-1 font-mono text-xs text-muted-foreground">
            {lang === "mermaid" ? "Mermaid" : lang}
          </figcaption>
        )}
        <pre className="overflow-x-auto rounded-lg bg-brand-navy px-3.5 py-3 font-mono text-sm leading-relaxed whitespace-pre-wrap text-[#E2E8F0]">
          {lines
            .slice(
              1,
              lines
                .at(-1)
                ?.trim()
                .match(/^(`{3,}|~{3,})$/)
                ? -1
                : undefined,
            )
            .join("\n")}
        </pre>
      </figure>
    );
  }
  if (kind === "embed") {
    const key = embedKey(block) ?? "";
    return (
      <>
        {link({
          to: { kind: "doc", key },
          className: "my-2 flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted",
          children: (
            <>
              <span aria-hidden="true">↗</span>
              <span className="font-mono">{key}</span>
            </>
          ),
        })}
      </>
    );
  }
  return (
    <div className="py-1">
      <Markdown content={block} />
    </div>
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
