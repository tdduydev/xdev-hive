import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { MergeQueueEntry, Project } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button, buttonVariants } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { Input } from "@xdev-hive/ui/input";
import { Pill } from "@xdev-hive/ui/pill";
import { Table, Td, Th } from "@xdev-hive/ui/table";
import { GitMergeIcon, SearchXIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { PageSection } from "@/components/page/page-section.tsx";
import { EmptyState, LoadFailure, SectionsSkeleton, TableSkeleton } from "@/components/ui/query-state.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { formatDay } from "@/lib/format.ts";
import {
  canManageMergeQueue,
  canRemoveMerge,
  canRetryMerge,
  externalUrl,
  MERGE_CI_LABEL,
  MERGE_CI_TONE,
  MERGE_STATE_LABEL,
  MERGE_STATE_TONE,
  splitMergeQueue,
} from "@/lib/merge-queue.ts";
import { isOrgAdmin } from "@/lib/roles.ts";
import { useMe } from "@/shell/me-context.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

export function MergeQueuePage() {
  const { org } = useOrg();
  const { key } = useParams({ from: "/session/app/in-org/projects/$key/merge-queue" });
  return <ProjectQueue key={`${org.id}:${key}`} projectKey={key} />;
}

const DESCRIPTION =
  "Merge lần lượt từ trên xuống; mục đầu được cập nhật theo nhánh chính và chờ CI. Tự làm mới mỗi 10 giây.";

/** Trang không có mục nav: tên trang làm tiêu đề, danh sách dự án và dự án cha là crumb có link. */
function QueueHeader({
  projectKey,
  project,
  meta,
  children,
}: {
  projectKey: string;
  project?: Project | undefined;
  meta?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <PageHeader
      title="Hàng merge"
      description={DESCRIPTION}
      meta={meta}
      crumb={
        <>
          <Link to="/projects" className="hover:text-foreground hover:underline">
            Dự án
          </Link>
          {" / "}
          <Link
            to="/projects/$key/settings"
            params={{ key: projectKey }}
            className="hover:text-foreground hover:underline"
          >
            {project?.name ?? projectKey}
          </Link>
        </>
      }
    >
      {children}
    </PageHeader>
  );
}

function ProjectQueue({ projectKey }: { projectKey: string }) {
  const { api } = useOrg();
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const project = projects.data?.find((item) => item.key === projectKey);
  if (project?.settings.features.mergeQueue) return <Queue project={project} />;
  return (
    <>
      <QueueHeader projectKey={projectKey} project={project} />
      <PageBody>
        {projects.isPending ? (
          <SectionsSkeleton sections={2} label="Đang tải dự án…" />
        ) : projects.isError ? (
          <LoadFailure error={projects.error} retry={projects.refetch} />
        ) : !project ? (
          <EmptyState
            icon={SearchXIcon}
            title="Không tìm thấy dự án"
            description="Kiểm tra đường dẫn hoặc nhờ quản trị cấp quyền vào dự án."
            action={
              <Link to="/projects" className={buttonVariants({ variant: "outline" })}>
                Về danh sách dự án
              </Link>
            }
          />
        ) : (
          <EmptyState
            icon={GitMergeIcon}
            title="Dự án chưa bật hàng merge"
            description="Nhờ quản trị đội bật Hàng merge trong cấu hình tính năng của dự án. Khi bật, các PR sẽ được kiểm tra và merge lần lượt."
            action={
              <Link
                to="/projects/$key/settings"
                params={{ key: project.key }}
                className={buttonVariants({ variant: "outline" })}
              >
                Mở cấu hình dự án
              </Link>
            }
          />
        )}
      </PageBody>
    </>
  );
}

type QueueAction = { kind: "remove" | "retry"; entry: MergeQueueEntry };

function Queue({ project }: { project: Project }) {
  const { org, api } = useOrg();
  const me = useMe();
  const queryClient = useQueryClient();
  const query = api.projects.mergeQueue.queryOptions({ input: { id: project.id }, refetchInterval: 10_000 });
  const queue = useQuery(query);
  const members = useQuery(
    api.teamMembers.list.queryOptions({ input: { teamId: project.teamId }, enabled: !isOrgAdmin(org.role) }),
  );
  const teamRole = members.data?.find((member) => member.userId === me.id)?.role;
  const manage = canManageMergeQueue(org.role, teamRole);
  const [action, setAction] = useState<QueueAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (next: QueueAction) =>
      next.kind === "remove"
        ? api.projects.removeMerge.call({ id: project.id, entryId: next.entry.id })
        : api.projects.enqueueMerge.call({ id: project.id, prNumber: next.entry.prNumber }),
    onSuccess: async (_, next) => {
      setAction(null);
      setNotice(
        next.kind === "remove"
          ? `Đã đưa PR #${next.entry.prNumber} ra khỏi hàng.`
          : `Đã đưa PR #${next.entry.prNumber} vào hàng.`,
      );
      await queryClient.invalidateQueries({ queryKey: query.queryKey });
    },
  });

  function confirm(next: QueueAction) {
    mutation.reset();
    setNotice(null);
    setAction(next);
  }

  const { active, finished } = splitMergeQueue(queue.data ?? []);
  const merge = project.settings.merge;
  const fact = (label: string, value: string) => (
    <span key={label}>
      {label}: <span className="font-medium text-foreground">{value}</span>
    </span>
  );
  return (
    <>
      <QueueHeader
        projectKey={project.key}
        project={project}
        meta={[
          fact("Chế độ", merge.mode === "auto" ? "Tự vào hàng khi run đạt" : "Cần người duyệt"),
          fact("Cách merge", { squash: "Squash", merge: "Merge commit", rebase: "Rebase" }[merge.method ?? "squash"]),
          fact("CI", merge.requireCi ? "Bắt buộc xanh" : "Cho phép kho không có CI"),
          fact(
            "Người duyệt",
            `${merge.requiredApprovals}, theo bảo vệ nhánh trên ${project.repo.kind === "github" ? "GitHub" : "GitLab"}`,
          ),
        ]}
      >
        <Button variant="outline" onClick={() => queue.refetch()} disabled={queue.isFetching}>
          Làm mới
        </Button>
      </QueueHeader>
      <PageBody>
        {manage && (
          <EnqueueForm project={project} onDone={() => queryClient.invalidateQueries({ queryKey: query.queryKey })} />
        )}
        {notice && (
          <p role="status" className="text-success">
            {notice}
          </p>
        )}
        {members.isError && !isOrgAdmin(org.role) && <LoadFailure error={members.error} retry={members.refetch} />}
        {queue.isPending ? (
          <TableSkeleton columns={4} label="Đang tải hàng merge…" />
        ) : queue.isError ? (
          <LoadFailure error={queue.error} retry={queue.refetch} />
        ) : (
          <>
            <QueueSection
              title="Đang trong hàng"
              entries={active}
              manage={manage}
              confirm={confirm}
              emptyTitle="Hàng đang trống"
              empty="Chưa có PR nào trong hàng. Nhập số PR ở trên hoặc chờ run đạt theo cấu hình dự án."
            />
            <QueueSection
              title="Đã xong gần đây"
              entries={finished}
              manage={manage}
              confirm={confirm}
              emptyTitle="Chưa có lịch sử"
              empty="Chưa có PR nào được xử lý. Các mục đã xong sẽ xuất hiện ở đây."
            />
          </>
        )}
      </PageBody>
      <Dialog
        open={action !== null}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) setAction(null);
        }}
      >
        <DialogContent>
          <DialogTitle>
            {action?.kind === "remove"
              ? `Đưa PR #${action.entry.prNumber} ra khỏi hàng?`
              : `Đưa lại PR #${action?.entry.prNumber} vào hàng?`}
          </DialogTitle>
          <DialogDescription>
            {action?.kind === "remove"
              ? "PR vẫn mở trên kho mã nguồn nhưng sẽ không được hàng merge xử lý."
              : "PR sẽ vào cuối hàng và được kiểm tra lại nhánh, CI và điều kiện duyệt."}
          </DialogDescription>
          {mutation.isError && <Alert variant="destructive">{apiErrorMessage(mutation.error)}</Alert>}
          <DialogActions>
            <Button variant="outline" onClick={() => setAction(null)} disabled={mutation.isPending}>
              Huỷ
            </Button>
            <Button
              variant={action?.kind === "remove" ? "destructive-solid" : "default"}
              disabled={mutation.isPending}
              onClick={() => action && mutation.mutate(action)}
            >
              {mutation.isPending ? "Đang xử lý…" : action?.kind === "remove" ? "Đưa ra khỏi hàng" : "Đưa vào hàng"}
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </>
  );
}

function QueueSection({
  title,
  entries,
  manage,
  confirm,
  emptyTitle,
  empty,
}: {
  title: string;
  entries: MergeQueueEntry[];
  manage: boolean;
  confirm: (action: QueueAction) => void;
  emptyTitle: string;
  empty: string;
}) {
  const ranked = entries.some((entry) => entry.position !== null);
  return (
    <PageSection title={title} description={`${entries.length} PR`}>
      {entries.length === 0 ? (
        <EmptyState compact icon={GitMergeIcon} title={emptyTitle} description={empty} />
      ) : (
        <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
          <Table aria-label={title} className="min-w-180">
            <thead>
              <tr>
                {ranked && <Th variant="plain">Vị trí</Th>}
                <Th variant="plain">PR</Th>
                <Th variant="plain">Trạng thái</Th>
                <Th variant="plain">Ghi chú</Th>
                {manage && (
                  <Th
                    variant="plain"
                    className="text-right sm:sticky sm:right-0 sm:shadow-[inset_1px_0_0_var(--border)]"
                  >
                    Thao tác
                  </Th>
                )}
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <QueueRow key={entry.id} entry={entry} ranked={ranked} manage={manage} confirm={confirm} />
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </PageSection>
  );
}

function QueueRow({
  entry,
  ranked,
  manage,
  confirm,
}: {
  entry: MergeQueueEntry;
  ranked: boolean;
  manage: boolean;
  confirm: (action: QueueAction) => void;
}) {
  const url = externalUrl(entry.prUrl);
  const work = entry.taskId ?? entry.runId;
  return (
    <tr className="border-b border-border last:border-b-0">
      {ranked && <Td className="w-16 tabular-nums">{entry.position ?? "—"}</Td>}
      <Td className="min-w-52 max-w-80">
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="font-mono font-semibold text-primary underline underline-offset-2"
          >
            PR #{entry.prNumber}
            <span className="sr-only"> (mở tab mới)</span>
          </a>
        ) : (
          <b className="text-foreground">PR #{entry.prNumber}</b>
        )}
        <p className="break-all font-mono text-xs text-muted-foreground">
          {entry.branch ?? "Chưa có nhánh"} · {entry.headSha?.slice(0, 7) ?? "—"}
        </p>
        {work && <p className="break-all font-mono text-xs text-muted-foreground">Việc / run: {work}</p>}
      </Td>
      <Td className="whitespace-nowrap">
        <div className="grid justify-items-start gap-1.5">
          <Pill tone={MERGE_STATE_TONE[entry.state]} dot>
            {MERGE_STATE_LABEL[entry.state]}
          </Pill>
          <Pill tone={entry.ciState ? MERGE_CI_TONE[entry.ciState] : "neutral"}>
            {entry.ciState ? MERGE_CI_LABEL[entry.ciState] : "CI chưa kiểm tra"}
          </Pill>
        </div>
      </Td>
      <Td className="min-w-40 max-w-65">
        {entry.note && (
          <p
            className={entry.state === "failed" ? "break-words text-destructive" : "break-words text-muted-foreground"}
          >
            {entry.note}
          </p>
        )}
        {entry.mergeSha && (
          <p className="text-xs text-muted-foreground">
            Commit merge: <code className="break-all text-foreground">{entry.mergeSha}</code>
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {entry.finishedAt ? `Hoàn tất ${formatDay(entry.finishedAt)}` : `Vào hàng ${formatDay(entry.createdAt)}`}
        </p>
      </Td>
      {manage && (
        // Ô ghim cần nền đặc, không thì chữ của cột cuộn bên dưới lộ ra ở màn rộng 640 px trở lên.
        <Td className="bg-card text-right whitespace-nowrap sm:sticky sm:right-0 sm:shadow-[inset_1px_0_0_var(--border)]">
          {canRemoveMerge(entry.state) && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => confirm({ kind: "remove", entry })}
            >
              Đưa<span className="sr-only"> PR #{entry.prNumber}</span> ra khỏi hàng
            </Button>
          )}
          {canRetryMerge(entry.state) && (
            <Button variant="outline" size="sm" onClick={() => confirm({ kind: "retry", entry })}>
              Đưa lại<span className="sr-only"> PR #{entry.prNumber}</span> vào hàng
            </Button>
          )}
        </Td>
      )}
    </tr>
  );
}

function EnqueueForm({ project, onDone }: { project: Project; onDone: () => Promise<unknown> }) {
  const { api } = useOrg();
  const id = useId();
  const [draft, setDraft] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const enqueue = useMutation({
    mutationFn: (prNumber: number) => api.projects.enqueueMerge.call({ id: project.id, prNumber }),
    onSuccess: async () => {
      setDraft("");
      await onDone();
    },
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    enqueue.reset();
    if (!/^\d+$/.test(draft) || !Number.isSafeInteger(Number(draft)) || Number(draft) < 1) {
      setFailure("Nhập số PR là số nguyên dương.");
      return;
    }
    setFailure(null);
    enqueue.mutate(Number(draft));
  }
  return (
    <form noValidate onSubmit={submit} className="grid min-w-0 gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid gap-1.5">
          <label htmlFor={id} className="text-sm font-medium text-foreground">
            Số PR
          </label>
          <Input
            id={id}
            inputMode="numeric"
            placeholder="Ví dụ 128"
            className="w-32"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={enqueue.isPending}
          />
        </div>
        <Button type="submit" variant="default" disabled={enqueue.isPending}>
          {enqueue.isPending ? "Đang đưa vào…" : "Đưa vào hàng"}
        </Button>
      </div>
      {failure && <Alert variant="destructive">{failure}</Alert>}
      {enqueue.isError && <Alert variant="destructive">{apiErrorMessage(enqueue.error)}</Alert>}
      {enqueue.isSuccess && (
        <p role="status" className="text-success">
          Đã đưa PR vào hàng.
        </p>
      )}
    </form>
  );
}
