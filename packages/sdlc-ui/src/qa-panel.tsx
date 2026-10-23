import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SdlcItemDetail } from "@xdev-hive/contracts";
import { Button } from "@xdev-hive/ui/button";
import { Textarea } from "@xdev-hive/ui/textarea";
import { useState } from "react";
import { useSdlcEnv } from "./env.tsx";

const text = {
  vi: {
    title: "Cổng QA",
    loading: "Đang tải metadata QA…",
    empty: "Chưa có TC đã duyệt.",
    open: "Đủ điều kiện QA",
    blocked: "QA đang chặn",
    case: "Test case",
    requirements: "FR/AC",
    status: "Kết quả",
    missing: "Thiếu kết quả",
    required: "Bắt buộc",
    optional: "Tuỳ chọn",
    retired: "Ngừng dùng",
    waive: "Miễn TC",
    revoke: "Thu hồi miễn",
    reason: "Lý do quyết định QA",
    save: "Lưu quyết định",
    cancel: "Huỷ",
    local: "Bộ test chạy tại worker hoặc desktop. Hub chỉ giữ metadata kết quả.",
    passed: "Đạt",
    failed: "Không đạt",
    skipped: "Bỏ qua",
    flaky: "Chập chờn",
    waived: "Đã miễn",
  },
  en: {
    title: "QA gate",
    loading: "Loading QA metadata…",
    empty: "No approved test cases yet.",
    open: "QA conditions met",
    blocked: "QA is blocking",
    case: "Test case",
    requirements: "FR/AC",
    status: "Result",
    missing: "Missing result",
    required: "Required",
    optional: "Optional",
    retired: "Retired",
    waive: "Waive case",
    revoke: "Revoke waiver",
    reason: "QA decision reason",
    save: "Save decision",
    cancel: "Cancel",
    local: "Tests run on the worker or desktop. The hub stores result metadata only.",
    passed: "Passed",
    failed: "Failed",
    skipped: "Skipped",
    flaky: "Flaky",
    waived: "Waived",
  },
};

export function QaPanel({ item }: { item: SdlcItemDetail }) {
  const { api, lang, errorMessage } = useSdlcEnv();
  const t = text[lang];
  const qc = useQueryClient();
  const [decision, setDecision] = useState<{ caseId: string; waived: boolean } | null>(null);
  const [reason, setReason] = useState("");
  const view = useQuery(api.sdlc.qa.view.queryOptions({ input: { itemId: item.id } }));
  const mutation = useMutation(
    api.sdlc.qa.waive.mutationOptions({
      onSuccess: async () => {
        setDecision(null);
        setReason("");
        await qc.invalidateQueries({ queryKey: api.sdlc.key() });
      },
    }),
  );
  return (
    <section aria-label={t.title} className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <h2 className="text-base font-semibold">{t.title}</h2>
      <p className="text-xs text-muted-foreground">{t.local}</p>
      {view.isPending && <p role="status">{t.loading}</p>}
      {view.isError && (
        <p role="alert" className="text-destructive">
          {errorMessage(view.error)}
        </p>
      )}
      {view.data && (
        <>
          <p className="font-medium">
            {view.data.checks.length > 0 && view.data.checks.every((c) => c.passed) ? t.open : t.blocked}
          </p>
          {view.data.report && (
            <p className="break-all text-xs text-muted-foreground">
              {view.data.report.data.runner} · {view.data.report.data.totals.passed}/
              {view.data.report.data.totals.total} · {view.data.report.data.durationMs} ms
              {view.data.report.data.commit && ` · ${view.data.report.data.commit}`}
            </p>
          )}
          {!view.data.cases.length && <p>{t.empty}</p>}
          <ul className="flex flex-col divide-y divide-border">
            {view.data.cases.map((c) => (
              <li key={c.id} className="flex flex-col gap-2 py-3 text-sm">
                <p className="break-words">
                  <strong>{c.code}</strong> · {c.title}
                </p>
                <p>
                  {t.requirements}: {c.requirementIds.join(", ")} ·{" "}
                  {c.retired ? t.retired : c.required ? t.required : t.optional}
                </p>
                {c.scriptPath && <p className="break-all font-mono text-xs">{c.scriptPath}</p>}
                <p>
                  {t.status}: {c.waivedBy ? t.waived : c.lastStatus ? t[c.lastStatus] : t.missing}
                </p>
                {c.waiverReason && (
                  <p className="break-words text-muted-foreground">
                    {c.waivedBy} · {c.waiverReason}
                  </p>
                )}
                {view.data.canWaive && item.status === "active" && !c.retired && c.required && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="self-start"
                    onClick={() => {
                      setDecision({ caseId: c.id, waived: !c.waivedBy });
                      setReason("");
                      mutation.reset();
                    }}
                  >
                    {c.waivedBy ? t.revoke : t.waive}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {decision && (
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (reason.trim().length >= 10) mutation.mutate({ ...decision, reason: reason.trim() });
              }}
            >
              <Textarea
                aria-label={t.reason}
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              {mutation.isError && (
                <p role="alert" className="text-destructive">
                  {errorMessage(mutation.error)}
                </p>
              )}
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={reason.trim().length < 10 || mutation.isPending}>
                  {t.save}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={mutation.isPending}
                  onClick={() => setDecision(null)}
                >
                  {t.cancel}
                </Button>
              </div>
            </form>
          )}
        </>
      )}
    </section>
  );
}
