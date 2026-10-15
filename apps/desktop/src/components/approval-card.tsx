import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Approval, Project, TaskTier } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { Textarea } from "@xdev-hive/ui/textarea";
import { useId, useState } from "react";
import { api } from "@/lib/hub-query.tsx";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { describeAction, hasTier, isTier, TIERS, tierLabel, tierMeaning } from "@/lib/leader.ts";
import { errorText } from "@/lib/tauri.ts";
import { cn } from "@/lib/utils.ts";

const text: Dict<Record<string, string>> = {
  vi: {
    proposal: "Đề xuất của Leader",
    pending: "Chờ duyệt",
    approved: "Đã duyệt",
    rejected: "Đã từ chối",
    expired: "Hết hạn",
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
 * Đề xuất của Leader trong chat. Leader chỉ đề xuất; hub mới thực hiện khi người có quyền duyệt (hub kiểm quyền, nút
 * chỉ để người dùng thấy việc mình sắp đồng ý). `canDecide` tắt nút khi offline.
 */
export function ApprovalCard({
  approval,
  projects,
  canDecide = true,
}: {
  approval: Approval;
  projects: readonly Project[] | undefined;
  canDecide?: boolean;
}) {
  const t = useT(text) as Record<string, string>;
  const lang = useLang();
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

  return (
    <section
      aria-label={t.proposal}
      className={cn("grid min-w-0 gap-2.5 rounded-xl border bg-card p-3.5", pending && "ring-1 ring-warning")}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={STATUS_TONE[approval.status]} small>
          {t[approval.status]}
        </Pill>
        <span className="text-xs text-muted-foreground">{t.proposal}</span>
      </div>
      <p className="rounded-lg border p-3 font-medium break-words">{describeAction(action, projects, lang)}</p>
      {leveled && (
        <p className="text-xs break-words text-muted-foreground">
          {leaderTier ? (
            <>
              {t.leaderTier}: <strong className="font-medium text-foreground">{tierLabel(leaderTier, lang)}</strong>
              {tierReason ? ` · ${t.tierReason}: ${tierReason}` : ""}
            </>
          ) : (
            t.noTier
          )}
        </p>
      )}
      {!pending && approval.reason && (
        <p className="text-xs break-words text-muted-foreground">
          {t.decidedReason}: {approval.reason}
        </p>
      )}
      {pending && leveled && canDecide && (
        <div className="grid gap-1.5">
          <label htmlFor={ids.tier} className="text-xs font-medium">
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
      {error && <Alert variant="destructive">{errorText(error)}</Alert>}
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
            <label htmlFor={ids.reason} className="text-xs font-medium">
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
    </section>
  );
}
