import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import type { MergeQueueEntry, Project } from "@xdev-hive/contracts";
import { type FormEvent, useId, useState } from "react";
import { Alert } from "../components/ui/alert.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "../components/ui/dialog.tsx";
import { Input } from "../components/ui/input.tsx";
import { Pill } from "../components/ui/pill.tsx";
import { EmptyState, LoadFailure, LoadingState } from "../components/ui/query-state.tsx";
import { Table, Td, Th } from "../components/ui/table.tsx";
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
      <PageHeader crumb={`Dự án / ${project?.name ?? projectKey}`} title={project?.key ?? projectKey} />
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
      <nav aria-label="Mục của dự án" className="flex border-b border-border">
        <span aria-current="page" className="border-b-2 border-primary px-3 py-2 font-semibold text-foreground">
          Hàng merge
        </span>
      </nav>
      <Card className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-4 py-3.5">
        <dl className="flex min-w-0 flex-wrap gap-x-4 gap-y-2 text-sm">
          <div>
            <dt className="inline text-muted-foreground">Chế độ </dt>
            <dd className="inline font-medium text-foreground">
              {project.settings.merge.mode === "auto" ? "Tự vào hàng khi run đạt" : "Cần người duyệt"}
            </dd>
          </div>
          <div>
            <dt className="inline text-muted-foreground">Cách merge </dt>
            <dd className="inline font-medium text-foreground">
              {{ squash: "Squash", merge: "Merge commit", rebase: "Rebase" }[project.settings.merge.method ?? "squash"]}
            </dd>
          </div>
          <div>
            <dt className="inline text-muted-foreground">CI </dt>
            <dd className="inline font-medium text-foreground">
              {project.settings.merge.requireCi ? "Bắt buộc xanh" : "Cho phép kho không có CI"}
            </dd>
          </div>
          <div>
            <dt className="inline text-muted-foreground">Người duyệt </dt>
            <dd className="inline font-medium text-foreground">
              {project.settings.merge.requiredApprovals}, theo bảo vệ nhánh trên{" "}
              {project.repo.kind === "github" ? "GitHub" : "GitLab"}
            </dd>
          </div>
        </dl>
        {manage && (
          <EnqueueForm project={project} onDone={() => queryClient.invalidateQueries({ queryKey: query.queryKey })} />
        )}
      </Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Merge lần lượt từ trên xuống; mục đầu được cập nhật theo nhánh chính và chờ CI. Tự làm mới mỗi 10 giây.
        </p>
        <Button variant="outline" size="sm" onClick={() => queue.refetch()} disabled={queue.isFetching}>
          Làm mới
        </Button>
      </div>
      {notice && (
        <p role="status" className="text-success">
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
            empty="Chưa có PR nào trong hàng. Nhập số PR ở trên hoặc chờ run đạt theo cấu hình dự án."
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
          {mutation.isError && <Alert variant="destructive">{apiErrorMessage(mutation.error)}</Alert>}
          <DialogActions>
            <Button variant="outline" onClick={() => setAction(null)} disabled={mutation.isPending}>
              Huỷ
            </Button>
            <Button
              variant={action?.kind === "remove" ? "destructive" : "default"}
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
    <section aria-label={title} className="grid min-w-0 gap-3">
      <h2 className="text-base font-semibold text-foreground">
        {title} <span className="text-muted-foreground">({entries.length})</span>
      </h2>
      {entries.length === 0 ? (
        <Card className="p-4 text-muted-foreground">{empty}</Card>
      ) : (
        <Card className="relative min-w-0 overflow-hidden">
          <Table aria-label={title} className="min-w-215">
            <thead className="bg-muted">
              <tr>
                <Th>Vị trí</Th>
                <Th>PR</Th>
                <Th>Trạng thái</Th>
                <Th>Ghi chú</Th>
                <Th>Việc / Run</Th>
                <Th>Thao tác</Th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const url = externalUrl(entry.prUrl);
                return (
                  <tr key={entry.id} className="hover:bg-muted">
                    <Td className="font-heading text-xl font-semibold tabular-nums">{entry.position ?? "—"}</Td>
                    <Td className="min-w-65 max-w-85">
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
                    </Td>
                    <Td className="whitespace-nowrap">
                      <div className="grid justify-items-start gap-1.5">
                        <Pill tone={MERGE_STATE_TONE[entry.state]}>
                          <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
                          {MERGE_STATE_LABEL[entry.state]}
                        </Pill>
                        <Pill tone={entry.ciState ? MERGE_CI_TONE[entry.ciState] : "neutral"}>
                          {entry.ciState ? MERGE_CI_LABEL[entry.ciState] : "CI chưa kiểm tra"}
                        </Pill>
                        {url && (
                          <a href={url} target="_blank" rel="noreferrer" className="text-xs text-primary underline">
                            Xem CI trên PR<span className="sr-only"> (mở tab mới)</span>
                          </a>
                        )}
                      </div>
                    </Td>
                    <Td className="min-w-40 max-w-65">
                      {entry.note && (
                        <p
                          className={
                            entry.state === "failed"
                              ? "break-words text-destructive"
                              : "break-words text-muted-foreground"
                          }
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
                        {entry.finishedAt
                          ? `Hoàn tất ${formatDay(entry.finishedAt)}`
                          : `Vào hàng ${formatDay(entry.createdAt)}`}
                      </p>
                    </Td>
                    <Td className="max-w-50 break-all font-mono text-xs text-muted-foreground">
                      {entry.taskId ?? entry.runId ?? "—"}
                    </Td>
                    <Td>
                      {manage && (
                        <div className="flex flex-wrap items-start gap-2">
                          {canRemoveMerge(entry.state) && (
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={() => confirm({ kind: "remove", entry })}
                              aria-label={`Đưa PR #${entry.prNumber} ra khỏi hàng`}
                            >
                              Bỏ khỏi hàng
                            </Button>
                          )}
                          {canRetryMerge(entry.state) && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => confirm({ kind: "retry", entry })}
                              aria-label={`Đưa lại PR #${entry.prNumber} vào hàng`}
                            >
                              {entry.state === "failed" ? "Thử lại" : "Đưa lại vào hàng"}
                            </Button>
                          )}
                        </div>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}
    </section>
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
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={id} className="font-medium text-foreground">
          Số PR
        </label>
        <div className="w-22 shrink-0">
          <Input
            id={id}
            inputMode="numeric"
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
