import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Approval, Project, TaskTier } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { Textarea } from "@xdev-hive/ui/textarea";
import { useId, useState } from "react";
import { Card } from "@/components/ui/card.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { cx } from "@/lib/cx.ts";
import { formatDayTime } from "@/lib/format.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { describeAction } from "@/lib/leader.ts";
import { hasTier, isTier, TIERS, tierLabel, tierMeaning } from "@/lib/terminal.ts";
import { useOrg } from "@/shell/org-context.ts";

const text: Dict<
  Record<
    | "proposal"
    | "pending"
    | "approved"
    | "rejected"
    | "expired"
    | "expires"
    | "rejectReason"
    | "cancel"
    | "reject"
    | "rejectMore"
    | "executing"
    | "approve"
    | "leaderTier"
    | "noTier"
    | "tierField"
    | "tierAuto"
    | "tierAutoHint"
    | "tierReason"
    | "decidedReason",
    string
  >
> = {
  vi: {
    proposal: "Đề xuất của leader",
    pending: "Chờ duyệt",
    approved: "Đã duyệt",
    rejected: "Đã từ chối",
    expired: "Hết hạn",
    expires: "Hết hạn",
    rejectReason: "Lý do từ chối",
    cancel: "Thôi",
    reject: "Từ chối",
    rejectMore: "Từ chối…",
    executing: "Đang thực hiện…",
    approve: "Duyệt và thực hiện",
    leaderTier: "Leader chọn cấp",
    noTier: "Leader chưa chọn cấp độ; hub tự suy như run thường.",
    tierField: "Cấp độ khi duyệt",
    tierAuto: "Để hub tự suy",
    tierAutoHint: "Hub chọn model và effort theo định tuyến mặc định của dự án.",
    tierReason: "Lý do",
    decidedReason: "Lý do từ chối",
  },
  en: {
    proposal: "Leader proposal",
    pending: "Awaiting approval",
    approved: "Approved",
    rejected: "Rejected",
    expired: "Expired",
    expires: "Expires",
    rejectReason: "Reason for rejecting",
    cancel: "Never mind",
    reject: "Reject",
    rejectMore: "Reject…",
    executing: "Running…",
    approve: "Approve and run",
    leaderTier: "Leader picked tier",
    noTier: "The leader did not pick a tier; the hub infers it like a normal run.",
    tierField: "Tier when approving",
    tierAuto: "Let the hub infer it",
    tierAutoHint: "The hub picks model and effort from the project's default routing.",
    tierReason: "Reason",
    decidedReason: "Rejection reason",
  },
};

const STATUS_TONE = { pending: "warn", approved: "ok", rejected: "bad", expired: "neutral" } as const;

/**
 * Đề xuất của leader (chat hoặc khung bên phải của terminal). Task và run được Leader gắn cấp độ kèm lý do; người
 * duyệt thấy và sửa được cấp trước khi duyệt, hub dùng cấp đã sửa để chọn model và effort. `canDecide` tắt nút duyệt
 * cho người chỉ xem phiên (hub vẫn là nơi kiểm quyền).
 */
export function ApprovalCard({
  approval,
  projects,
  canDecide = true,
  onDecided,
}: {
  approval: Approval;
  projects: readonly Project[] | undefined;
  canDecide?: boolean;
  onDecided?: () => void;
}) {
  const t = useT(text);
  const lang = useLang();
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const ids = { reason: useId(), tier: useId(), tierHint: useId() };
  const { action } = approval;
  const leveled = hasTier(action);
  const leaderTier = "tier" in action ? action.tier : undefined;
  const tierReason = "tierReason" in action ? action.tierReason : undefined;
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  // "" là để hub tự suy (đề xuất cũ không có cấp): không gửi `tier` khi duyệt.
  const [tier, setTier] = useState<TaskTier | "">(leaderTier ?? "");
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: api.leader.approvals.list.key() });
    await queryClient.invalidateQueries({ queryKey: api.leader.threads.get.key() });
    await queryClient.invalidateQueries({ queryKey: api.terminal.activity.key() });
    onDecided?.();
  };
  const approve = useMutation({
    mutationFn: () => api.leader.approvals.approve.call({ id: approval.id, ...(tier ? { tier } : {}) }),
    onSuccess: refresh,
  });
  const reject = useMutation({
    mutationFn: () => api.leader.approvals.reject.call({ id: approval.id, reason: reason.trim() }),
    onSuccess: refresh,
  });
  const busy = approve.isPending || reject.isPending;
  const error = approve.error ?? reject.error;
  const pending = approval.status === "pending";
  const statusLabel = { pending: t.pending, approved: t.approved, rejected: t.rejected, expired: t.expired }[
    approval.status
  ];

  return (
    <Card className={cx("grid min-w-0 gap-2.5 p-3.5", pending && "ring-warning")} aria-label={t.proposal}>
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={STATUS_TONE[approval.status]} small>
          {statusLabel}
        </Pill>
        {pending && (
          <span className="text-xs text-muted-foreground">
            {t.expires} {formatDayTime(approval.expiresAt)}
          </span>
        )}
        {!pending && leaderTier && <Pill small>{tierLabel(leaderTier, lang)}</Pill>}
      </div>
      <p className="rounded-lg border border-border p-3 font-medium break-words text-foreground">
        {describeAction(action, projects, lang)}
      </p>
      {leveled && (
        <div className="grid gap-1 text-xs text-muted-foreground">
          {leaderTier ? (
            <p className="break-words">
              {t.leaderTier}: <strong className="font-medium text-foreground">{tierLabel(leaderTier, lang)}</strong>
              {tierReason ? ` · ${t.tierReason}: ${tierReason}` : ""}
            </p>
          ) : (
            <p>{t.noTier}</p>
          )}
        </div>
      )}
      {!pending && approval.reason && (
        <p className="text-xs break-words text-muted-foreground">
          {t.decidedReason}: {approval.reason}
        </p>
      )}
      {pending && leveled && canDecide && (
        <div className="grid gap-1.5">
          <label htmlFor={ids.tier} className="text-xs font-medium text-foreground">
            {t.tierField}
          </label>
          <NativeSelect
            id={ids.tier}
            value={tier}
            disabled={busy}
            aria-describedby={ids.tierHint}
            onChange={(event) => setTier(isTier(event.target.value) ? event.target.value : "")}
          >
            {!leaderTier && <option value="">{t.tierAuto}</option>}
            {TIERS.map((value) => (
              <option key={value} value={value}>
                {tierLabel(value, lang)}
              </option>
            ))}
          </NativeSelect>
          <p id={ids.tierHint} className="text-xs text-muted-foreground">
            {tier ? tierMeaning(tier, lang) : t.tierAutoHint}
          </p>
        </div>
      )}
      {error && <Alert variant="destructive">{apiErrorMessage(error)}</Alert>}
      {pending &&
        canDecide &&
        (rejecting ? (
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (reason.trim()) reject.mutate();
            }}
            className="grid gap-2"
          >
            <label htmlFor={ids.reason} className="text-xs font-medium text-foreground">
              {t.rejectReason}
            </label>
            <Textarea autoFocus id={ids.reason} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
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
        ))}
    </Card>
  );
}
