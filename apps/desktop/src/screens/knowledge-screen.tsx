import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { type MemorySearchHit, matchKnowledge } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Input } from "@xdev-hive/ui/input";
import { Markdown } from "@xdev-hive/ui/markdown";
import { ArrowLeftIcon, FilePenLineIcon, SearchIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState, useSyncExternalStore } from "react";
import { api, queryClient } from "@/lib/hub-query.tsx";
import { type Dict, useT } from "@/lib/i18n.ts";
import { screenParam } from "@/lib/nav.ts";
import { errorText } from "@/lib/tauri.ts";

const text: Dict<{
  lead: string;
  search: string;
  placeholder: string;
  submit: string;
  docs: string;
  memory: string;
  skills: string;
  none: string;
  loading: string;
  back: string;
  edit: string;
  version: (v: number) => string;
  kinds: Record<MemorySearchHit["kind"], string>;
}> = {
  vi: {
    lead: "Tìm tài liệu đã duyệt, memory và skill của đội. Chỉ đọc; sửa tài liệu ở màn Soạn tài liệu.",
    search: "Tìm tri thức",
    placeholder: "vd. hoàn tiền, migration, quy ước đặt tên…",
    submit: "Tìm",
    docs: "Tài liệu",
    memory: "Memory",
    skills: "Skill",
    none: "Không có kết quả.",
    loading: "Đang tải…",
    back: "Tra cứu tri thức",
    edit: "Sửa trong trình soạn",
    version: (v) => `bản ${v}`,
    kinds: { decision: "Quyết định", convention: "Quy ước", gotcha: "Lưu ý", note: "Ghi chú" },
  },
  en: {
    lead: "Search your team's approved docs, memory and skills. Read-only; edit docs in Write docs.",
    search: "Search knowledge",
    placeholder: "e.g. refund, migration, naming convention…",
    submit: "Search",
    docs: "Docs",
    memory: "Memory",
    skills: "Skills",
    none: "No results.",
    loading: "Loading…",
    back: "Knowledge",
    edit: "Edit in the editor",
    version: (v) => `v${v}`,
    kinds: { decision: "Decision", convention: "Convention", gotcha: "Gotcha", note: "Note" },
  },
};

function subscribe(listener: () => void) {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

/**
 * Màn Tra cứu tri thức (spec 008 US12, FR-025): một ô tìm cho tài liệu, memory và skill người dùng đọc được. Tài liệu
 * và skill lọc trên danh sách của hub (`matchKnowledge`), memory tìm trên hub theo từ và theo nghĩa. `#/knowledge/doc/
 * <key>` và `#/knowledge/skill/<id>` mở bản chỉ đọc; tài liệu có nút sang trình soạn (US9).
 */
export function KnowledgeScreen() {
  const param = useSyncExternalStore(subscribe, () => screenParam(location.hash));
  const [kind, ...rest] = param.split("/");
  const ref = rest.join("/");
  return (
    <QueryClientProvider client={queryClient}>
      {kind === "doc" && ref ? <DocView docKey={ref} /> : kind === "skill" && ref ? <SkillView id={ref} /> : <Search />}
    </QueryClientProvider>
  );
}

// Ô tìm giữ qua lần mở rồi quay lại một kết quả (màn bị dựng lại khi đổi hash).
let lastQuery = "";

function Search() {
  const t = useT(text);
  const fieldId = useId();
  const [draft, setDraft] = useState(lastQuery);
  const [query, setQuery] = useState(lastQuery);
  const docs = useQuery(api.docs.list.queryOptions({ input: {} }));
  const skills = useQuery(api.skills.list.queryOptions({ input: {} }));
  const memory = useQuery({
    ...api.memory.search.queryOptions({ input: { query, limit: 20 } }),
    enabled: query.length > 0,
  });
  const found = matchKnowledge(query, docs.data ?? [], skills.data ?? []);
  const error = docs.error ?? skills.error ?? memory.error;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    lastQuery = draft.trim();
    setQuery(lastQuery);
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <p className="text-sm text-muted-foreground">{t.lead}</p>
      <search>
        <form onSubmit={onSubmit} className="flex items-end gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
            <label htmlFor={fieldId} className="font-medium">
              {t.search}
            </label>
            <Input
              id={fieldId}
              type="search"
              placeholder={t.placeholder}
              value={draft}
              maxLength={500}
              onChange={(e) => setDraft(e.target.value)}
            />
          </div>
          <Button type="submit">
            <SearchIcon aria-hidden="true" />
            {t.submit}
          </Button>
        </form>
      </search>
      {error && <Alert variant="destructive">{errorText(error)}</Alert>}
      {query && (
        <>
          <Results title={t.docs} loading={docs.isPending} count={found.docs.length}>
            {found.docs.map((d) => (
              <ResultLink key={d.id} href={`#/knowledge/doc/${encodeURIComponent(d.key)}`}>
                <span className="truncate text-sm font-medium">{d.title}</span>
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {d.key} · {t.version(d.version)}
                </span>
              </ResultLink>
            ))}
          </Results>
          <Results title={t.memory} loading={memory.isPending} count={memory.data?.length ?? 0}>
            {memory.data?.map((m) => (
              <li key={m.id} className="flex flex-col gap-1 px-4 py-2.5">
                <span className="text-xs font-medium text-muted-foreground">{t.kinds[m.kind]}</span>
                <span className="text-sm whitespace-pre-wrap">{m.content}</span>
                {m.files.length > 0 && (
                  <span className="truncate font-mono text-xs text-muted-foreground">{m.files.join(", ")}</span>
                )}
              </li>
            ))}
          </Results>
          <Results title={t.skills} loading={skills.isPending} count={found.skills.length}>
            {found.skills.map((s) => (
              <ResultLink key={s.id} href={`#/knowledge/skill/${encodeURIComponent(s.id)}`}>
                <span className="truncate font-mono text-sm font-medium">{s.name}</span>
                <span className="line-clamp-2 text-xs text-muted-foreground">{s.description}</span>
              </ResultLink>
            ))}
          </Results>
        </>
      )}
    </div>
  );
}

function Results({
  title,
  loading,
  count,
  children,
}: {
  title: string;
  loading: boolean;
  count: number;
  children: ReactNode;
}) {
  const t = useT(text);
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold">
        {title} {!loading && <span className="font-normal text-muted-foreground">({count})</span>}
      </h2>
      <div className="overflow-hidden rounded-xl border bg-card text-card-foreground">
        {loading ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">{t.loading}</p>
        ) : count === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">{t.none}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y p-0">{children}</ul>
        )}
      </div>
    </section>
  );
}

function ResultLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <li>
      <a href={href} className="flex min-w-0 flex-col gap-0.5 px-4 py-2.5 text-foreground no-underline hover:bg-muted">
        {children}
      </a>
    </li>
  );
}

function Reader({
  title,
  meta,
  content,
  error,
  action,
}: {
  title: string | undefined;
  meta: string | undefined;
  content: string | undefined;
  error: unknown;
  action?: ReactNode;
}) {
  const t = useT(text);
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={() => (location.hash = "#/knowledge")}>
          <ArrowLeftIcon aria-hidden="true" />
          {t.back}
        </Button>
        {action}
      </div>
      {error ? (
        <Alert variant="destructive">{errorText(error)}</Alert>
      ) : content === undefined ? (
        <p className="text-sm text-muted-foreground">{t.loading}</p>
      ) : (
        <article className="flex flex-col gap-3 rounded-xl border bg-card px-5 py-4 text-card-foreground">
          <header className="flex flex-col gap-0.5">
            <h2 className="text-base font-semibold">{title}</h2>
            <span className="font-mono text-xs text-muted-foreground">{meta}</span>
          </header>
          <Markdown content={content} />
        </article>
      )}
    </div>
  );
}

function DocView({ docKey }: { docKey: string }) {
  const t = useT(text);
  const doc = useQuery(api.docs.get.queryOptions({ input: { key: docKey } }));
  return (
    <Reader
      title={doc.data?.title}
      meta={doc.data && `${doc.data.key} · ${t.version(doc.data.version)}`}
      content={doc.data?.content}
      error={doc.error}
      action={
        <Button variant="outline" size="sm" onClick={() => (location.hash = `#/write/${encodeURIComponent(docKey)}`)}>
          <FilePenLineIcon aria-hidden="true" />
          {t.edit}
        </Button>
      }
    />
  );
}

function SkillView({ id }: { id: string }) {
  const t = useT(text);
  const skill = useQuery(api.skills.get.queryOptions({ input: { id } }));
  return (
    <Reader
      title={skill.data?.name}
      meta={skill.data && `${skill.data.description} · ${t.version(skill.data.version)}`}
      content={skill.data?.content}
      error={skill.error}
    />
  );
}
