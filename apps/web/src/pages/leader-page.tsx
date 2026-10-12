import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { Approval, ChatMessage, Project } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Input } from "@xdev-hive/ui/input";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { Textarea } from "@xdev-hive/ui/textarea";
import { SearchIcon, SquarePenIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { Card } from "@/components/ui/card.tsx";
import { Field, FieldLabel } from "@/components/ui/field.tsx";
import { EmptyState, LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { cx } from "@/lib/cx.ts";
import { formatDayTime } from "@/lib/format.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { awaitingLeader, describeAction } from "@/lib/leader.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

const text: Dict<
  Record<
    | "search"
    | "noMatches"
    | "scope"
    | "enterHint"
    | "you"
    | "system"
    | "expires"
    | "threads"
    | "emptyTitle"
    | "emptyDescription"
    | "newThread"
    | "newPlaceholder"
    | "project"
    | "wholeOrg"
    | "creating"
    | "create"
    | "messages"
    | "typing"
    | "composerLabel"
    | "composerPlaceholder"
    | "sending"
    | "send"
    | "proposal"
    | "pending"
    | "rejectReason"
    | "cancel"
    | "reject"
    | "rejectMore"
    | "executing"
    | "approve",
    string
  >
> = {
  vi: {
    search: "Tìm cuộc trò chuyện",
    noMatches: "Không có cuộc trò chuyện phù hợp.",
    scope: "leader của tổ chức",
    enterHint: "Enter để gửi · Shift+Enter xuống dòng",
    you: "Bạn",
    system: "Hệ thống",
    expires: "Hết hạn",
    threads: "Cuộc trò chuyện",
    emptyTitle: "Chưa có cuộc trò chuyện nào",
    emptyDescription: "Tạo cuộc trò chuyện để hỏi leader về dự án, nhờ chia việc hoặc giao việc cho agent.",
    newThread: "Cuộc trò chuyện mới",
    newPlaceholder: "Ví dụ: chia việc cho tính năng thanh toán",
    project: "Dự án",
    wholeOrg: "Cả tổ chức",
    creating: "Đang tạo…",
    create: "Tạo",
    messages: "Tin nhắn",
    typing: "Leader đang trả lời…",
    composerLabel: "Nhắn cho leader",
    composerPlaceholder: "Hỏi về dự án, nhờ chia việc, hoặc nhờ giao việc cho agent",
    sending: "Đang gửi…",
    send: "Gửi",
    proposal: "Đề xuất của leader",
    pending: "Chờ duyệt",
    rejectReason: "Lý do từ chối",
    cancel: "Thôi",
    reject: "Từ chối",
    rejectMore: "Từ chối…",
    executing: "Đang thực hiện…",
    approve: "Duyệt và thực hiện",
  },
  en: {
    search: "Search conversations",
    noMatches: "No matching conversations.",
    scope: "organization leader",
    enterHint: "Enter to send · Shift+Enter for a new line",
    you: "You",
    system: "System",
    expires: "Expires",
    threads: "Conversations",
    emptyTitle: "No conversations yet",
    emptyDescription: "Create a conversation to ask about a project, split work or assign tasks to agents.",
    newThread: "New conversation",
    newPlaceholder: "e.g. split the payments feature into tasks",
    project: "Project",
    wholeOrg: "Whole organization",
    creating: "Creating…",
    create: "Create",
    messages: "Messages",
    typing: "Leader is replying…",
    composerLabel: "Message the leader",
    composerPlaceholder: "Ask about a project, split work, or have the leader assign tasks to agents",
    sending: "Sending…",
    send: "Send",
    proposal: "Leader proposal",
    pending: "Awaiting approval",
    rejectReason: "Reason for rejecting",
    cancel: "Never mind",
    reject: "Reject",
    rejectMore: "Reject…",
    executing: "Running…",
    approve: "Approve and run",
  },
};

export interface LeaderSearch {
  /** Cuộc trò chuyện đang mở; bỏ trống thì mở cuộc mới nhất. */
  thread?: string;
}

export function validateLeaderSearch(search: Record<string, unknown>): LeaderSearch {
  return typeof search.thread === "string" ? { thread: search.thread } : {};
}

/** Chat với leader agent: leader chỉ đề xuất hành động, người có quyền duyệt thì hub mới thực hiện. */
export function LeaderPage() {
  const t = useT(text);
  const { api } = useOrg();
  const search = useSearch({ from: "/session/app/in-org/leader" });
  const navigate = useNavigate();
  const threads = useQuery(api.leader.threads.list.queryOptions({ input: {} }));
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const [filter, setFilter] = useState("");
  const [showNew, setShowNew] = useState(false);
  const selected = search.thread ?? threads.data?.[0]?.id;
  const open = (thread: string) => navigate({ to: "/leader", search: { thread }, replace: true });

  let body: React.ReactNode;
  if (threads.isPending) body = <LoadingState />;
  else if (threads.isError) body = <LoadFailure error={threads.error} retry={threads.refetch} />;
  else {
    body = (
      <div className="grid min-w-0 gap-4 app:grid-cols-[18rem_minmax(0,1fr)]">
        <aside className="grid min-w-0 content-start gap-3">
          <div className="flex items-center justify-between">
            <h2 className="font-heading text-lg font-semibold">{t.threads}</h2>
            <Button
              variant="outline"
              size="icon"
              aria-label={t.newThread}
              aria-expanded={showNew || threads.data.length === 0}
              onClick={() => setShowNew((value) => !value)}
            >
              <SquarePenIcon aria-hidden="true" />
            </Button>
          </div>
          {(showNew || threads.data.length === 0) && (
            <NewThread
              projects={projects.data}
              onCreated={(id) => {
                setShowNew(false);
                void open(id);
              }}
            />
          )}
          <div className="relative">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground"
            />
            <Input
              className="pl-8"
              aria-label={t.search}
              placeholder={t.search}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>
          <nav aria-label={t.threads} className="grid gap-1">
            {threads.data
              .filter((thread) => thread.title.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))
              .map((thread) => (
                <button
                  key={thread.id}
                  type="button"
                  aria-current={thread.id === selected ? "page" : undefined}
                  onClick={() => open(thread.id)}
                  className={cx(
                    "grid min-w-0 cursor-pointer rounded-md px-3 py-2 text-left text-xs transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                    thread.id === selected ? "bg-accent text-accent-foreground" : "text-foreground hover:bg-muted",
                  )}
                >
                  <span className="truncate font-medium">{thread.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {projects.data?.find((project) => project.id === thread.projectId)?.key ?? t.wholeOrg} ·{" "}
                    {formatDayTime(thread.updatedAt)}
                  </span>
                </button>
              ))}
          </nav>
          {filter &&
            !threads.data.some((thread) =>
              thread.title.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()),
            ) && <p className="text-sm text-muted-foreground">{t.noMatches}</p>}
        </aside>
        {selected ? (
          <Thread key={selected} threadId={selected} projects={projects.data} />
        ) : (
          <EmptyState title={t.emptyTitle} description={t.emptyDescription} />
        )}
      </div>
    );
  }

  return (
    <>
      <PageHeader title="Leader" />
      <PageBody>{body}</PageBody>
    </>
  );
}

function NewThread({
  projects,
  onCreated,
}: {
  projects: readonly Project[] | undefined;
  onCreated: (id: string) => void;
}) {
  const t = useT(text);
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const ids = { title: useId(), project: useId() };
  const create = useMutation({
    mutationFn: (input: { title: string; projectId: string | null }) => api.leader.threads.create.call(input),
    onSuccess: async (thread) => {
      await queryClient.invalidateQueries({ queryKey: api.leader.threads.list.key() });
      onCreated(thread.id);
    },
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const title = String(form.get("title") ?? "").trim();
    if (!title) return;
    const projectId = String(form.get("project") ?? "") || null;
    create.mutate({ title, projectId });
    e.currentTarget.reset();
  }

  return (
    <Card className="grid gap-2.5 p-3">
      <form noValidate onSubmit={onSubmit} className="grid gap-2.5">
        <Field>
          <FieldLabel htmlFor={ids.title}>{t.newThread}</FieldLabel>
          <Input id={ids.title} name="title" placeholder={t.newPlaceholder} />
        </Field>
        <Field>
          <FieldLabel htmlFor={ids.project}>{t.project}</FieldLabel>
          <NativeSelect id={ids.project} name="project" defaultValue="">
            <option value="">{t.wholeOrg}</option>
            {projects?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.key} · {p.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        {create.isError && <Alert variant="destructive">{apiErrorMessage(create.error)}</Alert>}
        <Button type="submit" variant="default" disabled={create.isPending}>
          {create.isPending ? t.creating : t.create}
        </Button>
      </form>
    </Card>
  );
}

function Thread({ threadId, projects }: { threadId: string; projects: readonly Project[] | undefined }) {
  const t = useT(text);
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const composer = useId();
  const [draft, setDraft] = useState("");
  const thread = useQuery({
    ...api.leader.threads.get.queryOptions({ input: { id: threadId } }),
    // Leader trả lời bằng một run trên máy: hỏi lại hub định kỳ tới khi có tin trả lời.
    refetchInterval: (q) => (awaitingLeader(q.state.data?.messages) ? 3000 : false),
  });
  const approvals = useQuery({
    ...api.leader.approvals.list.queryOptions({ input: { status: "pending" } }),
    refetchInterval: 10_000,
  });
  const send = useMutation({
    mutationFn: (content: string) => api.leader.threads.send.call({ id: threadId, content }),
    onSuccess: async () => {
      setDraft("");
      await queryClient.invalidateQueries({ queryKey: api.leader.threads.get.key() });
    },
  });

  if (thread.isPending) return <LoadingState />;
  if (thread.isError) return <LoadFailure error={thread.error} retry={thread.refetch} />;
  const pending = approvals.data?.filter((a) => a.threadId === threadId) ?? [];
  const waiting = awaitingLeader(thread.data.messages) || send.isPending;

  function onSend(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const content = draft.trim();
    if (content && !waiting) send.mutate(content);
  }

  return (
    <section
      aria-label={thread.data.thread.title}
      className="flex min-w-0 flex-col gap-3 overflow-hidden rounded-xl border border-border bg-card"
    >
      <header className="grid gap-1 border-b border-border px-4 py-3">
        <h2 className="break-words text-base font-semibold text-foreground">{thread.data.thread.title}</h2>
        <p className="text-xs text-muted-foreground">
          {projects?.find((project) => project.id === thread.data.thread.projectId)?.key ?? t.wholeOrg} · {t.scope}
        </p>
      </header>
      <div className="grid min-w-0 flex-1 content-start gap-4 p-4">
        <ol aria-label={t.messages} className="grid gap-2.5">
          {thread.data.messages.map((m) => (
            <Message key={m.id} message={m} />
          ))}
        </ol>
        {waiting && (
          <p role="status" className="text-xs text-muted-foreground">
            {t.typing}
          </p>
        )}
        {approvals.isError && <LoadFailure error={approvals.error} retry={approvals.refetch} />}
        {pending.map((a) => (
          <ApprovalCard key={a.id} approval={a} projects={projects} />
        ))}
      </div>
      <form noValidate onSubmit={onSend} className="grid gap-2 border-t border-border p-4">
        <label htmlFor={composer} className="text-xs font-medium text-foreground">
          {t.composerLabel}
        </label>
        <Textarea
          id={composer}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (draft.trim() && !waiting) send.mutate(draft.trim());
            }
          }}
          placeholder={t.composerPlaceholder}
        />
        {send.isError && <Alert variant="destructive">{apiErrorMessage(send.error)}</Alert>}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="mr-auto text-xs text-muted-foreground">{t.enterHint}</span>
          <Button type="submit" variant="default" disabled={waiting || !draft.trim()}>
            {send.isPending ? t.sending : t.send}
          </Button>
        </div>
      </form>
    </section>
  );
}

function Message({ message }: { message: ChatMessage }) {
  const t = useT(text);
  return (
    <li
      className={cx(
        "grid max-w-full gap-1 rounded-xl border px-3.5 py-2.5 sm:max-w-[80%]",
        message.role === "user" && "justify-self-end border-primary bg-primary text-primary-foreground",
        message.role === "leader" && "justify-self-start border-border bg-muted",
        message.role === "system" && "justify-self-center border-transparent text-xs text-muted-foreground",
      )}
    >
      <span className={cx("text-xs", message.role !== "user" && "text-muted-foreground")}>
        {{ user: t.you, leader: "Leader", system: t.system }[message.role]} · {formatDayTime(message.createdAt)}
      </span>
      <p className="whitespace-pre-wrap break-words">{message.content}</p>
    </li>
  );
}

function ApprovalCard({ approval, projects }: { approval: Approval; projects: readonly Project[] | undefined }) {
  const t = useT(text);
  const lang = useLang();
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const reasonId = useId();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: api.leader.approvals.list.key() });
    await queryClient.invalidateQueries({ queryKey: api.leader.threads.get.key() });
  };
  const approve = useMutation({
    mutationFn: () => api.leader.approvals.approve.call({ id: approval.id }),
    onSuccess: refresh,
  });
  const reject = useMutation({
    mutationFn: () => api.leader.approvals.reject.call({ id: approval.id, reason: reason.trim() }),
    onSuccess: refresh,
  });
  const busy = approve.isPending || reject.isPending;
  const error = approve.error ?? reject.error;

  return (
    <Card className="grid gap-2.5 p-3.5 ring-warning" aria-label={t.proposal}>
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone="warn" small>
          {t.pending}
        </Pill>
        <span className="text-xs text-muted-foreground">
          {t.expires} {formatDayTime(approval.expiresAt)}
        </span>
      </div>
      <p className="rounded-lg border border-border p-3 font-medium break-words text-foreground">
        {describeAction(approval.action, projects, lang)}
      </p>
      {error && <Alert variant="destructive">{apiErrorMessage(error)}</Alert>}
      {rejecting ? (
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (reason.trim()) reject.mutate();
          }}
          className="grid gap-2"
        >
          <label htmlFor={reasonId} className="text-xs font-medium text-foreground">
            {t.rejectReason}
          </label>
          <Textarea autoFocus id={reasonId} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={() => setRejecting(false)} disabled={busy}>
              {t.cancel}
            </Button>
            <Button type="submit" variant="destructive" disabled={busy || !reason.trim()}>
              {t.reject}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => setRejecting(true)} disabled={busy}>
            {t.rejectMore}
          </Button>
          <Button variant="default" onClick={() => approve.mutate()} disabled={busy}>
            {approve.isPending ? t.executing : t.approve}
          </Button>
        </div>
      )}
    </Card>
  );
}
