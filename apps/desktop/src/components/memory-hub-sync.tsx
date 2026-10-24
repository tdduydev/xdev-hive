import { QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MEMORY_MAX_CHARS } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Markdown } from "@xdev-hive/ui/markdown";
import { UploadIcon, XIcon } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { useLinkedAccount } from "@/lib/account.ts";
import { api, queryClient } from "@/lib/hub-query.tsx";
import { type Dict, useT } from "@/lib/i18n.ts";
import {
  OUTBOX_KEY,
  OUTBOX_REFRESH_MS,
  type OutboxItem,
  onOutboxChanged,
  outboxDrop,
  outboxStatus,
  rejectedItems,
  submitMemory,
  waitingItems,
} from "@/lib/outbox.ts";
import { errorText } from "@/lib/tauri.ts";

/** Một đoạn memory trên máy mà người dùng có thể gửi lên hub. */
export interface LocalMemoryItem {
  /** Khoá ổn định trong danh sách, thường là đường dẫn file. */
  id: string;
  /** Tên hiển thị, thường là tên file. */
  label: string;
  content: string;
}

const text: Dict<{
  title: string;
  lead: string;
  brief: string;
  noBrief: string;
  memory: string;
  none: string;
  loading: string;
  noProject: string;
  local: string;
  send: string;
  queued: string;
  sent: string;
  rejected: (reason: string) => string;
  expired: string;
  held: string;
  tooLong: (max: number) => string;
  waitingTitle: string;
  waiting: (n: number) => string;
  failedTitle: string;
  drop: string;
  noReason: string;
  outboxKinds: Record<string, string>;
  kinds: Record<"decision" | "convention" | "gotcha" | "note", string>;
}> = {
  vi: {
    title: "Hub",
    lead: "Brief và memory của dự án trên hub, chỉ đọc. Gửi lên hub thì memory của máy vào hàng chờ duyệt, chưa ai dùng cho tới khi người trong đội duyệt.",
    brief: "Brief dự án",
    noBrief: "Dự án chưa có brief.",
    memory: "Memory đã duyệt",
    none: "Chưa có memory.",
    loading: "Đang tải…",
    noProject: "Dự án này chưa có trên hub, nên chưa gửi được.",
    local: "Memory trên máy",
    send: "Gửi lên hub",
    queued: "Đã xếp hàng, sẽ gửi khi có mạng.",
    sent: "Đã gửi, đang chờ người trong đội duyệt.",
    rejected: (reason) => `Hub không nhận: ${reason}`,
    expired: "Quá hạn chưa gửi được, hãy gửi lại.",
    held: "Đang giữ trên máy; mở Hộp thư đi để xem lý do và gửi lại.",
    tooLong: (max) => `Dài quá ${max} ký tự, hãy chia nhỏ hoặc nén trước khi gửi.`,
    waitingTitle: "Đang chờ gửi",
    waiting: (n) => `${n} việc đang chờ gửi lên hub, sẽ gửi khi có mạng.`,
    failedTitle: "Hub không nhận",
    drop: "Bỏ",
    noReason: "Hub không nêu lý do.",
    outboxKinds: {
      "memory.propose": "Đề xuất memory",
      "memory.write": "Đề xuất memory",
      "project.token_usage": "Số liệu token của dự án",
      "machine.token_score": "Điểm token của máy",
    },
    kinds: { decision: "Quyết định", convention: "Quy ước", gotcha: "Lưu ý", note: "Ghi chú" },
  },
  en: {
    title: "Hub",
    lead: "The project's brief and memory on the hub, read-only. Sent memory goes to the approval queue and is not used until someone on the team approves it.",
    brief: "Project brief",
    noBrief: "This project has no brief yet.",
    memory: "Approved memory",
    none: "No memory yet.",
    loading: "Loading…",
    noProject: "This project is not on the hub, so nothing can be sent.",
    local: "Memory on this machine",
    send: "Send to hub",
    queued: "Queued, will be sent when the network is back.",
    sent: "Sent, waiting for a teammate to approve.",
    rejected: (reason) => `The hub did not accept it: ${reason}`,
    expired: "Expired before it could be sent, send it again.",
    held: "Held on this machine; open Outbox to see why and retry.",
    tooLong: (max) => `Over ${max} characters: split or compress it before sending.`,
    waitingTitle: "Waiting to send",
    waiting: (n) =>
      `${n} ${n === 1 ? "item is" : "items are"} waiting to go to the hub, will be sent when the network is back.`,
    failedTitle: "Not accepted by the hub",
    drop: "Dismiss",
    noReason: "The hub gave no reason.",
    outboxKinds: {
      "memory.propose": "Memory proposal",
      "memory.write": "Memory proposal",
      "project.token_usage": "Project token usage",
      "machine.token_score": "Machine token score",
    },
    kinds: { decision: "Decision", convention: "Convention", gotcha: "Gotcha", note: "Note" },
  },
};

/**
 * Mục "Hub" của màn Memory (specs/015 US6). Chưa liên kết tài khoản thì không vẽ gì: app vẫn dùng đủ trên máy, mục
 * này chỉ thêm đường sang hub. Gửi lên đi qua hộp thư đi của worker (`memory.propose`, spec 029 T024): mất mạng thì
 * việc nằm lại trên máy và tự gửi sau; hub luôn đặt chờ duyệt.
 */
/**
 * Đọc brief, memory của dự án trên hub và gửi memory máy lên hub. Màn Bộ nhớ chỉ biết id dự án đã gắn với thư mục
 * (projects.json), nên nhận `projectId` thay cho `projectKey` và tự tra key.
 */
export function MemoryHubSync({
  projectKey,
  projectId,
  items = [],
}: {
  projectKey?: string | undefined;
  projectId?: string | undefined;
  items?: LocalMemoryItem[];
}) {
  const account = useLinkedAccount();
  if (!account) return null;
  return (
    <QueryClientProvider client={queryClient}>
      <HubSection projectKey={projectKey} boundId={projectId} items={items} />
    </QueryClientProvider>
  );
}

function HubSection({
  projectKey: givenKey,
  boundId,
  items,
}: {
  projectKey: string | undefined;
  boundId: string | undefined;
  items: LocalMemoryItem[];
}) {
  const t = useT(text);
  // `memory.write` nhận id dự án, brief và memory nhận key: tra chiều còn thiếu từ danh sách dự án mình thấy.
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const projectKey = givenKey ?? projects.data?.find((p) => p.id === boundId)?.key ?? "";
  const projectId = boundId ?? projects.data?.find((p) => p.key === projectKey)?.id;
  const brief = useQuery({
    ...api.briefs.get.queryOptions({ input: { project: projectKey } }),
    enabled: projectKey !== "",
  });
  const memories = useQuery({
    ...api.memory.list.queryOptions({ input: { project: projectKey } }),
    enabled: projectKey !== "",
  });
  const error = brief.error ?? memories.error ?? projects.error;
  const qc = useQueryClient();
  // Worker sở hữu lượt gửi; giao diện chỉ làm mới khi nhận sự kiện của hàng đợi.
  useEffect(() => {
    return onOutboxChanged(() => void qc.invalidateQueries({ queryKey: OUTBOX_KEY }));
  }, [qc]);

  return (
    <section aria-label={t.title} className="flex flex-col gap-4">
      <div>
        <h2 className="text-sm font-semibold">{t.title}</h2>
        <p className="text-sm text-muted-foreground">{t.lead}</p>
      </div>
      {error && <Alert variant="destructive">{errorText(error)}</Alert>}
      <OutboxBlocks />
      <Block title={t.brief}>
        {brief.isPending ? (
          <p className="text-sm text-muted-foreground">{t.loading}</p>
        ) : brief.data ? (
          <Markdown content={brief.data.content} links="text" />
        ) : (
          <p className="text-sm text-muted-foreground">{t.noBrief}</p>
        )}
      </Block>
      <Block title={t.memory}>
        {memories.isPending ? (
          <p className="text-sm text-muted-foreground">{t.loading}</p>
        ) : memories.data?.length ? (
          <ul className="m-0 flex list-none flex-col divide-y p-0">
            {memories.data.map((m) => (
              <li key={m.id} className="flex flex-col gap-1 py-2 text-sm">
                <span className="text-xs font-medium text-muted-foreground">{t.kinds[m.kind]}</span>
                <span className="whitespace-pre-wrap">{m.content}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t.none}</p>
        )}
      </Block>
      {items.length > 0 && (
        <Block title={t.local}>
          {!projects.isPending && !projectId && <Alert>{t.noProject}</Alert>}
          <ul className="m-0 flex list-none flex-col divide-y p-0">
            {items.map((item) => (
              <SendRow key={item.id} item={item} projectKey={projectKey} projectId={projectId} />
            ))}
          </ul>
        </Block>
      )}
    </section>
  );
}

function SendRow({
  item,
  projectKey,
  projectId,
}: {
  item: LocalMemoryItem;
  projectKey: string;
  projectId: string | undefined;
}) {
  const t = useT(text);
  const qc = useQueryClient();
  const content = item.content.trim();
  const tooLong = content.length > MEMORY_MAX_CHARS;
  const send = useMutation({
    mutationFn: () => submitMemory({ projectId: projectId ?? "", kind: "note", content }),
    // Đề xuất vừa gửi nằm ở hàng chờ duyệt, không ở danh sách đã duyệt; làm mới hàng đợi của máy và danh sách để thấy đúng.
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: OUTBOX_KEY }),
        qc.invalidateQueries({ queryKey: api.memory.list.key({ input: { project: projectKey } }) }),
      ]),
  });
  const state = send.data?.state;

  return (
    <li className="flex flex-col gap-1 py-2 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-xs">{item.label}</span>
        <Button
          size="sm"
          variant="outline"
          disabled={!projectId || !content || tooLong || send.isPending || send.isSuccess}
          onClick={() => send.mutate()}
        >
          <UploadIcon aria-hidden="true" />
          {t.send}
        </Button>
      </div>
      {tooLong && <p className="text-xs text-muted-foreground">{t.tooLong(MEMORY_MAX_CHARS)}</p>}
      {send.isSuccess && (
        <p className="text-xs text-muted-foreground">
          {state === "accepted" || state === "duplicate"
            ? t.sent
            : state === "rejected"
              ? t.rejected(send.data?.result?.reason || t.noReason)
              : state === "expired"
                ? t.expired
                : state === "held"
                  ? t.held
                  : t.queued}
        </p>
      )}
      {send.error && <Alert variant="destructive">{errorText(send.error)}</Alert>}
    </li>
  );
}

/**
 * "Đang chờ gửi" và việc hub không nhận, đọc từ hàng đợi của worker. Không có việc nào thì không vẽ gì. Lỗi đọc hàng
 * đợi (ví dụ máy chưa đăng ký) cũng im: đây là thông tin phụ, không chặn việc đọc brief và memory.
 */
function OutboxBlocks() {
  const t = useT(text);
  const qc = useQueryClient();
  const status = useQuery({ queryKey: OUTBOX_KEY, queryFn: outboxStatus, refetchInterval: OUTBOX_REFRESH_MS });
  const drop = useMutation({
    mutationFn: outboxDrop,
    onSuccess: () => qc.invalidateQueries({ queryKey: OUTBOX_KEY }),
  });
  if (!status.data) return null;
  const waiting = waitingItems(status.data);
  const failed = rejectedItems(status.data);
  const label = (item: OutboxItem) => t.outboxKinds[item.kind] ?? item.kind;
  return (
    <>
      {waiting.length > 0 && (
        <Block title={t.waitingTitle}>
          <p role="status" className="text-sm">
            {t.waiting(waiting.length)}
          </p>
          <ul className="m-0 flex list-none flex-col p-0 text-xs text-muted-foreground">
            {waiting.map((item) => (
              <li key={item.key}>{label(item)}</li>
            ))}
          </ul>
        </Block>
      )}
      {failed.length > 0 && (
        <Block title={t.failedTitle}>
          <ul className="m-0 flex list-none flex-col divide-y p-0">
            {failed.map((item) => (
              <li key={item.key} className="flex items-start justify-between gap-2 py-2 text-sm">
                <span className="flex flex-col gap-0.5">
                  <span className="text-xs font-medium text-muted-foreground">{label(item)}</span>
                  <span>
                    {item.state === "expired"
                      ? t.expired
                      : item.reason || (item.state === "held" ? t.held : t.noReason)}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={drop.isPending}
                  aria-label={`${t.drop}: ${label(item)}`}
                  onClick={() => drop.mutate(item.key)}
                >
                  <XIcon aria-hidden="true" />
                  {t.drop}
                </Button>
              </li>
            ))}
          </ul>
        </Block>
      )}
    </>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{title}</h3>
      <div className="rounded-xl border bg-card px-4 py-2 text-card-foreground">{children}</div>
    </section>
  );
}
