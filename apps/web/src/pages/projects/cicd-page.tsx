import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { CiFeedSource, CiProjectJob, CiRun, CiRunStatus, CiSource, Project } from "@xdev-hive/contracts";
import { ciRunStatus } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button, buttonVariants } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { Input } from "@xdev-hive/ui/input";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { Table, Td, Th } from "@xdev-hive/ui/table";
import { ExternalLinkIcon, LockIcon, WorkflowIcon } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import { Field, FieldError, FieldLabel } from "@/components/ui/field.tsx";
import { FilterChips } from "@/components/ui/filter-chips.tsx";
import { EmptyState, LoadFailure, LoadingState, TableSkeleton } from "@/components/ui/query-state.tsx";
import { apiErrorMessage, formError } from "@/lib/api-errors.ts";
import { CI_FEED_STATE_LABEL, CI_SOURCE_LABEL, CI_STATUS_LABEL, CI_STATUS_TONE } from "@/lib/delivery-text.ts";
import { formatDayTime, formatDuration } from "@/lib/format.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { useTeamPermissions } from "@/lib/permissions.ts";
import { CI_POLL_MS, CiRunDetailView, isCiActive, NoTokenReason, safeHref } from "@/pages/projects/cicd-run-detail.tsx";
import { JenkinsParamsForm } from "@/pages/projects/jenkins-params-form.tsx";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

/** Danh sách tự làm mới; hub tự đọc lại nguồn theo lịch của nó. */
const FEED_REFRESH_MS = CI_POLL_MS * 3;

const text: Dict<{
  title: string;
  lead: string;
  projectCrumb: string;
  missing: (key: string) => string;
  backToProjects: string;
  noViewTitle: string;
  noView: string;
  emptyTitle: string;
  empty: string;
  emptyFiltered: string;
  caption: string;
  colSource: string;
  colBranch: string;
  colCommit: string;
  colStatus: string;
  colDuration: string;
  colTrigger: string;
  colLink: string;
  open: (title: string) => string;
  openOrigin: string;
  openOriginOf: (title: string) => string;
  filterSource: string;
  filterAll: string;
  branchLabel: string;
  branchPlaceholder: string;
  statusLabel: string;
  statusAll: string;
  more: string;
  loadingMore: string;
  sources: string;
  staleSince: (at: string) => string;
  staleNoTime: string;
  addToken: string;
  jobs: string;
  jobsEmpty: string;
  attach: string;
  detach: (path: string) => string;
  detachShort: string;
  build: (path: string) => string;
  myNoToken: string;
  noTokenReason: string;
  noTokenLink: string;
  attachTitle: string;
  attachLead: string;
  fConnection: string;
  fConnectionPick: string;
  fJob: string;
  fJobHint: string;
  noConnections: string;
  save: string;
  saving: string;
  cancel: string;
  buildTitle: (path: string) => string;
  buildLead: string;
  detachTitle: (path: string) => string;
  detachLead: string;
  detachConfirm: string;
  detaching: string;
}> = {
  vi: {
    title: "CI/CD",
    lead: "Pipeline GitLab và build Jenkins của dự án, gộp một danh sách.",
    projectCrumb: "Dự án",
    missing: (key) => `Không tìm thấy dự án ${key}, hoặc bạn không ở trong đội sở hữu dự án.`,
    backToProjects: "Về danh sách dự án",
    noViewTitle: "Bạn chưa có quyền xem CI",
    noView: "Nhờ quản trị cấp quyền Xem CI, lần triển khai và log cho bạn trong đội của dự án.",
    emptyTitle: "Chưa có lần chạy nào",
    empty:
      "Dự án chưa có pipeline GitLab nào, và chưa gắn job Jenkins. Người có quyền sửa cấu hình gắn job ở mục bên dưới.",
    emptyFiltered: "Không có lần chạy nào khớp bộ lọc.",
    caption: "Các lần chạy CI của dự án",
    colSource: "Nguồn",
    colBranch: "Nhánh",
    colCommit: "Commit",
    colStatus: "Trạng thái",
    colDuration: "Thời lượng",
    colTrigger: "Người kích hoạt",
    colLink: "Link gốc",
    open: (title) => `Xem chi tiết ${title}`,
    openOrigin: "Mở",
    openOriginOf: (title) => `Mở ${title} trên nguồn`,
    filterSource: "Lọc theo nguồn",
    filterAll: "Tất cả",
    branchLabel: "Nhánh",
    branchPlaceholder: "Lọc theo nhánh",
    statusLabel: "Trạng thái",
    statusAll: "Mọi trạng thái",
    more: "Tải thêm",
    loadingMore: "Đang tải…",
    sources: "Tình trạng nguồn",
    staleSince: (at) => `Dữ liệu cũ, đọc lần cuối lúc ${at}`,
    staleNoTime: "Dữ liệu cũ",
    addToken: "Thêm token",
    jobs: "Job Jenkins của dự án",
    jobsEmpty: "Chưa gắn job Jenkins nào.",
    attach: "Gắn job Jenkins",
    detach: (p) => `Gỡ ${p}`,
    detachShort: "Gỡ",
    build: (p) => `Build ${p}`,
    myNoToken: "Bạn chưa có token",
    noTokenReason: "Thêm token Jenkins của bạn ở Cài đặt cá nhân",
    noTokenLink: "Thêm token",
    attachTitle: "Gắn job Jenkins vào dự án",
    attachLead: "Nhập đường dẫn job như trên giao diện Jenkins, ví dụ his-portal/build-dev.",
    fConnection: "Kết nối Jenkins",
    fConnectionPick: "Chọn kết nối",
    fJob: "Đường dẫn job",
    fJobHint: "Các tên ngăn bởi /, không có đoạn rỗng.",
    noConnections: "Tổ chức chưa có kết nối Jenkins. Nhờ người quản lý kết nối CI thêm trước.",
    save: "Gắn job",
    saving: "Đang gắn…",
    cancel: "Huỷ",
    buildTitle: (p) => `Build ${p}`,
    buildLead: "Build chạy bằng token Jenkins của bạn. Điền tham số rồi gửi.",
    detachTitle: (p) => `Gỡ job ${p}?`,
    detachLead: "Dự án không còn đọc build của job này. Job trên Jenkins không bị xoá.",
    detachConfirm: "Gỡ job",
    detaching: "Đang gỡ…",
  },
  en: {
    title: "CI/CD",
    lead: "GitLab pipelines and Jenkins builds of the project in one list.",
    projectCrumb: "Projects",
    missing: (key) => `Project ${key} not found, or you are not in the team that owns it.`,
    backToProjects: "Back to projects",
    noViewTitle: "You cannot view CI yet",
    noView: "Ask an admin to grant View CI, deploys and logs for the project's team.",
    emptyTitle: "No runs yet",
    empty:
      "The project has no GitLab pipelines and no Jenkins job attached. Whoever can edit settings attaches jobs below.",
    emptyFiltered: "No run matches the filters.",
    caption: "CI runs of the project",
    colSource: "Source",
    colBranch: "Branch",
    colCommit: "Commit",
    colStatus: "Status",
    colDuration: "Duration",
    colTrigger: "Triggered by",
    colLink: "Source link",
    open: (title) => `View details of ${title}`,
    openOrigin: "Open",
    openOriginOf: (title) => `Open ${title} at source`,
    filterSource: "Filter by source",
    filterAll: "All",
    branchLabel: "Branch",
    branchPlaceholder: "Filter by branch",
    statusLabel: "Status",
    statusAll: "All statuses",
    more: "Load more",
    loadingMore: "Loading…",
    sources: "Source health",
    staleSince: (at) => `Stale data, last read at ${at}`,
    staleNoTime: "Stale data",
    addToken: "Add token",
    jobs: "Jenkins jobs of the project",
    jobsEmpty: "No Jenkins job attached.",
    attach: "Attach Jenkins job",
    detach: (p) => `Detach ${p}`,
    detachShort: "Detach",
    build: (p) => `Build ${p}`,
    myNoToken: "You have no token",
    noTokenReason: "Add your Jenkins token in Personal settings",
    noTokenLink: "Add token",
    attachTitle: "Attach a Jenkins job to the project",
    attachLead: "Enter the job path as shown in Jenkins, for example his-portal/build-dev.",
    fConnection: "Jenkins connection",
    fConnectionPick: "Pick a connection",
    fJob: "Job path",
    fJobHint: "Names separated by /, no empty segment.",
    noConnections: "The organization has no Jenkins connection. Ask whoever manages CI connections to add one first.",
    save: "Attach job",
    saving: "Attaching…",
    cancel: "Cancel",
    buildTitle: (p) => `Build ${p}`,
    buildLead: "The build runs with your Jenkins token. Fill in the parameters and send.",
    detachTitle: (p) => `Detach job ${p}?`,
    detachLead: "The project stops reading this job's builds. The job on Jenkins is not deleted.",
    detachConfirm: "Detach job",
    detaching: "Detaching…",
  },
};

type SourceFilter = CiSource | "all";
const SOURCES: readonly CiSource[] = ["gitlab", "github", "jenkins"];

/** `jenkins:<jobId>:<build>` thành jobId, để biết run Jenkins thuộc job nào khi mở thẳng từ kết quả build. */
function jenkinsJobOf(runId: string): string | null {
  const m = /^jenkins:(.+):[^:]+$/.exec(runId);
  return m?.[1] ?? null;
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** /projects/$key/cicd: danh sách gộp pipeline GitLab và build Jenkins, chi tiết, thao tác. */
export function CiCdPage() {
  const { org, api } = useOrg();
  const t = useT(text);
  const { key } = useParams({ from: "/session/app/in-org/projects/$key/cicd" });
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const project = projects.data?.find((p) => p.key === key);
  if (projects.isPending)
    return (
      <>
        <PageHeader crumb={org.name} title={t.title} />
        <PageBody>
          <LoadingState />
        </PageBody>
      </>
    );
  if (projects.isError || !project)
    return (
      <>
        <PageHeader crumb={org.name} title={t.title} />
        <PageBody>
          <Alert variant="destructive">{projects.isError ? apiErrorMessage(projects.error) : t.missing(key)}</Alert>
          <Link to="/projects" className="text-primary hover:text-primary/90">
            {t.backToProjects}
          </Link>
        </PageBody>
      </>
    );
  return <CiCdBody project={project} />;
}

function CiCdBody({ project }: { project: Project }) {
  const t = useT(text);
  const can = useTeamPermissions(project.teamId);
  const canView = can("ci.view");
  const canOperate = can("ci.operate");
  const canSettings = can("projects.settings");
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [source, setSource] = useState<SourceFilter>("all");
  const [status, setStatus] = useState<CiRunStatus | "">("");
  const [branchText, setBranchText] = useState("");
  const branch = useDebounced(branchText.trim(), 300);
  const { api } = useOrg();

  const feed = useInfiniteQuery({
    ...api.ci.feed.infiniteOptions({
      input: (cursor: string | undefined) => ({
        projectId: project.id,
        ...(source !== "all" ? { source } : {}),
        ...(status ? { status } : {}),
        ...(branch ? { branch } : {}),
        ...(cursor ? { cursor } : {}),
      }),
      initialPageParam: undefined,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    }),
    enabled: canView,
    refetchInterval: FEED_REFRESH_MS,
  });

  const crumb = (
    <>
      <Link to="/projects" className="text-primary hover:text-primary/90">
        {t.projectCrumb}
      </Link>{" "}
      /{" "}
      <Link to="/projects/$key" params={{ key: project.key }} className="text-primary hover:text-primary/90">
        {project.name}
      </Link>{" "}
      / <span className="font-mono">{project.key}</span>
    </>
  );

  if (!canView)
    return (
      <>
        <PageHeader crumb={crumb} title={t.title} />
        <PageBody>
          <EmptyState icon={LockIcon} title={t.noViewTitle} description={t.noView} />
        </PageBody>
      </>
    );

  const sources = feed.data?.pages[0]?.sources ?? [];
  const items = [...new Map((feed.data?.pages.flatMap((p) => p.items) ?? []).map((r) => [r.id, r])).values()];
  const missingToken = (jobId: string | null) =>
    jobId !== null && sources.some((s) => s.source === "jenkins" && s.jobId === jobId && s.hasMyToken === false);

  if (openRunId)
    return (
      <>
        <PageHeader crumb={crumb} title={t.title} />
        <CiRunDetailView
          projectId={project.id}
          runId={openRunId}
          canOperate={canOperate}
          tokenMissing={openRunId.startsWith("jenkins:") && missingToken(jenkinsJobOf(openRunId))}
          onBack={() => setOpenRunId(null)}
          onOpenRun={setOpenRunId}
        />
      </>
    );

  const filtered = source !== "all" || status !== "" || branch !== "";
  return (
    <>
      <PageHeader crumb={crumb} title={t.title} description={t.lead} />
      <PageBody>
        <div className="grid gap-5">
          <SourceNotices sources={sources} />
          <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
            <FilterChips
              label={t.filterSource}
              value={source}
              onChange={setSource}
              chips={[
                { key: "all", label: t.filterAll },
                ...SOURCES.map((s) => ({ key: s, label: CI_SOURCE_LABEL[s] })),
              ]}
            />
            <FilterFields
              branch={branchText}
              onBranch={setBranchText}
              status={status}
              onStatus={setStatus}
              labels={t}
            />
          </div>
          {feed.isPending ? (
            <TableSkeleton rows={5} columns={7} />
          ) : feed.isError ? (
            <LoadFailure error={feed.error} retry={() => feed.refetch()} />
          ) : items.length === 0 ? (
            <EmptyState
              icon={WorkflowIcon}
              title={filtered ? t.emptyFiltered : t.emptyTitle}
              description={filtered ? "" : t.empty}
            />
          ) : (
            <>
              <RunsTable items={items} onOpen={setOpenRunId} />
              {feed.hasNextPage && (
                <div className="flex justify-center">
                  <Button variant="outline" disabled={feed.isFetchingNextPage} onClick={() => feed.fetchNextPage()}>
                    {feed.isFetchingNextPage ? t.loadingMore : t.more}
                  </Button>
                </div>
              )}
            </>
          )}
          <JobsSection
            project={project}
            sources={sources}
            canOperate={canOperate}
            canSettings={canSettings}
            onOpenRun={setOpenRunId}
          />
        </div>
      </PageBody>
    </>
  );
}

function FilterFields({
  branch,
  onBranch,
  status,
  onStatus,
  labels: t,
}: {
  branch: string;
  onBranch: (v: string) => void;
  status: CiRunStatus | "";
  onStatus: (v: CiRunStatus | "") => void;
  labels: (typeof text)["vi"];
}) {
  const branchId = useId();
  const statusId = useId();
  return (
    <>
      <div className="grid gap-1">
        <label htmlFor={branchId} className="text-xs text-muted-foreground">
          {t.branchLabel}
        </label>
        <Input
          id={branchId}
          className="w-full sm:w-48"
          placeholder={t.branchPlaceholder}
          value={branch}
          onChange={(e) => onBranch(e.target.value)}
        />
      </div>
      <div className="grid gap-1">
        <label htmlFor={statusId} className="text-xs text-muted-foreground">
          {t.statusLabel}
        </label>
        <NativeSelect
          id={statusId}
          className="w-full sm:w-44"
          value={status}
          onChange={(e) => onStatus(e.target.value as CiRunStatus | "")}
        >
          <NativeSelectOption value="">{t.statusAll}</NativeSelectOption>
          {ciRunStatus.options.map((s) => (
            <NativeSelectOption key={s} value={s}>
              {CI_STATUS_LABEL[s]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
    </>
  );
}

/** Nguồn đọc không được hay chưa đủ điều kiện: nói rõ vì sao, và dữ liệu cũ thì kèm giờ đọc lần cuối. */
function SourceNotices({ sources }: { sources: CiFeedSource[] }) {
  const t = useT(text);
  const bad = sources.filter((s) => s.state !== "ok" || s.stale);
  if (bad.length === 0) return null;
  return (
    <ul className="grid gap-2" aria-label={t.sources}>
      {bad.map((s) => (
        <li key={`${s.source}:${s.jobId ?? s.connectionId ?? s.label}`}>
          <Alert variant={s.state === "error" ? "destructive" : "default"} role="status" className="grid gap-1.5">
            <p className="text-sm font-medium">
              {s.label} · {CI_FEED_STATE_LABEL[s.state]}
            </p>
            {s.stale && (
              <p className="text-sm">{s.fetchedAt ? t.staleSince(formatDayTime(s.fetchedAt)) : t.staleNoTime}</p>
            )}
            {s.message && <p className="text-sm">{s.message}</p>}
            {s.state === "no_token" && (
              <Link
                to="/settings/jenkins-tokens"
                className={`${buttonVariants({ variant: "outline", size: "sm" })} w-fit`}
              >
                {t.addToken}
              </Link>
            )}
          </Alert>
        </li>
      ))}
    </ul>
  );
}

function RunsTable({ items, onOpen }: { items: CiRun[]; onOpen: (runId: string) => void }) {
  const t = useT(text);
  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
      <Table className="[&_td]:align-top" style={{ minWidth: 820 }}>
        <caption className="sr-only">{t.caption}</caption>
        <thead>
          <tr>
            <Th variant="plain">{t.colSource}</Th>
            <Th variant="plain">{t.colBranch}</Th>
            <Th variant="plain">{t.colCommit}</Th>
            <Th variant="plain">{t.colStatus}</Th>
            <Th variant="plain">{t.colDuration}</Th>
            <Th variant="plain">{t.colTrigger}</Th>
            <Th variant="plain">{t.colLink}</Th>
          </tr>
        </thead>
        <tbody>
          {items.map((run) => {
            const href = safeHref(run.url);
            return (
              <tr key={run.id}>
                <Td>
                  <div className="grid gap-0.5">
                    <span className="text-xs text-muted-foreground">{CI_SOURCE_LABEL[run.source]}</span>
                    <button
                      type="button"
                      aria-label={t.open(run.title)}
                      onClick={() => onOpen(run.id)}
                      className="cursor-pointer text-left text-sm font-medium text-primary hover:text-primary/90"
                    >
                      {run.title}
                    </button>
                  </div>
                </Td>
                <Td className="max-w-48 font-mono text-xs break-all">{run.branch ?? "—"}</Td>
                <Td className="font-mono text-xs">{run.sha ? run.sha.slice(0, 8) : "—"}</Td>
                <Td>
                  <Pill tone={CI_STATUS_TONE[run.status]} dot title={run.rawStatus}>
                    {CI_STATUS_LABEL[run.status]}
                  </Pill>
                </Td>
                <Td className="whitespace-nowrap text-sm">
                  <Duration run={run} />
                </Td>
                <Td className="text-sm">{run.triggeredBy ?? "—"}</Td>
                <Td>
                  {href ? (
                    <a
                      href={href}
                      target="_blank"
                      rel="noreferrer noopener"
                      aria-label={t.openOriginOf(run.title)}
                      className="inline-flex items-center gap-1 text-sm text-primary hover:text-primary/90"
                    >
                      {t.openOrigin}
                      <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
                    </a>
                  ) : (
                    "—"
                  )}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </div>
  );
}

function Duration({ run }: { run: CiRun }) {
  if (run.durationSec !== null) return <>{formatDuration(run.durationSec * 1000)}</>;
  return <>{isCiActive(run.status) && run.startedAt ? "…" : "—"}</>;
}

type JobDialog = { kind: "attach" } | { kind: "build"; job: CiProjectJob } | { kind: "detach"; job: CiProjectJob };

function JobsSection({
  project,
  sources,
  canOperate,
  canSettings,
  onOpenRun,
}: {
  project: Project;
  sources: CiFeedSource[];
  canOperate: boolean;
  canSettings: boolean;
  onOpenRun: (runId: string) => void;
}) {
  const { api } = useOrg();
  const t = useT(text);
  const [dialog, setDialog] = useState<JobDialog | null>(null);
  const jobs = useQuery(api.ciJobs.list.queryOptions({ input: { projectId: project.id } }));
  const reasonId = useId();
  const list = jobs.data ?? [];
  const noToken = (job: CiProjectJob) =>
    sources.some((s) => s.source === "jenkins" && s.jobId === job.id && s.hasMyToken === false);
  const anyNoToken = list.some(noToken);
  const close = () => setDialog(null);

  return (
    <section aria-labelledby={`${reasonId}-h`} className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={`${reasonId}-h`} className="min-w-0 flex-1 text-base font-semibold">
          {t.jobs}
        </h2>
        {canSettings && (
          <Button variant="outline" size="sm" onClick={() => setDialog({ kind: "attach" })}>
            {t.attach}
          </Button>
        )}
      </div>
      {jobs.isPending ? (
        <LoadingState />
      ) : jobs.isError ? (
        <LoadFailure error={jobs.error} retry={() => jobs.refetch()} />
      ) : list.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.jobsEmpty}</p>
      ) : (
        <ul className="grid gap-1.5">
          {list.map((job) => {
            const blocked = noToken(job);
            const href = safeHref(job.url);
            return (
              <li
                key={job.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-border px-3 py-2"
              >
                <div className="min-w-0 flex-1 basis-56">
                  <p className="font-mono text-sm break-all">{job.jobPath}</p>
                  <p className="text-xs text-muted-foreground">
                    {job.connectionName}
                    {blocked ? ` · ${t.myNoToken}` : ""}
                  </p>
                </div>
                {href && (
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer noopener"
                    aria-label={t.openOriginOf(job.jobPath)}
                    className="inline-flex items-center gap-1 text-sm text-primary hover:text-primary/90"
                  >
                    {t.openOrigin}
                    <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
                  </a>
                )}
                {canOperate && (
                  <Button
                    size="sm"
                    aria-label={t.build(job.jobPath)}
                    disabled={blocked}
                    aria-describedby={blocked ? reasonId : undefined}
                    onClick={() => setDialog({ kind: "build", job })}
                  >
                    Build
                  </Button>
                )}
                {canSettings && (
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={t.detach(job.jobPath)}
                    onClick={() => setDialog({ kind: "detach", job })}
                  >
                    {t.detachShort}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {canOperate && anyNoToken && <NoTokenReason id={reasonId} reason={t.noTokenReason} link={t.noTokenLink} />}

      <Dialog open={dialog?.kind === "attach"} onOpenChange={(open) => !open && close()}>
        <DialogContent>
          {dialog?.kind === "attach" && <AttachForm projectId={project.id} onDone={close} />}
        </DialogContent>
      </Dialog>
      <Dialog open={dialog?.kind === "build"} onOpenChange={(open) => !open && close()}>
        <DialogContent>
          {dialog?.kind === "build" && (
            <BuildForm
              projectId={project.id}
              job={dialog.job}
              onDone={close}
              onStarted={(runId) => {
                close();
                if (runId) onOpenRun(runId);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={dialog?.kind === "detach"} onOpenChange={(open) => !open && close()}>
        <DialogContent>
          {dialog?.kind === "detach" && <DetachForm projectId={project.id} job={dialog.job} onDone={close} />}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function AttachForm({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const { api } = useOrg();
  const t = useT(text);
  const queryClient = useQueryClient();
  const connections = useQuery(api.ciConnections.list.queryOptions({ input: {} }));
  const [connectionId, setConnectionId] = useState("");
  const [jobPath, setJobPath] = useState("");
  const [error, setError] = useState<{ field?: string; message: string } | null>(null);
  const add = useMutation({
    mutationFn: () => api.ciJobs.add.call({ projectId, connectionId, jobPath }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: api.ciJobs.key() }),
        queryClient.invalidateQueries({ queryKey: api.ci.key() }),
      ]);
      onDone();
    },
    onError: (e) => setError(formError(e, {})),
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    add.mutate();
  }
  const none = connections.isSuccess && connections.data.length === 0;
  return (
    <form onSubmit={submit} noValidate className="grid gap-3.5">
      <DialogTitle>{t.attachTitle}</DialogTitle>
      <DialogDescription>{t.attachLead}</DialogDescription>
      {none && <Alert>{t.noConnections}</Alert>}
      {connections.isError && <Alert variant="destructive">{apiErrorMessage(connections.error)}</Alert>}
      <Field>
        <FieldLabel>{t.fConnection}</FieldLabel>
        <NativeSelect
          aria-label={t.fConnection}
          value={connectionId}
          onChange={(e) => setConnectionId(e.target.value)}
          disabled={none}
        >
          <NativeSelectOption value="">{t.fConnectionPick}</NativeSelectOption>
          {(connections.data ?? []).map((c) => (
            <NativeSelectOption key={c.id} value={c.id}>
              {c.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      <Field invalid={error?.field === "jobPath"}>
        <FieldLabel>{t.fJob}</FieldLabel>
        <Input
          value={jobPath}
          onChange={(e) => setJobPath(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder="his-portal/build-dev"
        />
        {error?.field === "jobPath" && <FieldError>{error.message}</FieldError>}
      </Field>
      {error && error.field !== "jobPath" && <Alert variant="destructive">{error.message}</Alert>}
      <DialogActions>
        <Button type="button" variant="outline" onClick={onDone}>
          {t.cancel}
        </Button>
        <Button type="submit" disabled={add.isPending || !connectionId || !jobPath.trim()}>
          {add.isPending ? t.saving : t.save}
        </Button>
      </DialogActions>
    </form>
  );
}

function BuildForm({
  projectId,
  job,
  onDone,
  onStarted,
}: {
  projectId: string;
  job: CiProjectJob;
  onDone: () => void;
  onStarted: (runId: string | null) => void;
}) {
  const { api } = useOrg();
  const t = useT(text);
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const params = useQuery(api.ci.jenkinsParams.queryOptions({ input: { projectId, jobId: job.id } }));
  const build = useMutation({
    mutationFn: (values: Record<string, string | boolean>) =>
      api.ci.build.call({ projectId, jobId: job.id, params: values }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: api.ci.key() });
      onStarted(result.runId);
    },
    onError: (e) => setError(apiErrorMessage(e)),
  });
  return (
    <div className="grid gap-3.5">
      <DialogTitle>{t.buildTitle(job.jobPath)}</DialogTitle>
      <DialogDescription>{t.buildLead}</DialogDescription>
      {params.isPending ? (
        <LoadingState />
      ) : params.isError ? (
        <LoadFailure error={params.error} retry={() => params.refetch()} />
      ) : (
        <JenkinsParamsForm
          params={params.data.parameters}
          pending={build.isPending}
          error={error}
          onCancel={onDone}
          onSubmit={(values) => {
            setError(null);
            build.mutate(values);
          }}
        />
      )}
    </div>
  );
}

function DetachForm({ projectId, job, onDone }: { projectId: string; job: CiProjectJob; onDone: () => void }) {
  const { api } = useOrg();
  const t = useT(text);
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: () => api.ciJobs.remove.call({ projectId, jobId: job.id }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: api.ciJobs.key() }),
        queryClient.invalidateQueries({ queryKey: api.ci.key() }),
      ]);
      onDone();
    },
    onError: (e) => setError(apiErrorMessage(e)),
  });
  return (
    <div className="grid gap-3.5">
      <DialogTitle>{t.detachTitle(job.jobPath)}</DialogTitle>
      <DialogDescription>{t.detachLead}</DialogDescription>
      {error && <Alert variant="destructive">{error}</Alert>}
      <DialogActions>
        <Button variant="outline" onClick={onDone}>
          {t.cancel}
        </Button>
        <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
          {remove.isPending ? t.detaching : t.detachConfirm}
        </Button>
      </DialogActions>
    </div>
  );
}
