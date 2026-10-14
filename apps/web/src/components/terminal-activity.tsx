import { useQuery } from "@tanstack/react-query";
import type { Approval, Project, TerminalAction, TerminalSession } from "@xdev-hive/contracts";
import { Pill } from "@xdev-hive/ui/pill";
import { ApprovalCard } from "@/components/approval-card.tsx";
import { LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { formatClock } from "@/lib/format.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { isLive, MODEL_LABEL, tierLabel } from "@/lib/terminal.ts";
import { useOrg } from "@/shell/org-context.ts";

const text: Dict<
  Record<
    | "proposals"
    | "proposalsEmpty"
    | "proposalsHint"
    | "actions"
    | "actionsEmpty"
    | "actionsHint"
    | "success"
    | "error"
    | "tier"
    | "model"
    | "reason",
    string
  >
> = {
  vi: {
    proposals: "Đề xuất của phiên",
    proposalsEmpty: "Leader chưa đề xuất gì. Đề xuất mới hiện ở đây để bạn duyệt ngay.",
    proposalsHint: "Sửa cấp độ rồi duyệt; hub chọn model theo cấp đã duyệt.",
    actions: "Nhật ký hành động",
    actionsEmpty: "Leader chưa gọi tool hub nào trong phiên này.",
    actionsHint: "Bypass: Leader gọi tool hub thẳng bằng quyền của người mở, không qua duyệt.",
    success: "Thành công",
    error: "Lỗi",
    tier: "Cấp độ",
    model: "Model",
    reason: "Lý do",
  },
  en: {
    proposals: "Session proposals",
    proposalsEmpty: "The leader has not proposed anything. New proposals show up here for you to approve.",
    proposalsHint: "Adjust the tier, then approve; the hub picks the model from the approved tier.",
    actions: "Action log",
    actionsEmpty: "The leader has not called any hub tool in this session.",
    actionsHint: "Bypass: the leader calls hub tools directly with the opener's permissions, no approval.",
    success: "Success",
    error: "Error",
    tier: "Tier",
    model: "Model",
    reason: "Reason",
  },
};

/** Số đề xuất đang chờ duyệt, cho nhãn nút mở khung ở màn hẹp. */
export const pendingCount = (proposals: readonly Approval[] | undefined): number =>
  proposals?.filter((p) => p.status === "pending").length ?? 0;

/** Một truy vấn dùng chung cho khung và nhãn nút của màn hẹp: react-query gộp hai chỗ dùng thành một request. */
export function useTerminalActivity(session: Pick<TerminalSession, "id" | "state">) {
  const { api } = useOrg();
  return useQuery({
    ...api.terminal.activity.queryOptions({ input: { id: session.id } }),
    refetchInterval: isLive(session) ? 5000 : false,
  });
}

/**
 * Khung bên phải của trang phiên: chế độ Đề xuất hiện đề xuất của phiên (duyệt ngay tại đây), chế độ Bypass hiện nhật
 * ký tool hub mà Leader đã gọi. Trang tải lại khi nhận khung WebSocket `activity` và hỏi định kỳ khi phiên còn chạy.
 */
export function TerminalActivity({
  session,
  projects,
  id,
}: {
  session: TerminalSession;
  projects: readonly Project[] | undefined;
  /** id của khung, để nút mở khung ở màn hẹp trỏ `aria-controls`. */
  id: string;
}) {
  const t = useT(text);
  const activity = useTerminalActivity(session);
  const bypass = session.mode === "bypass";

  let body: React.ReactNode;
  if (activity.isPending) body = <LoadingState />;
  else if (activity.isError) body = <LoadFailure error={activity.error} retry={activity.refetch} />;
  else if (bypass) {
    const actions = [...activity.data.actions].sort((a, b) => b.at.localeCompare(a.at));
    body =
      actions.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.actionsEmpty}</p>
      ) : (
        <ol className="grid gap-2">
          {actions.map((action) => (
            <li key={action.id}>
              <ActionRow action={action} />
            </li>
          ))}
        </ol>
      );
  } else {
    const proposals = [...activity.data.proposals].sort(
      (a, b) =>
        Number(b.status === "pending") - Number(a.status === "pending") || b.createdAt.localeCompare(a.createdAt),
    );
    body =
      proposals.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.proposalsEmpty}</p>
      ) : (
        <ul className="grid gap-2.5">
          {proposals.map((proposal) => (
            <li key={proposal.id}>
              <ApprovalCard approval={proposal} projects={projects} canDecide={session.isOwner} />
            </li>
          ))}
        </ul>
      );
  }

  return (
    <section
      id={id}
      aria-label={bypass ? t.actions : t.proposals}
      className="flex min-h-0 min-w-0 flex-col gap-2.5 overflow-hidden rounded-xl border border-border bg-card p-3"
    >
      <header className="grid gap-0.5">
        <h2 className="font-heading text-base font-semibold">{bypass ? t.actions : t.proposals}</h2>
        <p className="text-xs text-muted-foreground">{bypass ? t.actionsHint : t.proposalsHint}</p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
    </section>
  );
}

function ActionRow({ action }: { action: TerminalAction }) {
  const t = useT(text);
  const lang = useLang();
  const model =
    action.model && action.model in MODEL_LABEL ? MODEL_LABEL[action.model as "sonnet" | "opus"] : action.model;
  return (
    <div className="grid min-w-0 gap-1 rounded-lg border border-border p-2.5 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <time dateTime={action.at} className="text-muted-foreground">
          {formatClock(action.at)}
        </time>
        <code className="font-mono font-medium break-all text-foreground">{action.tool}</code>
        <Pill tone={action.outcome === "success" ? "ok" : "bad"} small>
          {action.outcome === "success" ? t.success : t.error}
        </Pill>
      </div>
      {action.action && <p className="break-words text-foreground">{action.action}</p>}
      {(action.tier || model) && (
        <p className="flex flex-wrap gap-x-3 text-muted-foreground">
          {action.tier && (
            <span>
              {t.tier}: <strong className="font-medium text-foreground">{tierLabel(action.tier, lang)}</strong>
            </span>
          )}
          {model && (
            <span>
              {t.model}: <strong className="font-medium text-foreground">{model}</strong>
            </span>
          )}
        </p>
      )}
      {action.reason && (
        <p className="break-words text-muted-foreground">
          {t.reason}: {action.reason}
        </p>
      )}
    </div>
  );
}
