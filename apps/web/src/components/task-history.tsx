import { useQuery } from "@tanstack/react-query";
import type { ClientSource, TaskHistoryItem } from "@xdev-hive/contracts";
import { Pill } from "@xdev-hive/ui/pill";
import { useId } from "react";
import { Card } from "@/components/ui/card.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { formatDayTime } from "@/lib/format.ts";
import { RUN_STATE_LABEL } from "@/lib/run-view.ts";
import { useOrg } from "@/shell/org-context.ts";

const SOURCE_LABEL: Record<ClientSource, string> = {
  "worker-run": "Worker (run)",
  worker: "Worker",
  desktop: "App desktop",
  "hive-cli": "Lệnh hive",
  "mcp-local": "MCP tại máy",
  vscode: "VS Code",
  web: "Web",
  unknown: "Không rõ",
};

/** Tên công cụ MCP hay thủ tục oRPC có ghi; loại chưa có nhãn thì hiện tên gốc. */
const KIND_LABEL: Record<string, string> = {
  task_update: "Cập nhật tiến độ",
  review_submit: "Gửi kết quả review",
  plan_submit: "Gửi kế hoạch",
  artifact_create: "Tạo artifact",
  artifact_update: "Sửa artifact",
  memory_write: "Ghi memory",
  "memory.write": "Ghi memory",
};

function kindLabel(kind: string): string {
  if (kind.startsWith("run.")) {
    const state = kind.slice(4);
    return `Run: ${RUN_STATE_LABEL[state as keyof typeof RUN_STATE_LABEL] ?? state}`;
  }
  return KIND_LABEL[kind] ?? kind;
}

/**
 * Khung Lịch sử của task (specs/027 FR-006): ai ghi, từ nguồn và máy nào, giờ client tạo và giờ hub nhận. Lần ghi gửi
 * lại từ hộp thư đi có giờ tạo sớm hơn giờ nhận nhiều; hiện cả hai để người xem hiểu vì sao thứ tự khác lúc làm.
 */
export function TaskHistory({ taskId }: { taskId: string }) {
  const { api } = useOrg();
  const headingId = useId();
  const history = useQuery(api.tasks.history.queryOptions({ input: { id: taskId } }));
  return (
    <Card>
      <section aria-labelledby={headingId} className="grid gap-2.5 px-5 py-4">
        <h2 id={headingId} className="text-base font-semibold text-foreground">
          Lịch sử
        </h2>
        {history.isPending ? (
          <p aria-busy="true" className="text-muted-foreground">
            Đang tải…
          </p>
        ) : history.isError ? (
          <p className="text-destructive">{apiErrorMessage(history.error)}</p>
        ) : history.data.length === 0 ? (
          <p className="text-muted-foreground">Chưa có lần ghi nào.</p>
        ) : (
          <ol className="grid gap-2 text-sm">
            {history.data.map((item, i) => (
              // Không có id riêng: hai lần ghi cùng giờ nhận và cùng loại vẫn khác vị trí.
              // biome-ignore lint/suspicious/noArrayIndexKey: danh sách chỉ đọc, không sắp lại.
              <HistoryRow key={i} item={item} />
            ))}
          </ol>
        )}
      </section>
    </Card>
  );
}

function HistoryRow({ item }: { item: TaskHistoryItem }) {
  const rejected = item.outcome === "rejected";
  return (
    <li className="grid gap-0.5 border-b border-border pb-2 last:border-b-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-foreground">{kindLabel(item.kind)}</span>
        {rejected && <Pill tone="bad">Bị từ chối</Pill>}
      </div>
      <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        <span>Nguồn: {SOURCE_LABEL[item.source]}</span>
        {item.machine && <span>Máy: {item.machine.name}</span>}
        {item.actor && <span>Người: {item.actor.name}</span>}
        {item.clientCreatedAt && (
          <span>
            Tạo lúc <time dateTime={item.clientCreatedAt}>{formatDayTime(item.clientCreatedAt)}</time>
          </span>
        )}
        <span>
          Hub nhận <time dateTime={item.at}>{formatDayTime(item.at)}</time>
        </span>
      </p>
      {rejected && (
        <p className="text-xs text-destructive">
          Lý do: {item.reason ?? item.reasonCode ?? "Hub không nhận lần ghi này."}
          {item.reasonCode && item.reason && <span className="font-mono"> ({item.reasonCode})</span>}
        </p>
      )}
    </li>
  );
}
