import { QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArtifactCard, ArtifactPanel, type ArtifactRef, type ArtifactSelection } from "@xdev-hive/artifacts-ui";
import type { ChatMessage, Project } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Input } from "@xdev-hive/ui/input";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Textarea } from "@xdev-hive/ui/textarea";
import { LayersIcon, SquarePenIcon } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { ApprovalCard } from "@/components/approval-card.tsx";
import { DesktopArtifacts, useArtifactsProbe } from "@/lib/artifacts-env.tsx";
import { api, queryClient } from "@/lib/hub-query.tsx";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { awaitingLeader, formatDayTime } from "@/lib/leader.ts";
import { screenParam } from "@/lib/nav.ts";
import { errorText } from "@/lib/tauri.ts";
import { cn } from "@/lib/utils.ts";

const text: Dict<Record<string, string>> = {
  vi: {
    threads: "Cuộc trò chuyện",
    search: "Tìm cuộc trò chuyện",
    noMatches: "Không có cuộc trò chuyện phù hợp.",
    newThread: "Cuộc trò chuyện mới",
    newPlaceholder: "Ví dụ: chia việc cho tính năng thanh toán",
    project: "Dự án",
    wholeOrg: "Cả tổ chức",
    create: "Tạo",
    creating: "Đang tạo…",
    emptyTitle: "Chưa có cuộc trò chuyện nào",
    emptyDescription: "Tạo cuộc trò chuyện để hỏi Leader về dự án, nhờ chia việc hoặc giao việc cho agent.",
    scope: "Leader của tổ chức",
    messages: "Tin nhắn",
    you: "Bạn",
    system: "Hệ thống",
    typing: "Leader đang trả lời…",
    composerLabel: "Nhắn cho Leader",
    composerPlaceholder: "Hỏi về dự án, nhờ chia việc, hoặc nhờ giao việc cho agent",
    enterHint: "Enter để gửi · Shift+Enter xuống dòng",
    send: "Gửi",
    sending: "Đang gửi…",
    artifacts: "Artifact của cuộc trò chuyện",
    loading: "Đang tải…",
    offline: "Đang offline: Leader cần hub. Artifact đã mở trên máy này vẫn đọc được ở màn Artifact.",
    openArtifacts: "Mở màn Artifact",
  },
  en: {
    threads: "Conversations",
    search: "Search conversations",
    noMatches: "No matching conversations.",
    newThread: "New conversation",
    newPlaceholder: "e.g. split the payments feature into tasks",
    project: "Project",
    wholeOrg: "Whole organization",
    create: "Create",
    creating: "Creating…",
    emptyTitle: "No conversations yet",
    emptyDescription: "Create a conversation to ask about a project, split work or assign tasks to agents.",
    scope: "organization leader",
    messages: "Messages",
    you: "You",
    system: "System",
    typing: "Leader is replying…",
    composerLabel: "Message the leader",
    composerPlaceholder: "Ask about a project, split work, or have the leader assign tasks to agents",
    enterHint: "Enter to send · Shift+Enter for a new line",
    send: "Send",
    sending: "Sending…",
    artifacts: "Conversation artifacts",
    loading: "Loading…",
    offline:
      "Offline: the leader needs the hub. Artifacts already opened on this machine stay readable on the Artifacts screen.",
    openArtifacts: "Open Artifacts",
  },
};

/** Từ 1024 px chat và khung chia đôi (FR-042); hẹp hơn thì khung thay chỗ chat, có nút quay lại. */
const WIDE = "(min-width: 1024px)";

function useWide(): boolean {
  // jsdom không có matchMedia: coi là màn rộng.
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia?.(WIDE);
      mql?.addEventListener("change", onChange);
      return () => mql?.removeEventListener("change", onChange);
    },
    () => window.matchMedia?.(WIDE).matches ?? true,
    () => true,
  );
}

function subscribe(listener: () => void) {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

const keyOf = (ref: ArtifactSelection) => `${ref.id}@${ref.version}`;

/** Thẻ artifact theo thứ tự tin nhắn; thẻ của artifact đã xoá không mở được nên không thành tab. */
export function chatArtifacts(messages: readonly ChatMessage[]): ArtifactRef[] {
  return messages.flatMap((m) =>
    m.artifact && !m.artifact.deleted
      ? [{ id: m.artifact.id, version: m.artifact.version, title: m.artifact.title, type: m.artifact.type }]
      : [],
  );
}

/**
 * Khung bên cạnh của một cuộc trò chuyện. Khi khung đang đóng thì `ArtifactPanel` không có mặt nên không tự chuyển thẻ;
 * thẻ đến sau lúc tải do đây mở khung (US1-2). Thẻ đã có lúc tải cuộc trò chuyện không phải "mới".
 */
function useThreadPanel(messages: readonly ChatMessage[] | undefined) {
  const [open, setOpen] = useState(true);
  const [selection, setSelection] = useState<ArtifactSelection | null>(null);
  const items = chatArtifacts(messages ?? []);
  const visible = items.length > 0 && open;
  const seen = useRef<Set<string> | null>(null);
  const live = useRef({ visible });
  live.current = { visible };
  const itemsKey = items.map(keyOf).join(",");
  const loaded = messages !== undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `itemsKey` đại diện cho `items` (mảng mới mỗi lần vẽ).
  useEffect(() => {
    if (!loaded) return;
    if (!seen.current) {
      seen.current = new Set(items.map(keyOf));
      return;
    }
    const known = seen.current;
    const fresh = items.filter((item) => !known.has(keyOf(item)));
    for (const item of fresh) known.add(keyOf(item));
    const newest = fresh.at(-1);
    if (newest && !live.current.visible) {
      setSelection({ id: newest.id, version: newest.version });
      setOpen(true);
    }
  }, [itemsKey, loaded]);
  const show = useCallback((ref?: ArtifactSelection) => {
    if (ref) setSelection(ref);
    setOpen(true);
  }, []);
  return { items, selection, visible, show, select: setSelection, close: () => setOpen(false) };
}

/**
 * Màn Leader của app (spec 012 T041, plan D18): danh sách cuộc trò chuyện, chat, đề xuất chờ duyệt và khung artifact
 * bên cạnh. Leader là một run trên hub nên cần kết nối; mất hub thì chỉ còn lời chỉ sang màn Artifact (đọc từ bộ đệm).
 * `#/leader/<threadId>` mở thẳng một cuộc trò chuyện (đích sau "Nhờ Leader sửa").
 */
export function LeaderScreen() {
  return (
    <QueryClientProvider client={queryClient}>
      <LeaderBody />
    </QueryClientProvider>
  );
}

function LeaderBody() {
  const t = useT(text);
  const lang = useLang();
  const probe = useArtifactsProbe();
  const param = useSyncExternalStore(subscribe, () => screenParam(location.hash));
  const threads = useQuery({ ...api.leader.threads.list.queryOptions({ input: {} }), enabled: probe.reachable });
  const projects = useQuery({ ...api.projects.list.queryOptions({ input: {} }), enabled: probe.reachable });
  const [filter, setFilter] = useState("");
  const [showNew, setShowNew] = useState(false);
  const selected = param || threads.data?.[0]?.id;
  const open = (id: string) => location.replace(`#/leader/${encodeURIComponent(id)}`);
  const needle = filter.trim().toLocaleLowerCase(lang);
  const shown = threads.data?.filter((thread) => thread.title.toLocaleLowerCase(lang).includes(needle));

  if (!probe.reachable)
    return (
      <div className="flex flex-1 flex-col items-start gap-3 p-5">
        <p role="status" className="rounded-md bg-warning-soft p-3 text-sm text-warning">
          {t.offline}
        </p>
        <a href="#/artifacts" className="text-sm text-primary hover:underline">
          {t.openArtifacts}
        </a>
      </div>
    );

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <aside className="flex w-64 shrink-0 flex-col gap-3 overflow-auto border-r p-3">
        <div className="flex items-center justify-between">
          <h2 className="font-heading text-sm font-semibold">{t.threads}</h2>
          <Button
            variant="outline"
            size="icon"
            aria-label={t.newThread}
            aria-expanded={showNew || threads.data?.length === 0}
            onClick={() => setShowNew((value) => !value)}
          >
            <SquarePenIcon aria-hidden="true" />
          </Button>
        </div>
        {(showNew || threads.data?.length === 0) && (
          <NewThread
            projects={projects.data}
            onCreated={(id) => {
              setShowNew(false);
              open(id);
            }}
          />
        )}
        <Input
          aria-label={t.search}
          placeholder={t.search}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {threads.isPending && (
          <p role="status" className="text-xs text-muted-foreground">
            {t.loading}
          </p>
        )}
        {threads.isError && <Alert variant="destructive">{errorText(threads.error)}</Alert>}
        <nav aria-label={t.threads} className="grid gap-1">
          {shown?.map((thread) => (
            <button
              key={thread.id}
              type="button"
              aria-current={thread.id === selected ? "page" : undefined}
              onClick={() => open(thread.id)}
              className={cn(
                "grid min-w-0 cursor-pointer rounded-md px-3 py-2 text-left text-xs transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                thread.id === selected ? "bg-accent text-accent-foreground" : "hover:bg-muted",
              )}
            >
              <span className="truncate font-medium">{thread.title}</span>
              <span className="text-muted-foreground">
                {projects.data?.find((p) => p.id === thread.projectId)?.key ?? t.wholeOrg} ·{" "}
                {formatDayTime(thread.updatedAt, lang)}
              </span>
            </button>
          ))}
        </nav>
        {filter && shown?.length === 0 && <p className="text-sm text-muted-foreground">{t.noMatches}</p>}
      </aside>
      {selected ? (
        <DesktopArtifacts key={selected} threadId={selected}>
          <Thread threadId={selected} projects={projects.data} />
        </DesktopArtifacts>
      ) : (
        !threads.isPending && (
          <div className="flex-1 p-5">
            <h2 className="font-heading text-base font-semibold">{t.emptyTitle}</h2>
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
  const t = useT(text);
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
    create.mutate({ title, projectId: String(form.get("project") ?? "") || null });
    e.currentTarget.reset();
  }
  return (
    <form noValidate onSubmit={onSubmit} className="grid gap-2.5 rounded-xl border p-3">
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
      {create.isError && <Alert variant="destructive">{errorText(create.error)}</Alert>}
      <Button type="submit" disabled={create.isPending}>
        {create.isPending ? t.creating : t.create}
      </Button>
    </form>
  );
}

function Thread({ threadId, projects }: { threadId: string; projects: readonly Project[] | undefined }) {
  const t = useT(text);
  const wide = useWide();
  const queryClient = useQueryClient();
  const composer = useId();
  const [draft, setDraft] = useState("");
  const thread = useQuery({
    ...api.leader.threads.get.queryOptions({ input: { id: threadId } }),
    // Leader trả lời bằng một run trên máy: hỏi lại hub tới khi có tin trả lời. Thẻ artifact do run thêm giữa lượt chưa
    // phải câu trả lời nên vẫn hỏi tiếp; 2 giây để thẻ mới hiện và khung mở sớm (SC-003).
    refetchInterval: (q) =>
      awaitingLeader(q.state.data?.messages) || q.state.data?.messages.at(-1)?.artifact ? 2000 : false,
  });
  const approvals = useQuery({
    ...api.leader.approvals.list.queryOptions({ input: { status: "pending", threadId } }),
    refetchInterval: 10_000,
  });
  const panel = useThreadPanel(thread.data?.messages);
  const send = useMutation({
    mutationFn: (content: string) => api.leader.threads.send.call({ id: threadId, content }),
    onSuccess: async () => {
      setDraft("");
      await queryClient.invalidateQueries({ queryKey: api.leader.threads.get.key() });
    },
  });

  if (thread.isPending)
    return (
      <p role="status" className="flex-1 p-5 text-muted-foreground">
        {t.loading}
      </p>
    );
  if (thread.isError)
    return (
      <Alert variant="destructive" className="m-5 flex-1">
        {errorText(thread.error)}
      </Alert>
    );
  const pending = approvals.data?.filter((a) => a.threadId === threadId) ?? [];
  const waiting = awaitingLeader(thread.data.messages) || send.isPending;
  const submit = () => {
    const content = draft.trim();
    if (content && !waiting) send.mutate(content);
  };

  const chat = (
    <section aria-label={thread.data.thread.title} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex flex-wrap items-start gap-2 border-b px-4 py-3">
        <div className="grid min-w-0 flex-1 gap-1">
          <h2 className="break-words text-base font-semibold">{thread.data.thread.title}</h2>
          <p className="text-xs text-muted-foreground">
            {projects?.find((p) => p.id === thread.data.thread.projectId)?.key ?? t.wholeOrg} · {t.scope}
          </p>
        </div>
        {panel.items.length > 0 && !panel.visible && (
          <Button variant="outline" size="sm" onClick={() => panel.show()}>
            <LayersIcon aria-hidden="true" />
            {t.artifacts} ({new Set(panel.items.map((item) => item.id)).size})
          </Button>
        )}
      </header>
      <div className="grid min-h-0 flex-1 content-start gap-4 overflow-auto p-4">
        <ol aria-label={t.messages} className="m-0 grid list-none gap-2.5 p-0">
          {thread.data.messages.map((m) => (
            <Message key={m.id} message={m} selected={panel.visible ? panel.selection : null} onOpen={panel.show} />
          ))}
        </ol>
        {waiting && (
          <p role="status" className="text-xs text-muted-foreground">
            {t.typing}
          </p>
        )}
        {approvals.isError && <Alert variant="destructive">{errorText(approvals.error)}</Alert>}
        {pending.map((a) => (
          <ApprovalCard key={a.id} approval={a} projects={projects} />
        ))}
      </div>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="grid gap-2 border-t p-4"
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
        {send.isError && <Alert variant="destructive">{errorText(send.error)}</Alert>}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="mr-auto text-xs text-muted-foreground">{t.enterHint}</span>
          <Button type="submit" disabled={waiting || !draft.trim()}>
            {send.isPending ? t.sending : t.send}
          </Button>
        </div>
      </form>
    </section>
  );

  if (!panel.visible) return chat;
  const side = (
    <ArtifactPanel
      items={panel.items}
      value={panel.selection}
      onValueChange={panel.select}
      {...(wide ? { onClose: panel.close } : { onBack: panel.close })}
      className="h-full min-w-0 flex-1"
    />
  );
  // Màn hẹp: khung thay chỗ chat (không có ngăn kéo như web), "Về cuộc trò chuyện" đưa chat trở lại.
  if (!wide) return <div className="flex min-h-0 min-w-0 flex-1 flex-col">{side}</div>;
  return (
    <>
      {chat}
      <div className={cn("flex min-h-0 w-[45%] min-w-0 shrink-0 flex-col border-l")}>{side}</div>
    </>
  );
}

function Message({
  message,
  selected,
  onOpen,
}: {
  message: ChatMessage;
  selected: ArtifactSelection | null;
  onOpen: (ref: ArtifactSelection) => void;
}) {
  const t = useT(text);
  const lang = useLang();
  const ref = message.artifact;
  if (ref)
    return (
      // Thẻ thay chữ (D10): nội dung artifact chỉ mở trong khung, không đổ vào dòng chat.
      <li className="grid max-w-full min-w-0 justify-self-start gap-1 sm:max-w-[80%]">
        <span className="text-xs text-muted-foreground">Leader · {formatDayTime(message.createdAt, lang)}</span>
        <ArtifactCard
          artifact={ref.deleted ? null : ref}
          selected={selected?.id === ref.id && selected.version === ref.version}
          onOpen={(open) => onOpen({ id: open.id, version: open.version })}
        />
      </li>
    );
  return (
    <li
      className={cn(
        "grid max-w-full gap-1 rounded-xl border px-3.5 py-2.5 sm:max-w-[80%]",
        message.role === "user" && "justify-self-end border-primary bg-primary text-primary-foreground",
        message.role === "leader" && "justify-self-start bg-muted",
        message.role === "system" && "justify-self-center border-transparent text-xs text-muted-foreground",
      )}
    >
      <span className={cn("text-xs", message.role !== "user" && "text-muted-foreground")}>
        {{ user: t.you, leader: "Leader", system: t.system }[message.role]} · {formatDayTime(message.createdAt, lang)}
      </span>
      <p className="whitespace-pre-wrap break-words">{message.content}</p>
    </li>
  );
}
