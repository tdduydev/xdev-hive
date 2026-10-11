import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { Approval, ChatMessage, Project } from "@xdev-hive/contracts";
import { type FormEvent, useId, useState } from "react";
import { Alert } from "../components/ui/alert.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
import { Field, FieldLabel } from "../components/ui/field.tsx";
import { Input } from "../components/ui/input.tsx";
import { Pill } from "../components/ui/pill.tsx";
import { EmptyState, LoadFailure, LoadingState } from "../components/ui/query-state.tsx";
import { Select } from "../components/ui/select.tsx";
import { Textarea } from "../components/ui/textarea.tsx";
import { apiErrorMessage } from "../lib/api-errors.ts";
import { cx } from "../lib/cx.ts";
import { formatDayTime } from "../lib/format.ts";
import { awaitingLeader, describeAction, ROLE_LABEL } from "../lib/leader.ts";
import { useOrg } from "../shell/org-context.ts";
import { PageBody, PageHeader } from "../shell/page-header.tsx";

export interface LeaderSearch {
  /** Cuộc trò chuyện đang mở; bỏ trống thì mở cuộc mới nhất. */
  thread?: string;
}

export function validateLeaderSearch(search: Record<string, unknown>): LeaderSearch {
  return typeof search.thread === "string" ? { thread: search.thread } : {};
}

/** Chat với leader agent: leader chỉ đề xuất hành động, người có quyền duyệt thì hub mới thực hiện. */
export function LeaderPage() {
  const { api } = useOrg();
  const search = useSearch({ from: "/session/app/in-org/leader" });
  const navigate = useNavigate();
  const threads = useQuery(api.leader.threads.list.queryOptions({ input: {} }));
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const selected = search.thread ?? threads.data?.[0]?.id;
  const open = (thread: string) => navigate({ to: "/leader", search: { thread }, replace: true });

  let body: React.ReactNode;
  if (threads.isPending) body = <LoadingState />;
  else if (threads.isError) body = <LoadFailure error={threads.error} retry={threads.refetch} />;
  else {
    body = (
      <div className="grid gap-4 app:grid-cols-[18rem_minmax(0,1fr)]">
        <aside className="grid content-start gap-3">
          <NewThread projects={projects.data} onCreated={open} />
          <nav aria-label="Cuộc trò chuyện" className="grid gap-1">
            {threads.data.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-current={t.id === selected ? "page" : undefined}
                onClick={() => open(t.id)}
                className={cx(
                  "grid rounded-md px-3 py-2 text-left text-sm",
                  t.id === selected ? "bg-sel text-sel-fg" : "text-body hover:bg-subtle",
                )}
              >
                <span className="truncate font-medium">{t.title}</span>
                <span className="text-xs text-muted">{formatDayTime(t.updatedAt)}</span>
              </button>
            ))}
          </nav>
        </aside>
        {selected ? (
          <Thread key={selected} threadId={selected} projects={projects.data} />
        ) : (
          <EmptyState
            title="Chưa có cuộc trò chuyện nào"
            description="Tạo cuộc trò chuyện để hỏi leader về dự án, nhờ chia việc hoặc giao việc cho agent."
          />
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
          <FieldLabel htmlFor={ids.title}>Cuộc trò chuyện mới</FieldLabel>
          <Input id={ids.title} name="title" placeholder="Ví dụ: chia việc cho tính năng thanh toán" />
        </Field>
        <Field>
          <FieldLabel htmlFor={ids.project}>Dự án</FieldLabel>
          <Select id={ids.project} name="project" defaultValue="">
            <option value="">Cả tổ chức</option>
            {projects?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.key} · {p.name}
              </option>
            ))}
          </Select>
        </Field>
        {create.isError && <Alert>{apiErrorMessage(create.error)}</Alert>}
        <Button type="submit" variant="primary" disabled={create.isPending}>
          {create.isPending ? "Đang tạo…" : "Tạo"}
        </Button>
      </form>
    </Card>
  );
}

function Thread({ threadId, projects }: { threadId: string; projects: readonly Project[] | undefined }) {
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
    if (content) send.mutate(content);
  }

  return (
    <section aria-label={thread.data.thread.title} className="grid content-start gap-3">
      <h2 className="text-lg font-semibold text-ink">{thread.data.thread.title}</h2>
      <ol aria-label="Tin nhắn" className="grid gap-2.5">
        {thread.data.messages.map((m) => (
          <Message key={m.id} message={m} />
        ))}
      </ol>
      {waiting && (
        <p role="status" className="text-sm text-muted">
          Leader đang trả lời…
        </p>
      )}
      {pending.map((a) => (
        <ApprovalCard key={a.id} approval={a} projects={projects} />
      ))}
      <form noValidate onSubmit={onSend} className="grid gap-2">
        <label htmlFor={composer} className="text-sm font-medium text-ink">
          Nhắn cho leader
        </label>
        <Textarea
          id={composer}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          placeholder="Hỏi về dự án, nhờ chia việc, hoặc nhờ giao việc cho agent"
        />
        {send.isError && <Alert>{apiErrorMessage(send.error)}</Alert>}
        <div className="flex justify-end">
          <Button type="submit" variant="primary" disabled={send.isPending || !draft.trim()}>
            {send.isPending ? "Đang gửi…" : "Gửi"}
          </Button>
        </div>
      </form>
    </section>
  );
}

function Message({ message }: { message: ChatMessage }) {
  return (
    <li
      className={cx(
        "grid gap-1 rounded-lg border px-3.5 py-2.5",
        message.role === "user" && "border-sel-line bg-sel",
        message.role === "leader" && "border-line bg-surface",
        message.role === "system" && "border-transparent bg-subtle text-sm",
      )}
    >
      <span className="text-xs text-muted">
        {ROLE_LABEL[message.role]} · {formatDayTime(message.createdAt)}
      </span>
      <p className="whitespace-pre-wrap break-words text-ink">{message.content}</p>
    </li>
  );
}

function ApprovalCard({ approval, projects }: { approval: Approval; projects: readonly Project[] | undefined }) {
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
    <Card className="grid gap-2.5 border-warn p-3.5" aria-label="Đề xuất của leader">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone="warn" small>
          Chờ duyệt
        </Pill>
        <span className="text-xs text-muted">Hết hạn {formatDayTime(approval.expiresAt)}</span>
      </div>
      <p className="font-medium text-ink">{describeAction(approval.action, projects)}</p>
      {error && <Alert>{apiErrorMessage(error)}</Alert>}
      {rejecting ? (
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (reason.trim()) reject.mutate();
          }}
          className="grid gap-2"
        >
          <label htmlFor={reasonId} className="text-sm font-medium text-ink">
            Lý do từ chối
          </label>
          <Textarea id={reasonId} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={() => setRejecting(false)} disabled={busy}>
              Thôi
            </Button>
            <Button type="submit" variant="danger" disabled={busy || !reason.trim()}>
              Từ chối
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={() => setRejecting(true)} disabled={busy}>
            Từ chối…
          </Button>
          <Button variant="primary" onClick={() => approve.mutate()} disabled={busy}>
            {approve.isPending ? "Đang thực hiện…" : "Duyệt và thực hiện"}
          </Button>
        </div>
      )}
    </Card>
  );
}
