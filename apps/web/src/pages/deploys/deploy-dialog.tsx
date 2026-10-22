import { ORPCError } from "@orpc/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { DeployCreateInput, DeployTarget } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { Input } from "@xdev-hive/ui/input";
import { Textarea } from "@xdev-hive/ui/textarea";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { Field, FieldError, FieldHint, FieldLabel } from "@/components/ui/field.tsx";
import { LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { deliveryErrorLabel } from "@/lib/delivery-text.ts";
import { formatDayTime } from "@/lib/format.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { useOrg } from "@/shell/org-context.ts";

type VersionKind = "commit" | "tag" | "image" | "fromEnv";

const text: Dict<{
  title: (project: string, env: string) => string;
  lead: string;
  how: string;
  kind: Record<VersionKind, string>;
  commitSha: string;
  commitHint: (branch: string | null) => string;
  commitPlaceholder: string;
  tag: string;
  tagHint: string;
  image: string;
  imageHint: (template: string) => string;
  fromEnvHint: string;
  skipBackup: string;
  skipReason: string;
  skipReasonHint: string;
  cancel: string;
  submit: string;
  submitting: string;
  badSha: string;
  needTag: string;
  needImage: string;
  needReason: string;
  inProgress: (by: string | null, since: string | null) => string;
  openRunning: string;
  locked: (reason: string | null) => string;
  noToken: string;
  openTokens: string;
  noOptions: string;
}> = {
  vi: {
    title: (project, env) => `Triển khai ${project} lên ${env}`,
    lead: "Hub chạy theo cấu hình của đích. Mỗi đích chỉ chạy một lần tại một thời điểm.",
    how: "Phiên bản",
    kind: { commit: "Commit", tag: "Tag", image: "Image", fromEnv: "Đẩy từ môi trường khác" },
    commitSha: "Commit SHA",
    commitHint: (branch) =>
      `Để trống là commit mới nhất của nhánh ${branch ?? "mặc định của repo"}. Nhập SHA (7 ký tự trở lên) để chọn commit khác.`,
    commitPlaceholder: "Commit mới nhất…",
    tag: "Tag",
    tagHint: "Tên tag git, ví dụ v1.4.2.",
    image: "Tag image",
    imageHint: (template) => `Điền vào chỗ {{tag}} của ${template}.`,
    fromEnvHint: "Lấy đúng bản đang chạy ở môi trường nguồn của đích này; không cần chọn thêm.",
    skipBackup: "Bỏ qua sao lưu lần này",
    skipReason: "Lý do bỏ qua sao lưu",
    skipReasonHint: "Ghi vào nhật ký kiểm toán cùng tên người triển khai.",
    cancel: "Không triển khai",
    submit: "Triển khai",
    submitting: "Đang gửi…",
    badSha: "Commit SHA gồm 7 đến 64 ký tự 0-9 và a-f.",
    needTag: "Nhập tag.",
    needImage: "Nhập tag image.",
    needReason: "Ghi lý do bỏ qua sao lưu.",
    inProgress: (by, since) =>
      `Đích này đang có một lần triển khai chưa xong${by ? `, do ${by} bắt đầu` : ""}${since ? ` lúc ${since}` : ""}. Đợi lần đó xong hoặc huỷ nó rồi triển khai lại.`,
    openRunning: "Xem lần đang chạy",
    locked: (reason) =>
      `Môi trường đang khoá${reason ? ` (${reason})` : ""}. Nhờ người quản lý môi trường mở khoá rồi triển khai lại.`,
    noToken: "Bạn chưa có token Jenkins cho kết nối này, nên hub chưa thể chạy job thay bạn. Thêm token rồi thử lại.",
    openTokens: "Thêm token Jenkins",
    noOptions: "Đích này chưa có cách chọn phiên bản. Kiểm lại cấu hình đích.",
  },
  en: {
    title: (project, env) => `Deploy ${project} to ${env}`,
    lead: "The hub runs the target's configuration. Each target runs one deployment at a time.",
    how: "Version",
    kind: { commit: "Commit", tag: "Tag", image: "Image", fromEnv: "Promote from another environment" },
    commitSha: "Commit SHA",
    commitHint: (branch) =>
      `Leave empty for the latest commit of ${branch ?? "the repo's default branch"}. Enter a SHA (7+ characters) for another commit.`,
    commitPlaceholder: "Latest commit…",
    tag: "Tag",
    tagHint: "A git tag name, e.g. v1.4.2.",
    image: "Image tag",
    imageHint: (template) => `Fills the {{tag}} part of ${template}.`,
    fromEnvHint: "Takes the version running in this target's source environment; nothing else to choose.",
    skipBackup: "Skip the backup this time",
    skipReason: "Reason for skipping the backup",
    skipReasonHint: "Recorded in the audit log with your name.",
    cancel: "Don't deploy",
    submit: "Deploy",
    submitting: "Sending…",
    badSha: "A commit SHA is 7 to 64 characters of 0-9 and a-f.",
    needTag: "Enter a tag.",
    needImage: "Enter an image tag.",
    needReason: "Give a reason for skipping the backup.",
    inProgress: (by, since) =>
      `This target already has an unfinished deployment${by ? `, started by ${by}` : ""}${since ? ` at ${since}` : ""}. Wait for it to finish or cancel it, then deploy again.`,
    openRunning: "View the running deployment",
    locked: (reason) =>
      `The environment is locked${reason ? ` (${reason})` : ""}. Ask the environment owner to unlock it, then deploy again.`,
    noToken:
      "You don't have a Jenkins token for this connection, so the hub can't run the job for you. Add a token and try again.",
    openTokens: "Add a Jenkins token",
    noOptions: "This target has no way to choose a version. Check the target's configuration.",
  },
};

/** Cách chọn phiên bản mà từng cách triển khai nhận (plan.md mục 6); `fromEnv` chỉ khi đích Jenkins khai `promote`. */
export function versionKinds(target: Pick<DeployTarget, "method" | "config">): VersionKind[] {
  const { config } = target;
  switch (config.method) {
    case "ssh-script":
    case "gitlab-manual":
      return ["commit", "tag"];
    case "jenkins-job":
      return config.promote ? ["fromEnv"] : ["commit", "tag"];
    case "argocd":
      return ["commit", "tag", "image"];
    case "kubectl":
      return ["image"];
  }
}

function targetBranch(target: Pick<DeployTarget, "config">): string | null {
  return "branch" in target.config ? (target.config.branch ?? null) : null;
}

function canSkipBackup(target: Pick<DeployTarget, "config">): boolean {
  return target.config.method === "ssh-script" && target.config.steps.backup !== null;
}

interface Failure {
  title?: string | undefined;
  message: string;
  action?: ReactNode;
}

/** Mã lỗi nghiệp vụ của hub (`data.code`) thành một câu nói rõ người dùng làm gì tiếp. */
function describeFailure(error: unknown, t: (typeof text)["vi"]): Failure {
  const data: unknown = error instanceof ORPCError ? error.data : undefined;
  const record = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
  const by = (record.by as { name?: string } | null | undefined)?.name ?? null;
  const since = typeof record.since === "string" ? formatDayTime(record.since) : null;
  const title = deliveryErrorLabel(typeof record.code === "string" ? record.code : undefined);
  switch (record.code) {
    case "DEPLOY_IN_PROGRESS":
      return {
        title,
        message: t.inProgress(by, since),
        action:
          typeof record.deployId === "string" ? (
            <Link to="/deploys/$id" params={{ id: record.deployId }} className="text-primary hover:text-primary/90">
              {t.openRunning}
            </Link>
          ) : undefined,
      };
    case "ENV_LOCKED":
      return { title, message: t.locked(typeof record.reason === "string" ? record.reason : null) };
    case "JENKINS_NO_TOKEN":
      return {
        title,
        message: t.noToken,
        action: (
          <Link to="/settings/jenkins-tokens" className="text-primary hover:text-primary/90">
            {t.openTokens}
          </Link>
        ),
      };
    default:
      return { message: apiErrorMessage(error) };
  }
}

export interface DeployDialogTarget {
  id: string;
  projectName: string;
  environmentName: string;
}

/** Hộp thoại bấm Triển khai: chọn phiên bản theo cách của đích, tuỳ chọn bỏ qua sao lưu kèm lý do. */
export function DeployDialog({ target, onDone }: { target: DeployDialogTarget | null; onDone: () => void }) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onDone()}>
      <DialogContent>{target && <DeployForm key={target.id} target={target} onDone={onDone} />}</DialogContent>
    </Dialog>
  );
}

function DeployForm({ target, onDone }: { target: DeployDialogTarget; onDone: () => void }) {
  const t = useT(text);
  const { api } = useOrg();
  const detail = useQuery(api.deployTargets.get.queryOptions({ input: { id: target.id } }));
  return (
    <div className="grid gap-3.5">
      <DialogTitle>{t.title(target.projectName, target.environmentName)}</DialogTitle>
      <DialogDescription>{t.lead}</DialogDescription>
      {detail.isPending && <LoadingState />}
      {detail.isError && <LoadFailure error={detail.error} retry={() => void detail.refetch()} />}
      {detail.data && <VersionForm target={detail.data} onDone={onDone} />}
    </div>
  );
}

function VersionForm({ target, onDone }: { target: DeployTarget; onDone: () => void }) {
  const t = useT(text);
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const kinds = versionKinds(target);
  const branch = targetBranch(target);
  const skippable = canSkipBackup(target);
  const radioName = useId();
  const reasonId = useId();
  const [kind, setKind] = useState<VersionKind | undefined>(kinds[0]);
  const [sha, setSha] = useState("");
  const [tag, setTag] = useState("");
  const [image, setImage] = useState("");
  const [skip, setSkip] = useState(false);
  const [skipReason, setSkipReason] = useState("");
  const [errors, setErrors] = useState<Partial<Record<"sha" | "tag" | "image" | "reason", string>>>({});
  const [failure, setFailure] = useState<Failure | null>(null);

  const create = useMutation({
    mutationFn: (input: DeployCreateInput) => api.deploys.create.call(input),
    onSuccess: async (created) => {
      await Promise.all(
        [api.deploys.key(), api.deployTargets.key()].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
      onDone();
      void navigate({ to: "/deploys/$id", params: { id: created.id } });
    },
    onError: (e) => setFailure(describeFailure(e, t)),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!kind) return;
    const next: typeof errors = {};
    const trimmedSha = sha.trim().toLowerCase();
    if (kind === "commit" && trimmedSha && !/^[0-9a-f]{7,64}$/.test(trimmedSha)) next.sha = t.badSha;
    if (kind === "tag" && !tag.trim()) next.tag = t.needTag;
    if (kind === "image" && !image.trim()) next.image = t.needImage;
    if (skip && !skipReason.trim()) next.reason = t.needReason;
    setErrors(next);
    setFailure(null);
    if (Object.keys(next).length > 0) return;
    const version: DeployCreateInput["version"] =
      kind === "commit"
        ? trimmedSha
          ? { kind, sha: trimmedSha }
          : { kind }
        : kind === "tag"
          ? { kind, tag: tag.trim() }
          : kind === "image"
            ? { kind, tag: image.trim() }
            : { kind, environmentId: promoteSource(target) };
    create.mutate({
      targetId: target.id,
      version,
      ...(skip ? { skipBackup: { reason: skipReason.trim() } } : {}),
    });
  }

  if (!kind) return <Alert variant="destructive">{t.noOptions}</Alert>;
  const busy = create.isPending;
  return (
    <form noValidate onSubmit={submit} className="grid gap-3.5">
      {kinds.length > 1 && (
        <fieldset className="grid gap-1.5">
          <legend className="text-sm font-medium text-foreground">{t.how}</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {kinds.map((k) => (
              <label key={k} className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="radio"
                  name={radioName}
                  checked={kind === k}
                  onChange={() => setKind(k)}
                  disabled={busy}
                  className="size-4 accent-accent"
                />
                {t.kind[k]}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {kind === "commit" && (
        <Field invalid={!!errors.sha}>
          <FieldLabel>{t.commitSha}</FieldLabel>
          <Input
            name="commit"
            value={sha}
            onChange={(e) => setSha(e.target.value)}
            placeholder={t.commitPlaceholder}
            className="font-mono"
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
          />
          <FieldHint>{t.commitHint(branch)}</FieldHint>
          {errors.sha && <FieldError>{errors.sha}</FieldError>}
        </Field>
      )}
      {kind === "tag" && (
        <Field invalid={!!errors.tag}>
          <FieldLabel>{t.tag}</FieldLabel>
          <Input
            name="tag"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            className="font-mono"
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
          />
          <FieldHint>{t.tagHint}</FieldHint>
          {errors.tag && <FieldError>{errors.tag}</FieldError>}
        </Field>
      )}
      {kind === "image" && (
        <Field invalid={!!errors.image}>
          <FieldLabel>{t.image}</FieldLabel>
          <Input
            name="image"
            value={image}
            onChange={(e) => setImage(e.target.value)}
            className="font-mono"
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
          />
          {target.config.method === "kubectl" && <FieldHint>{t.imageHint(target.config.imageTemplate)}</FieldHint>}
          {errors.image && <FieldError>{errors.image}</FieldError>}
        </Field>
      )}
      {kind === "fromEnv" && <p className="text-sm text-muted-foreground">{t.fromEnvHint}</p>}
      {skippable && (
        <div className="grid gap-2">
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={skip}
              onChange={(e) => setSkip(e.target.checked)}
              disabled={busy}
              className="size-4 accent-accent"
            />
            {t.skipBackup}
          </label>
          {skip && (
            <Field invalid={!!errors.reason}>
              <FieldLabel htmlFor={reasonId}>{t.skipReason}</FieldLabel>
              <Textarea
                id={reasonId}
                name="skipReason"
                value={skipReason}
                onChange={(e) => setSkipReason(e.target.value)}
                rows={2}
                maxLength={500}
                disabled={busy}
              />
              <FieldHint>{t.skipReasonHint}</FieldHint>
              {errors.reason && <FieldError>{errors.reason}</FieldError>}
            </Field>
          )}
        </div>
      )}
      {failure && (
        <Alert variant="destructive" role="alert" className="grid gap-1">
          {failure.title && <strong className="font-semibold">{failure.title}</strong>}
          <span>{failure.message}</span>
          {failure.action}
        </Alert>
      )}
      <DialogActions>
        <Button variant="outline" onClick={onDone}>
          {t.cancel}
        </Button>
        <Button type="submit" variant="default" disabled={busy}>
          {busy ? t.submitting : t.submit}
        </Button>
      </DialogActions>
    </form>
  );
}

/** Môi trường nguồn của "đẩy từ môi trường" do đích khai (`promote.fromEnvironmentId`); chỉ gọi với đích có `promote`. */
function promoteSource(target: DeployTarget): string {
  return target.config.method === "jenkins-job" && target.config.promote ? target.config.promote.fromEnvironmentId : "";
}
