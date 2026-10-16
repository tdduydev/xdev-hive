import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Approval, ChatMessage, LeaderAction, Project } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Input } from "@xdev-hive/ui/input";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { Textarea } from "@xdev-hive/ui/textarea";
import { type FormEvent, useId, useRef, useState } from "react";
import { bridge, hub } from "@/bridge.ts";

const text = {
  vi: {
    tabLeader: "Leader",
    tabAssign: "Giao việc",
    threads: "Cuộc trò chuyện",
    newThread: "Cuộc trò chuyện mới",
    newPlaceholder: "Ví dụ: chia việc cho tính năng thanh toán",
    project: "Dự án",
    wholeOrg: "Cả tổ chức",
    create: "Tạo",
    creating: "Đang tạo…",
    emptyTitle: "Chưa có cuộc trò chuyện nào",
    emptyDescription: "Tạo cuộc trò chuyện để hỏi Leader về dự án hoặc nhờ chia việc.",
    messages: "Tin nhắn",
    you: "Bạn",
    system: "Hệ thống",
    typing: "Leader đang trả lời…",
    stalled: "Leader chưa trả lời sau 5 phút. Tải lại màn hình để xem tiếp.",
    artifact: "Artifact",
    composerLabel: "Nhắn cho Leader",
    composerPlaceholder: "Hỏi về dự án, nhờ chia việc, hoặc nhờ giao việc cho agent",
    enterHint: "Enter để gửi · Shift+Enter xuống dòng",
    send: "Gửi",
    sending: "Đang gửi…",
    loading: "Đang tải…",
    failed: "Không thực hiện được thao tác. Vui lòng thử lại.",
    proposal: "Đề xuất của Leader",
    pending: "Chờ duyệt",
    approved: "Đã duyệt",
    rejected: "Đã từ chối",
    expired: "Hết hạn",
    leaderTier: "Leader chọn cấp",
    tierReason: "Lý do",
    approve: "Duyệt",
    executing: "Đang thực hiện…",
    reject: "Từ chối",
    rejectMore: "Từ chối…",
    rejectReason: "Lý do từ chối",
    cancel: "Thôi",
    assignTitle: "Giao việc cho agent",
    taskTitle: "Tiêu đề",
    taskBody: "Mô tả",
    taskBodyPlaceholder: "Việc cần làm, tiêu chí hoàn thành, tệp liên quan",
    dispatch: "Giao cho agent ngay",
    dispatchHint: "Không chọn thì chỉ tạo việc trong danh sách, giao sau.",
    assign: "Tạo việc",
    assigning: "Đang tạo…",
    noProjects: "Bạn chưa thấy dự án nào.",
    created: "Đã tạo việc {key}.",
    createdDispatched: "Đã tạo việc {key} và giao cho agent.",
    createdNotDispatched: "Đã tạo việc {key} nhưng chưa giao được cho agent. Giao lại từ danh sách việc.",
    unknown: "không rõ",
    anyAgent: "agent bất kỳ",
    action: {
      "task.create": 'Tạo việc "{title}" trong dự án {project}',
      "run.dispatch": "Giao việc {id} cho {cli}",
      "run.cancel": "Huỷ run {id}",
      "project.settings": "Đổi cấu hình dự án {project}: {keys}",
      "sdlc.item.create": 'Tạo hạng mục AI SDLC "{title}" trong dự án {project}',
    },
    tiers: { light: "Nhẹ", medium: "Vừa", heavy: "Nặng" },
  },
  en: {
    tabLeader: "Leader",
    tabAssign: "Assign work",
    threads: "Conversations",
    newThread: "New conversation",
    newPlaceholder: "For example: split the checkout feature into tasks",
    project: "Project",
    wholeOrg: "Whole organization",
    create: "Create",
    creating: "Creating…",
    emptyTitle: "No conversations yet",
    emptyDescription: "Start a conversation to ask the Leader about a project or have it split work.",
    messages: "Messages",
    you: "You",
    system: "System",
    typing: "Leader is replying…",
    stalled: "The Leader has not replied after 5 minutes. Reload the screen to keep watching.",
    artifact: "Artifact",
    composerLabel: "Message the Leader",
    composerPlaceholder: "Ask about a project, split work, or have the Leader assign tasks to agents",
    enterHint: "Enter to send · Shift+Enter for a new line",
    send: "Send",
    sending: "Sending…",
    loading: "Loading…",
    failed: "The action failed. Please try again.",
    proposal: "Leader proposal",
    pending: "Awaiting approval",
    approved: "Approved",
    rejected: "Rejected",
    expired: "Expired",
    leaderTier: "Leader picked tier",
    tierReason: "Reason",
    approve: "Approve",
    executing: "Running…",
    reject: "Reject",
    rejectMore: "Reject…",
    rejectReason: "Reason for rejecting",
    cancel: "Never mind",
    assignTitle: "Assign work to an agent",
    taskTitle: "Title",
    taskBody: "Description",
    taskBodyPlaceholder: "What to do, acceptance criteria, related files",
    dispatch: "Assign to an agent now",
    dispatchHint: "Leave unchecked to only create the task and assign it later.",
    assign: "Create task",
    assigning: "Creating…",
    noProjects: "You cannot see any project yet.",
    created: "Created task {key}.",
    createdDispatched: "Created task {key} and assigned it to an agent.",
    createdNotDispatched: "Created task {key} but could not assign it to an agent. Assign it again from the task list.",
    unknown: "unknown",
    anyAgent: "any agent",
    action: {
      "task.create": 'Create task "{title}" in project {project}',
      "run.dispatch": "Assign task {id} to {cli}",
      "run.cancel": "Cancel run {id}",
      "project.settings": "Change project {project} settings: {keys}",
      "sdlc.item.create": 'Create AI SDLC item "{title}" in project {project}',
    },
    tiers: { light: "Light", medium: "Medium", heavy: "Heavy" },
  },
};
type Text = typeof text.vi;

const useText = (): Text => (document.documentElement.lang === "en" ? text.en : text.vi);
const fill = (template: string, params: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (match, name: string) => params[name] ?? match);

const api = createTanstackQueryUtils(hub);

// Leader trả lời bằng một run trên máy: hỏi lại mỗi 2 giây, tối đa 5 phút (plan.md mục 5).
const POLL_MS = 2000;
const POLL_LIMIT_MS = 5 * 60_000;

const awaitingLeader = (messages: readonly ChatMessage[] | undefined) => messages?.at(-1)?.role === "user";

/** Lỗi từ hub đã qua host nên không chứa token; thông điệp lạ thì dùng câu cố định. */
const errorText = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

const STATUS_TONE = { pending: "warn", approved: "ok", rejected: "bad", expired: "neutral" } as const;

function describeAction(action: LeaderAction, projects: readonly Project[] | undefined, t: Text): string {
  const project = (id: string) => projects?.find((p) => p.id === id)?.key ?? t.unknown;
  const template = t.action[action.type];
  switch (action.type) {
    case "task.create":
      return fill(template, { title: action.title, project: project(action.projectId) });
    case "run.dispatch":
      return fill(template, { id: action.taskId.slice(0, 8), cli: action.cli ?? t.anyAgent });
    case "run.cancel":
      return fill(template, { id: action.runId.slice(0, 8) });
    case "project.settings":
      return fill(template, { project: action.projectKey, keys: Object.keys(action.patch).join(", ") || "—" });
    case "sdlc.item.create":
      return fill(template, { title: action.item.title, project: project(action.item.projectId) });
  }
}

interface Persisted {
  tab: "leader" | "assign";
  threadId: string | null;
}

/**
 * Chat dự phòng cho editor không có khung Chat (plan.md mục 5): Leader qua `leader.threads.*` và form "Giao việc".
 * Webview bị huỷ khi tab ẩn, nên tab đang xem và cuộc trò chuyện được giữ trong state của VS Code.
 */
export function ChatScreen() {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5000 } } }));
  return (
    <QueryClientProvider client={client}>
      <ChatBody />
    </QueryClientProvider>
  );
}

function ChatBody() {
  const t = useText();
  const saved = bridge.getState<Persisted>();
  const [tab, setTab] = useState<Persisted["tab"]>(saved?.tab === "assign" ? "assign" : "leader");
  const [threadId, setThreadId] = useState<string | null>(saved?.threadId ?? null);
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const remember = (next: Persisted) => bridge.setState(next);
  const tabs = [
    { id: "leader", label: t.tabLeader },
    { id: "assign", label: t.tabAssign },
  ] as const;

  return (
    <div className="flex h-screen min-h-0 flex-col">
      <div role="tablist" className="flex gap-1 border-b px-3 pt-2">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`chat-tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls={`chat-panel-${item.id}`}
            onClick={() => {
              setTab(item.id);
              remember({ tab: item.id, threadId });
            }}
            className={`cursor-pointer rounded-t-md border-b-2 px-3 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-ring ${
              tab === item.id ? "border-primary font-medium" : "border-transparent text-muted-foreground"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`chat-panel-${tab}`}
        aria-labelledby={`chat-tab-${tab}`}
        className="flex min-h-0 flex-1 flex-col"
      >
        {tab === "leader" ? (
          <LeaderTab
            projects={projects.data}
            threadId={threadId}
            onSelect={(id) => {
              setThreadId(id);
              remember({ tab, threadId: id });
            }}
          />
        ) : (
          <AssignTab projects={projects.data} loading={projects.isPending} />
        )}
      </div>
    </div>
  );
}

function LeaderTab({
  projects,
  threadId,
  onSelect,
}: {
  projects: readonly Project[] | undefined;
  threadId: string | null;
  onSelect: (id: string) => void;
}) {
  const t = useText();
  const select = useId();
  const threads = useQuery(api.leader.threads.list.queryOptions({ input: {} }));
  const [showNew, setShowNew] = useState(false);
  // Id đã lưu có thể thuộc cuộc trò chuyện đã mất quyền xem: chỉ dùng khi còn trong danh sách.
  const selected = threads.data?.find((thread) => thread.id === threadId)?.id ?? threads.data?.[0]?.id;
  const empty = threads.data?.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid gap-2 border-b p-3">
        <div className="flex items-end gap-2">
          <div className="grid min-w-0 flex-1 gap-1">
            <label htmlFor={select} className="text-xs font-medium">
              {t.threads}
            </label>
            <NativeSelect id={select} value={selected ?? ""} onChange={(e) => onSelect(e.target.value)}>
              {threads.data?.map((thread) => (
                <option key={thread.id} value={thread.id}>
                  {thread.title}
                </option>
              ))}
            </NativeSelect>
          </div>
          <Button variant="outline" aria-expanded={showNew || empty} onClick={() => setShowNew((value) => !value)}>
            {t.newThread}
          </Button>
        </div>
        {(showNew || empty) && (
          <NewThread
            projects={projects}
            onCreated={(id) => {
              setShowNew(false);
              onSelect(id);
            }}
          />
        )}
        {threads.isPending && (
          <p role="status" className="text-xs text-muted-foreground">
            {t.loading}
          </p>
        )}
        {threads.isError && <Alert variant="destructive">{errorText(threads.error, t.failed)}</Alert>}
      </div>
      {selected ? (
        <Thread key={selected} threadId={selected} projects={projects} />
      ) : (
        !threads.isPending && (
          <div className="p-4">
            <h2 className="text-base font-semibold">{t.emptyTitle}</h2>
            <p className="text-muted-foreground">{t.emptyDescription}</p>
          </div>
        )
      )}
    </div>
  );
}

function NewThread({
  projects,
  onCreated,
}: {
  projects: readonly Project[] | undefined;
  onCreated: (id: string) => void;
}) {
  const t = useText();
  const queryClient = useQueryClient();
  const ids = { title: useId(), project: useId() };
  const create = useMutation({
    mutationFn: (input: { title: string; projectId: string | null }) => hub.leader.threads.create(input),
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
    create.mutate({ title, projectId: String(form.get("project") ?? "") || null });
  }
  return (
    <form noValidate onSubmit={onSubmit} className="grid gap-2 rounded-lg border p-3">
      <label htmlFor={ids.title} className="text-xs font-medium">
        {t.newThread}
      </label>
      <Input id={ids.title} name="title" placeholder={t.newPlaceholder} />
      <label htmlFor={ids.project} className="text-xs font-medium">
        {t.project}
      </label>
      <NativeSelect id={ids.project} name="project" defaultValue="">
        <option value="">{t.wholeOrg}</option>
        {projects?.map((p) => (
          <option key={p.id} value={p.id}>
            {p.key} · {p.name}
          </option>
        ))}
      </NativeSelect>
      {create.isError && <Alert variant="destructive">{errorText(create.error, t.failed)}</Alert>}
      <Button type="submit" disabled={create.isPending}>
        {create.isPending ? t.creating : t.create}
      </Button>
    </form>
  );
}

function Thread({ threadId, projects }: { threadId: string; projects: readonly Project[] | undefined }) {
  const t = useText();
  const queryClient = useQueryClient();
  const composer = useId();
  const [draft, setDraft] = useState("");
  // Mốc bắt đầu chờ theo tin cuối của người dùng, để giới hạn 5 phút tính từ lúc hỏi chứ không từ lúc mở màn hình.
  const waitStart = useRef<{ messageId: string; at: number } | null>(null);
  const [stalled, setStalled] = useState(false);
  const thread = useQuery({
    ...api.leader.threads.get.queryOptions({ input: { id: threadId } }),
    refetchInterval: (query) => {
      const last = query.state.data?.messages.at(-1);
      if (last?.role !== "user") {
        waitStart.current = null;
        return false;
      }
      if (waitStart.current?.messageId !== last.id) waitStart.current = { messageId: last.id, at: Date.now() };
      if (Date.now() - waitStart.current.at >= POLL_LIMIT_MS) {
        setStalled(true);
        return false;
      }
      return POLL_MS;
    },
  });
  const approvals = useQuery({
    ...api.leader.approvals.list.queryOptions({ input: { status: "pending", threadId } }),
    refetchInterval: 10_000,
  });
  const send = useMutation({
    mutationFn: (content: string) => hub.leader.threads.send({ id: threadId, content }),
    onSuccess: async () => {
      setDraft("");
      setStalled(false);
      await queryClient.invalidateQueries({ queryKey: api.leader.threads.get.key() });
    },
  });

  if (thread.isPending)
    return (
      <p role="status" className="p-4 text-muted-foreground">
        {t.loading}
      </p>
    );
  if (thread.isError) return <Alert variant="destructive">{errorText(thread.error, t.failed)}</Alert>;
  const waiting = (awaitingLeader(thread.data.messages) && !stalled) || send.isPending;
  const submit = () => {
    const content = draft.trim();
    if (content && !waiting) send.mutate(content);
  };

  return (
    <section aria-label={thread.data.thread.title} className="flex min-h-0 flex-1 flex-col">
      <div className="grid min-h-0 flex-1 content-start gap-3 overflow-auto p-3">
        <ol aria-label={t.messages} className="m-0 grid list-none gap-2 p-0">
          {thread.data.messages.map((message) => (
            <Message key={message.id} message={message} />
          ))}
        </ol>
        {waiting && (
          <p role="status" className="text-xs text-muted-foreground">
            {t.typing}
          </p>
        )}
        {stalled && awaitingLeader(thread.data.messages) && (
          <p role="status" className="text-xs text-muted-foreground">
            {t.stalled}
          </p>
        )}
        {approvals.isError && <Alert variant="destructive">{errorText(approvals.error, t.failed)}</Alert>}
        {approvals.data?.map((approval) => (
          <ApprovalCard key={approval.id} approval={approval} projects={projects} />
        ))}
      </div>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="grid gap-2 border-t p-3"
      >
        <label htmlFor={composer} className="text-xs font-medium">
          {t.composerLabel}
        </label>
        <Textarea
          id={composer}
          value={draft}
          rows={3}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={t.composerPlaceholder}
        />
        {send.isError && <Alert variant="destructive">{errorText(send.error, t.failed)}</Alert>}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="mr-auto text-xs text-muted-foreground">{t.enterHint}</span>
          <Button type="submit" disabled={waiting || !draft.trim()}>
            {send.isPending ? t.sending : t.send}
          </Button>
        </div>
      </form>
    </section>
  );
}

function Message({ message }: { message: ChatMessage }) {
  const t = useText();
  const who = { user: t.you, leader: "Leader", system: t.system }[message.role];
  const tone =
    message.role === "user"
      ? "justify-self-end border-primary bg-primary text-primary-foreground"
      : message.role === "leader"
        ? "justify-self-start bg-muted"
        : "justify-self-center border-transparent text-xs text-muted-foreground";
  return (
    <li className={`grid max-w-[90%] gap-1 rounded-lg border px-3 py-2 ${tone}`}>
      <span className="text-xs opacity-80">{who}</span>
      {/* Thẻ artifact chỉ có tiêu đề ở đây; nội dung xem ở trang web của hub. */}
      <p className="whitespace-pre-wrap break-words">
        {message.artifact ? `${t.artifact}: ${message.artifact.title}` : message.content}
      </p>
    </li>
  );
}

/**
 * Leader chỉ đề xuất; hub mới thực hiện khi người có quyền bấm Duyệt (hub kiểm quyền). Nút Duyệt không sửa cấp độ:
 * hub dùng cấp Leader đã chọn, muốn đổi thì duyệt ở web hoặc app.
 */
function ApprovalCard({ approval, projects }: { approval: Approval; projects: readonly Project[] | undefined }) {
  const t = useText();
  const queryClient = useQueryClient();
  const reasonId = useId();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: api.leader.approvals.list.key() });
    await queryClient.invalidateQueries({ queryKey: api.leader.threads.get.key() });
  };
  const approve = useMutation({
    mutationFn: () => hub.leader.approvals.approve({ id: approval.id }),
    onSuccess: refresh,
  });
  const reject = useMutation({
    mutationFn: () => hub.leader.approvals.reject({ id: approval.id, reason: reason.trim() }),
    onSuccess: refresh,
  });
  const busy = approve.isPending || reject.isPending;
  const error = approve.error ?? reject.error;
  const pending = approval.status === "pending";
  const { action } = approval;
  const tier = "tier" in action ? action.tier : undefined;
  const tierReason = "tierReason" in action ? action.tierReason : undefined;

  return (
    <section aria-label={t.proposal} className="grid min-w-0 gap-2 rounded-lg border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={STATUS_TONE[approval.status]} small>
          {t[approval.status]}
        </Pill>
        <span className="text-xs text-muted-foreground">{t.proposal}</span>
      </div>
      <p className="break-words font-medium">{describeAction(action, projects, t)}</p>
      {tier && (
        <p className="break-words text-xs text-muted-foreground">
          {t.leaderTier}: {t.tiers[tier]}
          {tierReason ? ` · ${t.tierReason}: ${tierReason}` : ""}
        </p>
      )}
      {error && <Alert variant="destructive">{errorText(error, t.failed)}</Alert>}
      {pending &&
        (rejecting ? (
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (reason.trim()) reject.mutate();
            }}
            className="grid gap-2"
          >
            <label htmlFor={reasonId} className="text-xs font-medium">
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
            <Button onClick={() => approve.mutate()} disabled={busy}>
              {approve.isPending ? t.executing : t.approve}
            </Button>
          </div>
        ))}
    </section>
  );
}

function AssignTab({ projects, loading }: { projects: readonly Project[] | undefined; loading: boolean }) {
  const t = useText();
  const ids = { project: useId(), title: useId(), body: useId(), dispatch: useId(), hint: useId() };
  const [result, setResult] = useState<{ key: string; dispatched: boolean | null } | null>(null);
  const assign = useMutation({
    mutationFn: async (input: { projectId: string; title: string; body: string; dispatch: boolean }) => {
      const task = await hub.tasks.create({ projectId: input.projectId, title: input.title, body: input.body });
      if (!input.dispatch) return { key: task.key, dispatched: null };
      // Task đã tạo thì không mất: giao lỗi chỉ báo riêng để người dùng giao lại, không tạo trùng.
      try {
        await hub.runs.start({ taskId: task.id });
        return { key: task.key, dispatched: true };
      } catch {
        return { key: task.key, dispatched: false };
      }
    },
    onSuccess: setResult,
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const projectId = String(form.get("project") ?? "");
    const title = String(form.get("title") ?? "").trim();
    if (!projectId || !title) return;
    setResult(null);
    assign.mutate({ projectId, title, body: String(form.get("body") ?? ""), dispatch: form.get("dispatch") === "on" });
  }

  const message = result
    ? result.dispatched === null
      ? t.created
      : result.dispatched
        ? t.createdDispatched
        : t.createdNotDispatched
    : null;

  return (
    <form noValidate onSubmit={onSubmit} className="grid content-start gap-2 overflow-auto p-3">
      <h2 className="text-base font-semibold">{t.assignTitle}</h2>
      <label htmlFor={ids.project} className="text-xs font-medium">
        {t.project}
      </label>
      <NativeSelect id={ids.project} name="project" required defaultValue="">
        {/* Có dự án thì không cho giao khi chưa chọn: chuỗi rỗng bị chặn ở onSubmit. */}
        <option value="" disabled>
          {loading ? t.loading : projects?.length === 0 ? t.noProjects : t.project}
        </option>
        {projects?.map((p) => (
          <option key={p.id} value={p.id}>
            {p.key} · {p.name}
          </option>
        ))}
      </NativeSelect>
      <label htmlFor={ids.title} className="text-xs font-medium">
        {t.taskTitle}
      </label>
      <Input id={ids.title} name="title" maxLength={200} />
      <label htmlFor={ids.body} className="text-xs font-medium">
        {t.taskBody}
      </label>
      <Textarea id={ids.body} name="body" rows={6} placeholder={t.taskBodyPlaceholder} />
      <div className="flex items-start gap-2">
        <input id={ids.dispatch} name="dispatch" type="checkbox" aria-describedby={ids.hint} className="mt-1" />
        <div className="grid gap-0.5">
          <label htmlFor={ids.dispatch} className="text-sm">
            {t.dispatch}
          </label>
          <p id={ids.hint} className="text-xs text-muted-foreground">
            {t.dispatchHint}
          </p>
        </div>
      </div>
      {assign.isError && <Alert variant="destructive">{errorText(assign.error, t.failed)}</Alert>}
      {result && message && (
        <p role="status" className="text-sm">
          {fill(message, { key: result.key })}
        </p>
      )}
      <Button type="submit" disabled={assign.isPending}>
        {assign.isPending ? t.assigning : t.assign}
      </Button>
    </form>
  );
}
