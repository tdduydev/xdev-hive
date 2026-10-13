import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project, ProvisionStep } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Pill } from "@xdev-hive/ui/pill";
import { useEffect, useId } from "react";
import { Card } from "@/components/ui/card.tsx";
import { LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { PROJECT_STATE } from "@/lib/projects.ts";
import { PROVISION_STEP_STATE, provisionInFlight } from "@/lib/scm-connections.ts";
import { useOrg } from "@/shell/org-context.ts";

/** Khởi tạo chạy trên hàng đợi của hub, thường xong trong vài giây; hỏi lại đủ nhanh để thấy từng bước qua. */
const POLL_MS = 3_000;

const text: Dict<{
  title: string;
  leadRunning: string;
  leadFailed: string;
  stepsAria: string;
  fix: string;
  attempts: (n: number) => string;
  retry: string;
  retrying: string;
  noPermission: string;
}> = {
  vi: {
    title: "Khởi tạo dự án",
    leadRunning: "Hub đang tạo hoặc nối repo, thêm AGENTS.md, bảo vệ nhánh chính và webhook.",
    leadFailed: "Một bước khởi tạo bị lỗi. Sửa theo gợi ý rồi bấm “Chạy lại”; các bước đã xong không chạy lại.",
    stepsAria: "Các bước khởi tạo",
    fix: "Cách sửa:",
    attempts: (n) => `Đã chạy ${n} lần`,
    retry: "Chạy lại",
    retrying: "Đang chạy lại…",
    noPermission: "Chỉ quản trị đội sở hữu dự án chạy lại được bước lỗi.",
  },
  en: {
    title: "Project setup",
    leadRunning: "The hub is creating or linking the repo, adding AGENTS.md, branch protection and webhooks.",
    leadFailed: "A setup step failed. Apply the suggested fix, then press “Retry”; finished steps are not repeated.",
    stepsAria: "Setup steps",
    fix: "Fix:",
    attempts: (n) => `Attempted ${n} times`,
    retry: "Retry",
    retrying: "Retrying…",
    noPermission: "Only admins of the owning team can retry a failed step.",
  },
};

/** Các bước khởi tạo của dự án chưa hoạt động, kèm lỗi từng bước và nút chạy lại bước lỗi. */
export function ProvisionSteps({ project, canRetry }: { project: Project; canRetry: boolean }) {
  const { api } = useOrg();
  const t = useT(text);
  const lang = useLang();
  const headingId = useId();
  const queryClient = useQueryClient();
  const provision = useQuery(
    api.projects.provision.queryOptions({
      input: { id: project.id },
      refetchInterval: (q) => (q.state.data && provisionInFlight(q.state.data.steps) ? POLL_MS : false),
    }),
  );
  const retry = useMutation({
    mutationFn: (stepId: string) => api.projects.retryStep.call({ id: project.id, stepId }),
    onSuccess: async (view) => {
      queryClient.setQueryData(api.projects.provision.queryKey({ input: { id: project.id } }), view);
      await queryClient.invalidateQueries({ queryKey: api.projects.list.key() });
    },
  });

  const steps = provision.data?.steps ?? [];
  const state = provision.data?.project.state ?? project.state;
  // Hết bước đang chạy mà dự án vẫn ghi "đang khởi tạo" thì danh sách dự án đã cũ: tải lại để mở khoá "Tạo việc".
  const settled = !!provision.data && !provisionInFlight(steps) && provision.data.project.state !== project.state;
  useEffect(() => {
    if (settled) void queryClient.invalidateQueries({ queryKey: api.projects.list.key() });
  }, [settled, queryClient, api]);

  return (
    <Card className="grid gap-3 p-5" role="group" aria-labelledby={headingId}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={headingId} className="text-base font-semibold text-foreground">
          {t.title}
        </h2>
        <Pill tone={PROJECT_STATE[state].tone} dot>
          {PROJECT_STATE[state].label[lang]}
        </Pill>
      </div>
      <p className="text-sm text-muted-foreground">{state === "failed" ? t.leadFailed : t.leadRunning}</p>
      {provision.isPending ? (
        <LoadingState />
      ) : provision.isError ? (
        <LoadFailure error={provision.error} retry={provision.refetch} />
      ) : (
        <ol aria-label={t.stepsAria} className="grid gap-2">
          {steps.map((s) => (
            <StepRow
              key={s.id}
              step={s}
              canRetry={canRetry}
              busy={retry.isPending}
              retrying={retry.isPending && retry.variables === s.id}
              onRetry={() => retry.mutate(s.id)}
            />
          ))}
        </ol>
      )}
      {retry.isError && <Alert variant="destructive">{apiErrorMessage(retry.error)}</Alert>}
      {!canRetry && steps.some((s) => s.state === "failed") && (
        <p className="text-sm text-muted-foreground">{t.noPermission}</p>
      )}
    </Card>
  );
}

function StepRow({
  step: s,
  canRetry,
  busy,
  retrying,
  onRetry,
}: {
  step: ProvisionStep;
  canRetry: boolean;
  busy: boolean;
  retrying: boolean;
  onRetry: () => void;
}) {
  const t = useT(text);
  const lang = useLang();
  const tone = PROVISION_STEP_STATE[s.state];
  return (
    <li className="grid gap-1.5 rounded-lg border border-border px-3.5 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 break-words text-sm font-medium text-foreground">
          {s.position}. {s.title}
        </span>
        {s.target && <span className="min-w-0 break-all font-mono text-xs text-muted-foreground">{s.target}</span>}
        <Pill tone={tone.tone} dot className="ml-auto">
          {tone.label[lang]}
        </Pill>
      </div>
      {s.state === "failed" && s.error && (
        <div className="grid justify-items-start gap-1.5">
          <p className="break-words text-sm text-destructive">{s.error.message}</p>
          {s.error.fix && (
            <p className="break-words text-sm text-foreground">
              <span className="font-medium">{t.fix}</span> {s.error.fix}
            </p>
          )}
          <span className="flex flex-wrap items-center gap-3">
            {canRetry && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={onRetry}
                aria-label={`${t.retry}: ${s.title}`}
              >
                {retrying ? t.retrying : t.retry}
              </Button>
            )}
            {s.attempts > 0 && <span className="text-xs text-muted-foreground">{t.attempts(s.attempts)}</span>}
          </span>
        </div>
      )}
    </li>
  );
}
