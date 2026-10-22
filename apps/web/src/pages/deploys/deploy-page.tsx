import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { Deploy, DeployStep } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { Pill } from "@xdev-hive/ui/pill";
import { type ReactNode, useId, useState } from "react";
import { LogCard } from "@/components/log-card.tsx";
import { Card } from "@/components/ui/card.tsx";
import { type DescriptionItem, DescriptionList } from "@/components/ui/description-list.tsx";
import { LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import {
  DEPLOY_METHOD_LABEL,
  DEPLOY_ORIGIN_LABEL,
  DEPLOY_STATE_LABEL,
  DEPLOY_STATE_TONE,
  DEPLOY_STEP_STATE_LABEL,
  DEPLOY_STEP_STATE_TONE,
  deployStepLabel,
  isDeployActive,
} from "@/lib/delivery-text.ts";
import { formatClock, formatDayTime, formatDuration } from "@/lib/format.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { useTeamPermissions } from "@/lib/permissions.ts";
import { useDeployStream } from "@/lib/use-deploy-stream.ts";
import { useNow } from "@/lib/use-now.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";
import { deployActor, HealthPill, VersionLines } from "./deploy-view.tsx";

const text: Dict<{
  title: string;
  crumb: string;
  steps: string;
  noSteps: string;
  exit: (code: number) => string;
  details: string;
  project: string;
  env: string;
  method: string;
  origin: string;
  by: string;
  version: string;
  health: string;
  skipBackup: string;
  external: string;
  approval: (done: number, required: number) => string;
  created: string;
  started: string;
  finished: string;
  duration: string;
  cancel: string;
  cancelTitle: string;
  cancelLead: string;
  cancelKeep: string;
  canceling: string;
  ended: string;
  noLog: string;
  stateLabel: string;
}> = {
  vi: {
    title: "Lần triển khai",
    crumb: "Triển khai",
    steps: "Các bước",
    noSteps: "Chưa có bước nào chạy.",
    exit: (code) => `mã thoát ${code}`,
    details: "Chi tiết",
    project: "Dự án",
    env: "Môi trường",
    method: "Cách triển khai",
    origin: "Nguồn",
    by: "Người",
    version: "Phiên bản",
    health: "Sức khoẻ",
    skipBackup: "Bỏ qua sao lưu",
    external: "Hệ ngoài",
    approval: (done, required) => `${done}/${required} lượt duyệt`,
    created: "Tạo lúc",
    started: "Bắt đầu",
    finished: "Kết thúc",
    duration: "Thời gian chạy",
    cancel: "Huỷ lần triển khai",
    cancelTitle: "Huỷ lần triển khai này?",
    cancelLead:
      "Hub dừng các bước còn lại. Bước đã chạy xong không được hoàn tác; muốn về bản cũ thì dùng quay về bản trước.",
    cancelKeep: "Không huỷ",
    canceling: "Đang huỷ…",
    ended: "Lần triển khai đã xong",
    noLog: "Lần triển khai không có log.",
    stateLabel: "Trạng thái",
  },
  en: {
    title: "Deployment",
    crumb: "Deployments",
    steps: "Steps",
    noSteps: "No step has run yet.",
    exit: (code) => `exit code ${code}`,
    details: "Details",
    project: "Project",
    env: "Environment",
    method: "Method",
    origin: "Source",
    by: "By",
    version: "Version",
    health: "Health",
    skipBackup: "Backup skipped",
    external: "External system",
    approval: (done, required) => `${done}/${required} approvals`,
    created: "Created",
    started: "Started",
    finished: "Finished",
    duration: "Run time",
    cancel: "Cancel deployment",
    cancelTitle: "Cancel this deployment?",
    cancelLead:
      "The hub stops the remaining steps. Steps that already finished are not undone; use rollback to return to the previous version.",
    cancelKeep: "Keep running",
    canceling: "Canceling…",
    ended: "Deployment finished",
    noLog: "This deployment has no log.",
    stateLabel: "State",
  },
};

/** Chỉ mở link http(s) của hệ ngoài; địa chỉ lạ (javascript:) hiện thành chữ thường. */
function safeHref(url: string | null): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null;
}

/** Trang một lần triển khai (FR-016, FR-017): các bước, log trực tiếp qua SSE, chi tiết và nút huỷ. */
export function DeployPage() {
  const t = useT(text);
  const { id } = useParams({ from: "/session/app/in-org/deploys/$id" });
  const { org, api } = useOrg();
  const queryClient = useQueryClient();
  const deploy = useQuery(api.deploys.get.queryOptions({ input: { id } }));
  // Mỗi khung `steps` hay `end` nghĩa là phiên bản, health, giờ kết thúc trong deploys.get có thể đã đổi.
  const stream = useDeployStream(org.id, id, () => {
    void queryClient.invalidateQueries({ queryKey: api.deploys.get.key({ input: { id } }) });
  });
  const systemId = deploy.data?.systemId ?? "";
  const board = useQuery(api.deploys.board.queryOptions({ input: { systemId }, enabled: !!systemId }));
  const systems = useQuery(api.systems.list.queryOptions({ input: {} }));
  const system = systems.data?.find((s) => s.id === systemId);
  const live = !!deploy.data && isDeployActive(stream.snapshot?.state ?? deploy.data.state);
  const now = useNow(1000, live);

  const crumb = systemId ? (
    <Link to="/systems/$systemId/deploys" params={{ systemId }} className="text-primary hover:text-primary/90">
      {t.crumb}
      {system ? ` · ${system.name}` : ""}
    </Link>
  ) : undefined;

  if (deploy.isPending) {
    return (
      <>
        <PageHeader title={t.title} />
        <PageBody>
          <LoadingState />
        </PageBody>
      </>
    );
  }
  if (deploy.isError) {
    return (
      <>
        <PageHeader title={t.title} />
        <PageBody>
          <LoadFailure error={deploy.error} retry={() => void deploy.refetch()} />
        </PageBody>
      </>
    );
  }

  const d = deploy.data;
  const state = stream.snapshot?.state ?? d.state;
  const steps = stream.snapshot?.steps ?? d.steps;
  const projectName = board.data?.rows.find((r) => r.projectId === d.projectId)?.projectName ?? "—";
  const envName = board.data?.environments.find((e) => e.id === d.environmentId)?.name ?? "—";
  return (
    <>
      <PageHeader
        crumb={crumb}
        title={`${projectName} → ${envName}`}
        meta={
          <>
            <Pill tone={DEPLOY_STATE_TONE[state]} dot aria-label={`${t.stateLabel}: ${DEPLOY_STATE_LABEL[state]}`}>
              {DEPLOY_STATE_LABEL[state]}
            </Pill>
            <span>{DEPLOY_METHOD_LABEL[d.method]}</span>
            <span>{deployActor(d)}</span>
          </>
        }
      >
        {system && isDeployActive(state) && <CancelAction deploy={d} teamId={system.teamId} />}
      </PageHeader>
      <PageBody>
        <div className="grid items-start gap-5 app:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
          <div className="grid min-w-0 gap-5">
            <StepsCard steps={steps} />
            <LogCard
              log={stream.log}
              status={stream.status}
              onRetry={stream.retry}
              endedText={t.ended}
              emptyEndedText={t.noLog}
            />
          </div>
          <aside aria-label={t.details} className="grid min-w-0 gap-4">
            <DetailsCard deploy={d} state={state} projectName={projectName} envName={envName} now={now} />
          </aside>
        </div>
      </PageBody>
    </>
  );
}

function SectionCard({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <Card>
      <section aria-labelledby={headingId} className="grid gap-2.5 px-5 py-4">
        <h2 id={headingId} className="text-base font-semibold text-foreground">
          {title}
        </h2>
        {children}
      </section>
    </Card>
  );
}

function StepsCard({ steps }: { steps: DeployStep[] }) {
  const t = useT(text);
  return (
    <SectionCard title={t.steps}>
      {steps.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.noSteps}</p>
      ) : (
        <ol className="grid gap-2">
          {steps.map((step) => (
            <li
              key={step.key}
              aria-current={step.state === "running" ? "step" : undefined}
              className="grid gap-1 rounded-lg border border-border px-3 py-2 text-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <span className="min-w-0 font-medium break-words text-foreground">{deployStepLabel(step.key)}</span>
                <Pill tone={DEPLOY_STEP_STATE_TONE[step.state]} dot>
                  {DEPLOY_STEP_STATE_LABEL[step.state]}
                </Pill>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground tabular-nums">
                {step.startedAt && <time dateTime={step.startedAt}>{formatClock(step.startedAt)}</time>}
                {step.finishedAt && (
                  <time dateTime={step.finishedAt}>
                    {"→ "}
                    {formatClock(step.finishedAt)}
                  </time>
                )}
                {step.exitCode !== null && <span className="font-mono">{t.exit(step.exitCode)}</span>}
              </div>
              {step.message && <p className="text-xs break-words text-muted-foreground">{step.message}</p>}
            </li>
          ))}
        </ol>
      )}
    </SectionCard>
  );
}

function DetailsCard({
  deploy,
  state,
  projectName,
  envName,
  now,
}: {
  deploy: Deploy;
  state: Deploy["state"];
  projectName: string;
  envName: string;
  now: number;
}) {
  const t = useT(text);
  const href = safeHref(deploy.external?.url ?? null);
  const items: DescriptionItem[] = [
    { term: t.project, detail: projectName },
    { term: t.env, detail: envName },
    { term: t.method, detail: DEPLOY_METHOD_LABEL[deploy.method] },
    { term: t.origin, detail: DEPLOY_ORIGIN_LABEL[deploy.origin] },
    { term: t.by, detail: deployActor(deploy) },
    { term: t.version, detail: <VersionLines version={deploy.version} /> },
  ];
  if (deploy.health) items.push({ term: t.health, detail: <HealthPill health={deploy.health} /> });
  if (deploy.skipBackup) items.push({ term: t.skipBackup, detail: deploy.skipBackup.reason });
  if (deploy.external) {
    items.push({
      term: t.external,
      detail: href ? (
        <a href={href} target="_blank" rel="noreferrer noopener" className="text-primary hover:text-primary/90">
          {deploy.external.label}
        </a>
      ) : (
        deploy.external.label
      ),
    });
  }
  if (deploy.approval) {
    items.push({
      term: DEPLOY_STATE_LABEL.pending_approval,
      detail: t.approval(
        deploy.approval.decisions.filter((x) => x.decision === "approve").length,
        deploy.approval.required,
      ),
    });
  }
  items.push({ term: t.created, detail: formatDayTime(deploy.createdAt) });
  if (deploy.startedAt) items.push({ term: t.started, detail: formatDayTime(deploy.startedAt) });
  if (deploy.finishedAt) items.push({ term: t.finished, detail: formatDayTime(deploy.finishedAt) });
  if (deploy.startedAt) {
    const end = deploy.finishedAt ? new Date(deploy.finishedAt).getTime() : isDeployActive(state) ? now : null;
    if (end !== null)
      items.push({ term: t.duration, detail: formatDuration(end - new Date(deploy.startedAt).getTime()) });
  }
  return (
    <SectionCard title={t.details}>
      <DescriptionList items={items} />
    </SectionCard>
  );
}

function CancelAction({ deploy, teamId }: { deploy: Deploy; teamId: string }) {
  const t = useT(text);
  const canRun = useTeamPermissions(teamId)("deploy.run");
  const [open, setOpen] = useState(false);
  if (!canRun) return null;
  return (
    <>
      <Button variant="destructive" onClick={() => setOpen(true)} aria-haspopup="dialog">
        {t.cancel}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <CancelConfirm deploy={deploy} onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}

function CancelConfirm({ deploy, onDone }: { deploy: Deploy; onDone: () => void }) {
  const t = useT(text);
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const cancel = useMutation({
    mutationFn: () => api.deploys.cancel.call({ id: deploy.id }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: api.deploys.key() });
      onDone();
    },
    onError: (e) => setError(apiErrorMessage(e)),
  });
  return (
    <div className="grid gap-3.5">
      <DialogTitle>{t.cancelTitle}</DialogTitle>
      <DialogDescription>{t.cancelLead}</DialogDescription>
      {error && <Alert variant="destructive">{error}</Alert>}
      <DialogActions>
        <Button variant="outline" onClick={onDone}>
          {t.cancelKeep}
        </Button>
        <Button variant="destructive-solid" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
          {cancel.isPending ? t.canceling : t.cancel}
        </Button>
      </DialogActions>
    </div>
  );
}
