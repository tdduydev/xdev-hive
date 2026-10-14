import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SdlcAutoApproval } from "@xdev-hive/contracts";
import { Button } from "@xdev-hive/ui/button";
import { Label } from "@xdev-hive/ui/label";
import { Pill } from "@xdev-hive/ui/pill";
import { Textarea } from "@xdev-hive/ui/textarea";
import { Check, X } from "lucide-react";
import { useId, useState } from "react";
import { useSdlcEnv, useText } from "./env.tsx";
import { formatWhen } from "./format.ts";

const REASON_MIN = 10;

export function formatScore(score: number, lang: "vi" | "en"): string {
  return new Intl.NumberFormat(lang === "en" ? "en-GB" : "vi-VN", { maximumFractionDigits: 1 }).format(score);
}

/** Nhãn "Tự duyệt bởi AI · 9,3/10" (D26): người xem phải phân biệt được baseline do AI hay do người. */
export function AutoApprovalBadge({ approval }: { approval: SdlcAutoApproval }) {
  const { lang } = useSdlcEnv();
  const t = useText().detail;
  if (approval.revokedAt) return <Pill tone="warn">{t.autoRevoked}</Pill>;
  return <Pill tone="sel">{t.autoBadge(formatScore(approval.score, lang))}</Pill>;
}

/**
 * Một lần tự duyệt: điểm và ngưỡng, các điều kiện đã xét, hạn thu hồi, và nút Thu hồi (bắt buộc lý do) cho người đủ
 * điều kiện còn trong hạn (US18). Thu hồi đưa tài liệu về "Đang duyệt" và mở phiên duyệt người.
 */
export function AutoApproval({ approval }: { approval: SdlcAutoApproval }) {
  const { api, lang, errorMessage } = useSdlcEnv();
  const t = useText().detail;
  const ids = useId();
  const queryClient = useQueryClient();
  const [revoking, setRevoking] = useState(false);
  const [reason, setReason] = useState("");
  const revoke = useMutation(
    api.sdlc.autoApprovals.revoke.mutationOptions({
      onSuccess: () => {
        setRevoking(false);
        setReason("");
        void queryClient.invalidateQueries({ queryKey: api.sdlc.key() });
      },
    }),
  );
  // Hạn là mốc cố định; so một lần mỗi lần dựng là đủ, hub kiểm lại khi gửi.
  const open = !approval.revokedAt && Date.parse(approval.revocableUntil) > Date.now();

  return (
    <section
      aria-label={`${approval.artifactName} · ${approval.gateName}`}
      className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm"
    >
      <header className="flex flex-wrap items-center gap-2">
        <AutoApprovalBadge approval={approval} />
        <span className="font-medium">{approval.artifactName}</span>
        <span className="text-xs text-muted-foreground">
          {approval.gateName}
          {approval.version !== null && ` · v${approval.version}`}
        </span>
      </header>
      <p className="text-xs text-muted-foreground">
        {t.autoScore(formatScore(approval.score, lang), formatScore(approval.threshold, lang))}
        {approval.reviewer &&
          ` · ${approval.reviewer.cli}${approval.reviewer.model ? ` (${approval.reviewer.model})` : ""}`}
        {" · "}
        {approval.revokedAt
          ? t.revokedBy(approval.revokedBy?.name ?? "", formatWhen(approval.revokedAt, lang))
          : open
            ? t.revocableUntil(formatWhen(approval.revocableUntil, lang))
            : t.revokeExpired}
      </p>
      {approval.revokeReason && <p className="text-xs">{approval.revokeReason}</p>}
      {approval.reasons.length > 0 && (
        <ul aria-label={t.autoChecks} className="flex flex-col gap-0.5 text-xs">
          {approval.reasons.map((r) => (
            <li key={r.check} className="flex items-start gap-1.5">
              {r.passed ? (
                <Check aria-label={t.checkPassed} className="mt-0.5 size-3.5 shrink-0 text-success" />
              ) : (
                <X aria-label={t.checkFailed} className="mt-0.5 size-3.5 shrink-0 text-destructive" />
              )}
              <span>{r.detail}</span>
            </li>
          ))}
        </ul>
      )}
      {open && approval.canRevoke && !revoking && (
        <Button variant="outline" size="sm" className="self-start" onClick={() => setRevoking(true)}>
          {t.revoke}
        </Button>
      )}
      {revoking && (
        <form
          className="flex flex-col gap-2 rounded-md bg-warning-soft p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (reason.trim().length >= REASON_MIN) revoke.mutate({ id: approval.id, reason: reason.trim() });
          }}
        >
          <p className="text-xs">{t.revEffect}</p>
          <Label htmlFor={`${ids}-reason`}>{t.reason}</Label>
          <Textarea
            id={`${ids}-reason`}
            rows={2}
            value={reason}
            placeholder={t.revReasonHint}
            onChange={(e) => setReason(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t.reasonNeed(REASON_MIN)}</p>
          {revoke.isError && <p className="text-xs text-destructive">{errorMessage(revoke.error)}</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setRevoking(false)}>
              {t.cancel}
            </Button>
            <Button
              type="submit"
              variant="destructive-solid"
              size="sm"
              disabled={reason.trim().length < REASON_MIN || revoke.isPending}
            >
              {t.revSubmit}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
