import { QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MEMORY_MAX_CHARS } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Markdown } from "@xdev-hive/ui/markdown";
import { UploadIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useLinkedAccount } from "@/lib/account.ts";
import { api, queryClient } from "@/lib/hub-query.tsx";
import { type Dict, useT } from "@/lib/i18n.ts";
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
  sent: string;
  tooLong: (max: number) => string;
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
    sent: "Đã gửi, đang chờ người trong đội duyệt.",
    tooLong: (max) => `Dài quá ${max} ký tự, hãy chia nhỏ hoặc nén trước khi gửi.`,
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
    sent: "Sent, waiting for a teammate to approve.",
    tooLong: (max) => `Over ${max} characters: split or compress it before sending.`,
    kinds: { decision: "Decision", convention: "Convention", gotcha: "Gotcha", note: "Note" },
  },
};

/**
 * Mục "Hub" của màn Memory (specs/015 US6). Chưa liên kết tài khoản thì không vẽ gì: app vẫn dùng đủ trên máy, mục
 * này chỉ thêm đường sang hub. Gửi lên là `memory.write` với `source: "machine"`, hub luôn đặt chờ duyệt.
 */
export function MemoryHubSync({ projectKey, items = [] }: { projectKey: string; items?: LocalMemoryItem[] }) {
  const account = useLinkedAccount();
  if (!account) return null;
  return (
    <QueryClientProvider client={queryClient}>
      <HubSection projectKey={projectKey} items={items} />
    </QueryClientProvider>
  );
}

function HubSection({ projectKey, items }: { projectKey: string; items: LocalMemoryItem[] }) {
  const t = useT(text);
  const brief = useQuery(api.briefs.get.queryOptions({ input: { project: projectKey } }));
  const memories = useQuery(api.memory.list.queryOptions({ input: { project: projectKey } }));
  // `memory.write` nhận id dự án chứ không nhận key, nên tra id từ danh sách dự án mình thấy.
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const projectId = projects.data?.find((p) => p.key === projectKey)?.id;
  const error = brief.error ?? memories.error ?? projects.error;

  return (
    <section aria-label={t.title} className="flex flex-col gap-4">
      <div>
        <h2 className="text-sm font-semibold">{t.title}</h2>
        <p className="text-sm text-muted-foreground">{t.lead}</p>
      </div>
      {error && <Alert variant="destructive">{errorText(error)}</Alert>}
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
    mutationFn: () =>
      api.memory.write.call({
        scope: { level: "project", projectId: projectId ?? "" },
        kind: "note",
        content,
        source: "machine",
      }),
    // Đề xuất vừa gửi nằm ở hàng chờ, không ở danh sách đã duyệt; làm mới để người dùng thấy hub vẫn không đổi.
    onSuccess: () => qc.invalidateQueries({ queryKey: api.memory.list.key({ input: { project: projectKey } }) }),
  });

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
      {send.isSuccess && <p className="text-xs text-muted-foreground">{t.sent}</p>}
      {send.error && <Alert variant="destructive">{errorText(send.error)}</Alert>}
    </li>
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
