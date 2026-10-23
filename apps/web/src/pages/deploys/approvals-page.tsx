import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { Deploy } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { Pill } from "@xdev-hive/ui/pill";
import { Textarea } from "@xdev-hive/ui/textarea";
import { ClipboardCheckIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { DeployCompare } from "@/components/deploy-compare.tsx";
import { Card } from "@/components/ui/card.tsx";
import { Field, FieldError, FieldHint, FieldLabel } from "@/components/ui/field.tsx";
import { EmptyState, LoadFailure, TableSkeleton } from "@/components/ui/query-state.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { DEPLOY_METHOD_LABEL } from "@/lib/delivery-text.ts";
import { formatAgo, formatDayTime } from "@/lib/format.ts";
import { useNow } from "@/lib/use-now.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";
import { deployActor, VersionLines } from "./deploy-view.tsx";

const VI = {
  title: "Duyệt triển khai",
  lead: "Lần triển khai đang chờ bạn duyệt. Đủ người duyệt thì hub giao cho máy chạy deploy của đội.",
  loading: "Đang tải lần chờ duyệt",
  emptyTitle: "Không có lần nào chờ bạn duyệt",
  empty: "Lần triển khai lên môi trường cần duyệt sẽ hiện ở đây. Bạn không duyệt được lần do chính mình yêu cầu.",
  requested: (who: string, ago: string) => `${who} yêu cầu ${ago}`,
  progress: (done: number, required: number) => `${done}/${required} lượt duyệt`,
  expires: (at: string) => `Hết hạn lúc ${at}`,
  open: "Xem chi tiết",
  approve: "Duyệt",
  reject: "Từ chối",
  approveOf: (name: string) => `Duyệt ${name}`,
  rejectOf: (name: string) => `Từ chối ${name}`,
  approveTitle: (name: string) => `Duyệt ${name}?`,
  approveLead: "Đủ người duyệt thì lần triển khai bắt đầu ngay.",
  rejectTitle: (name: string) => `Từ chối ${name}?`,
  rejectLead: "Lần triển khai dừng hẳn. Người yêu cầu thấy lý do bạn ghi.",
  comment: "Ghi chú",
  commentHint: "Không bắt buộc.",
  reason: "Lý do",
  reasonRequired: "Ghi lý do từ chối.",
  cancel: "Huỷ",
  saving: "Đang gửi…",
};

type Decision = { deploy: Deploy; name: string; kind: "approve" | "reject" };

/** /deploy-approvals: lần triển khai chờ người đang đăng nhập duyệt (specs/032, specs/020 T028). */
export function DeployApprovalsPage() {
  const { api } = useOrg();
  const now = useNow(60_000);
  const pending = useQuery(api.deploys.approvals.pending.queryOptions({ input: {} }));
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const systemIds = [...new Set((pending.data ?? []).map((d) => d.systemId))];
  const envs = useQueries({
    queries: systemIds.map((systemId) => api.environments.list.queryOptions({ input: { systemId } })),
  });
  const [decision, setDecision] = useState<Decision | null>(null);

  const projectName = new Map((projects.data ?? []).map((p) => [p.id, p.name]));
  const envName = new Map(envs.flatMap((q) => q.data ?? []).map((e) => [e.id, e.name]));
  const titleOf = (d: Deploy) => `${projectName.get(d.projectId) ?? "—"} → ${envName.get(d.environmentId) ?? "—"}`;

  return (
    <>
      <PageHeader title={VI.title} description={VI.lead} />
      <PageBody>
        {pending.isPending ? (
          <TableSkeleton label={VI.loading} rows={3} columns={3} />
        ) : pending.isError ? (
          <LoadFailure error={pending.error} retry={pending.refetch} />
        ) : pending.data.length === 0 ? (
          <EmptyState icon={ClipboardCheckIcon} title={VI.emptyTitle} description={VI.empty} />
        ) : (
          <ul aria-label={VI.title} className="grid gap-3">
            {pending.data.map((d) => {
              const name = titleOf(d);
              const approved = d.approval?.decisions.filter((x) => x.decision === "approve").length ?? 0;
              return (
                <li key={d.id}>
                  <Card>
                    <article aria-label={name} className="grid gap-2.5 px-5 py-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="grid min-w-0 gap-1">
                          <h2 className="text-base font-semibold text-foreground">{name}</h2>
                          <p className="text-xs text-muted-foreground">
                            {VI.requested(deployActor(d), formatAgo(d.createdAt, now))}
                            {" · "}
                            {DEPLOY_METHOD_LABEL[d.method]}
                          </p>
                        </div>
                        <span className="inline-flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={VI.rejectOf(name)}
                            onClick={() => setDecision({ deploy: d, name, kind: "reject" })}
                          >
                            {VI.reject}
                          </Button>
                          <Button
                            variant="default"
                            size="sm"
                            aria-label={VI.approveOf(name)}
                            onClick={() => setDecision({ deploy: d, name, kind: "approve" })}
                          >
                            {VI.approve}
                          </Button>
                        </span>
                      </div>
                      <VersionLines version={d.version} />
                      <DeployCompare deployId={d.id} />
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        {d.approval && (
                          <>
                            <Pill tone="warn" small>
                              {VI.progress(approved, d.approval.required)}
                            </Pill>
                            <span>{VI.expires(formatDayTime(d.approval.expiresAt))}</span>
                          </>
                        )}
                        <Link to="/deploys/$id" params={{ id: d.id }} className="text-primary hover:text-primary/90">
                          {VI.open}
                        </Link>
                      </div>
                    </article>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </PageBody>
      <Dialog open={decision !== null} onOpenChange={(open) => !open && setDecision(null)}>
        <DialogContent>
          {decision && <DecisionForm decision={decision} onDone={() => setDecision(null)} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

function DecisionForm({ decision, onDone }: { decision: Decision; onDone: () => void }) {
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const approve = decision.kind === "approve";

  const send = useMutation({
    mutationFn: () => {
      const id = decision.deploy.id;
      const note = text.trim();
      return approve
        ? api.deploys.approvals.approve.call({ id, ...(note ? { comment: note } : {}) })
        : api.deploys.approvals.reject.call({ id, reason: note });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: api.deploys.approvals.pending.key() }),
        queryClient.invalidateQueries({ queryKey: api.deploys.get.key({ input: { id: decision.deploy.id } }) }),
      ]);
      onDone();
    },
    // Lần đã được người khác quyết hay đã hết hạn: tải lại danh sách để nó biến mất.
    onError: (err) => {
      setFailure(apiErrorMessage(err));
      void queryClient.invalidateQueries({ queryKey: api.deploys.approvals.pending.key() });
    },
  });

  function onSubmit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    setFailure(null);
    if (!approve && text.trim() === "") {
      setError(VI.reasonRequired);
      return;
    }
    setError(null);
    send.mutate();
  }

  const busy = send.isPending;
  return (
    <form noValidate onSubmit={onSubmit} className="grid gap-3.5">
      <DialogTitle>{(approve ? VI.approveTitle : VI.rejectTitle)(decision.name)}</DialogTitle>
      <DialogDescription>{approve ? VI.approveLead : VI.rejectLead}</DialogDescription>
      <Field invalid={error !== null}>
        <FieldLabel>{approve ? VI.comment : VI.reason}</FieldLabel>
        <Textarea
          aria-label={approve ? VI.comment : VI.reason}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          maxLength={1000}
          disabled={busy}
        />
        {error ? <FieldError>{error}</FieldError> : approve && <FieldHint>{VI.commentHint}</FieldHint>}
      </Field>
      {failure && <Alert variant="destructive">{failure}</Alert>}
      <DialogActions>
        <Button variant="outline" onClick={onDone}>
          {VI.cancel}
        </Button>
        <Button type="submit" variant={approve ? "default" : "destructive"} disabled={busy}>
          {busy ? VI.saving : approve ? VI.approve : VI.reject}
        </Button>
      </DialogActions>
    </form>
  );
}
