import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import type { MergeQueueEntry, Project } from "@xdev-hive/contracts";
import { useState } from "react";
import { Alert } from "../components/ui/alert.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "../components/ui/dialog.tsx";
import { Pill } from "../components/ui/pill.tsx";
import { EmptyState, LoadFailure, LoadingState } from "../components/ui/query-state.tsx";
import { apiErrorMessage } from "../lib/api-errors.ts";
import { formatDay } from "../lib/format.ts";
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
} from "../lib/merge-queue.ts";
import { isOrgAdmin } from "../lib/roles.ts";
import { useMe } from "../shell/me-context.ts";
import { useOrg } from "../shell/org-context.ts";
import { PageBody, PageHeader } from "../shell/page-header.tsx";

export function MergeQueuePage() {
  const { org } = useOrg();
  const { key } = useParams({ from: "/session/app/in-org/projects/$key/merge-queue" });
  return <ProjectQueue key={`${org.id}:${key}`} projectKey={key} />;
}

function ProjectQueue({ projectKey }: { projectKey: string }) {
  const { api } = useOrg();
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const project = projects.data?.find((item) => item.key === projectKey);
  return (
    <>
      <PageHeader crumb={project?.name ?? projectKey} title="Hàng merge" />
      <PageBody>
        {projects.isPending ? (
          <LoadingState label="Đang tải dự án…" />
        ) : projects.isError ? (
          <LoadFailure error={projects.error} retry={projects.refetch} />
        ) : !project ? (
          <EmptyState
            title="Không tìm thấy dự án"
            description="Kiểm tra đường dẫn hoặc nhờ quản trị cấp quyền vào dự án."
          />
        ) : !project.settings.features.mergeQueue ? (
          <EmptyState
            title="Dự án chưa bật hàng merge"
            description="Nhờ quản trị đội bật Hàng merge trong cấu hình tính năng của dự án. Khi bật, các PR sẽ được kiểm tra và merge lần lượt."
          />
        ) : (
          <Queue project={project} />
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
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted">PR được xử lý theo thứ tự, từng mục một. Danh sách tự cập nhật mỗi 10 giây.</p>
        <Button size="sm" onClick={() => queue.refetch()} disabled={queue.isFetching}>
          Làm mới
        </Button>
      </div>
      {notice && (
        <p role="status" className="text-ok">
          {notice}
        </p>
      )}
      {members.isError && !isOrgAdmin(org.role) && <LoadFailure error={members.error} retry={members.refetch} />}
      {queue.isPending ? (
        <LoadingState label="Đang tải hàng merge…" />
      ) : queue.isError ? (
        <LoadFailure error={queue.error} retry={queue.refetch} />
      ) : (
        <>
          <QueueSection
            title="Đang trong hàng"
            entries={active}
            manage={manage}
            confirm={confirm}
            empty="Chưa có PR nào trong hàng. PR đạt chính sách kết quả sẽ vào hàng theo cấu hình dự án."
          />
          <QueueSection
            title="Đã xong gần đây"
            entries={finished}
            manage={manage}
            confirm={confirm}
            empty="Chưa có PR nào được xử lý. Các mục đã xong sẽ xuất hiện ở đây."
          />
        </>
      )}
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
          {mutation.isError && <Alert>{apiErrorMessage(mutation.error)}</Alert>}
          <DialogActions>
            <Button onClick={() => setAction(null)} disabled={mutation.isPending}>
              Huỷ
            </Button>
            <Button
              variant={action?.kind === "remove" ? "danger" : "primary"}
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
  empty,
}: {
  title: string;
  entries: MergeQueueEntry[];
  manage: boolean;
  confirm: (action: QueueAction) => void;
  empty: string;
}) {
  return (
    <section aria-label={title} className="grid gap-3">
      <h2 className="text-lg font-semibold text-ink">
        {title} <span className="text-muted">({entries.length})</span>
      </h2>
      {entries.length === 0 ? (
        <Card className="p-4 text-muted">{empty}</Card>
      ) : (
        <Card>
          <ol className="divide-y divide-line">
            {entries.map((entry) => {
              const url = externalUrl(entry.prUrl);
              return (
                <li
                  key={entry.id}
                  className="grid min-w-0 gap-3 p-4 hover:bg-subtle app:grid-cols-[minmax(0,1fr)_auto]"
                >
                  <div className="grid min-w-0 gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      {entry.position !== null && (
                        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-sunken font-mono text-sm tabular-nums">
                          <span className="sr-only">Vị trí </span>
                          {entry.position}
                        </span>
                      )}
                      {url ? (
                        <a
                          href={url}
                          target="_blank"
                          rel="noreferrer"
                          className="font-semibold text-accent underline underline-offset-2"
                        >
                          PR #{entry.prNumber}
                          <span className="sr-only"> (mở tab mới)</span>
                        </a>
                      ) : (
                        <b className="text-ink">PR #{entry.prNumber}</b>
                      )}
                      <Pill tone={MERGE_STATE_TONE[entry.state]}>
                        <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
                        {MERGE_STATE_LABEL[entry.state]}
                      </Pill>
                      <Pill tone={entry.ciState ? MERGE_CI_TONE[entry.ciState] : "neutral"}>
                        {entry.ciState ? MERGE_CI_LABEL[entry.ciState] : "CI chưa kiểm tra"}
                      </Pill>
                    </div>
                    {entry.branch && <code className="break-all text-sm text-muted">{entry.branch}</code>}
                    {entry.note && (
                      <p className={entry.state === "failed" ? "break-words text-bad" : "break-words text-muted"}>
                        {entry.note}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                      {url && (
                        <a
                          href={url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-accent underline underline-offset-2"
                        >
                          Xem CI trên PR<span className="sr-only"> (mở tab mới)</span>
                        </a>
                      )}
                      <span>
                        {entry.finishedAt
                          ? `Hoàn tất ${formatDay(entry.finishedAt)}`
                          : `Vào hàng ${formatDay(entry.createdAt)}`}
                      </span>
                    </div>
                    {entry.mergeSha && (
                      <p className="min-w-0 text-xs text-muted">
                        Commit merge: <code className="break-all text-ink">{entry.mergeSha}</code>
                      </p>
                    )}
                  </div>
                  {manage && (
                    <div className="flex flex-wrap items-start gap-2">
                      {canRemoveMerge(entry.state) && (
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => confirm({ kind: "remove", entry })}
                          aria-label={`Đưa PR #${entry.prNumber} ra khỏi hàng`}
                        >
                          Đưa ra khỏi hàng
                        </Button>
                      )}
                      {canRetryMerge(entry.state) && (
                        <Button
                          size="sm"
                          onClick={() => confirm({ kind: "retry", entry })}
                          aria-label={`Đưa lại PR #${entry.prNumber} vào hàng`}
                        >
                          {entry.state === "failed" ? "Thử lại" : "Đưa lại vào hàng"}
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </Card>
      )}
    </section>
  );
}
