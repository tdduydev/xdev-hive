import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { Project, ProjectSettings } from "@xdev-hive/contracts";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { Alert } from "../components/ui/alert.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "../components/ui/dialog.tsx";
import { Field, FieldError, FieldHint, FieldLabel } from "../components/ui/field.tsx";
import { Input } from "../components/ui/input.tsx";
import { Select } from "../components/ui/select.tsx";
import { Textarea } from "../components/ui/textarea.tsx";
import { apiErrorMessage } from "../lib/api-errors.ts";
import { cx } from "../lib/cx.ts";
import {
  buildPatch,
  type FieldErrors,
  formFromSettings,
  type PermissionMode,
  SETTINGS_CLIS,
  type SettingsForm,
  saveErrors,
} from "../lib/project-settings.ts";
import { teamRoleLookup } from "../lib/projects.ts";
import { CLI_LABEL } from "../lib/run-view.ts";
import { useMe } from "../shell/me-context.ts";
import { useOrg } from "../shell/org-context.ts";
import { PageBody, PageHeader } from "../shell/page-header.tsx";

const TITLE = "Cấu hình dự án";

/** /projects/$key/settings: merge, review chéo, plan mode, ngân sách, model, quyền CLI của run. */
export function ProjectSettingsPage() {
  const me = useMe();
  const { org, api } = useOrg();
  const { key } = useParams({ from: "/session/app/in-org/projects/$key/settings" });
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const members = useQuery(api.orgMembers.list.queryOptions());
  const project = projects.data?.find((p) => p.key === key);
  const crumb = <Crumb project={project} projectKey={key} />;

  let body: ReactNode;
  if (projects.isPending || (members.isPending && org.role === "member")) {
    body = (
      <p aria-busy="true" className="text-muted">
        Đang tải…
      </p>
    );
  } else if (projects.isError || !project) {
    body = (
      <>
        <Alert>
          {projects.isError
            ? apiErrorMessage(projects.error)
            : `Không tìm thấy dự án ${key}, hoặc bạn không ở trong đội sở hữu dự án.`}
        </Alert>
        <Link to="/projects" className="text-accent hover:text-accent-hover">
          Về danh sách dự án
        </Link>
      </>
    );
  } else {
    const canEdit = teamRoleLookup(org.role, members.data, me.id)(project.teamId) === "admin";
    body = <SettingsEditor key={project.id} project={project} canEdit={canEdit} />;
  }

  return (
    <>
      <PageHeader crumb={crumb} title={TITLE} />
      <PageBody>{body}</PageBody>
    </>
  );
}

function Crumb({ project, projectKey }: { project: Project | undefined; projectKey: string }) {
  return (
    <>
      <Link to="/projects" className="text-accent hover:text-accent-hover">
        Dự án
      </Link>{" "}
      /{" "}
      <Link to="/projects/$key" params={{ key: projectKey }} className="text-accent hover:text-accent-hover">
        {project?.name ?? projectKey}
      </Link>
    </>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  const id = useId();
  return (
    <Card className="grid gap-4 p-5" role="group" aria-labelledby={id}>
      <div className="grid gap-0.5">
        <h2 id={id} className="text-lg font-semibold text-ink">
          {title}
        </h2>
        {hint && <p className="text-sm text-muted">{hint}</p>}
      </div>
      {children}
    </Card>
  );
}

function Check({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled: boolean;
}) {
  const id = useId();
  return (
    <div className="grid gap-0.5">
      <label htmlFor={id} className="flex items-center gap-2 text-label font-medium text-ink">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.currentTarget.checked)}
          disabled={disabled}
          aria-describedby={hint ? `${id}-hint` : undefined}
          className="size-4 accent-accent"
        />
        {label}
      </label>
      {hint && (
        <p id={`${id}-hint`} className="pl-6 text-xs text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

function TextField({
  label,
  hint,
  error,
  value,
  onChange,
  disabled,
  inputMode,
  placeholder,
  suffix,
}: {
  label: string;
  hint?: string;
  error: string | undefined;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  inputMode?: "decimal" | "numeric";
  placeholder?: string;
  suffix?: string;
}) {
  return (
    <Field invalid={error !== undefined}>
      <FieldLabel>{label}</FieldLabel>
      <div className="flex items-center gap-2">
        <Input
          value={value}
          onValueChange={onChange}
          disabled={disabled}
          inputMode={inputMode}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
        />
        {suffix && <span className="text-sm whitespace-nowrap text-muted">{suffix}</span>}
      </div>
      {error ? <FieldError>{error}</FieldError> : hint && <FieldHint>{hint}</FieldHint>}
    </Field>
  );
}

function SettingsEditor({ project, canEdit }: { project: Project; canEdit: boolean }) {
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState<ProjectSettings>(project.settings);
  const [form, setForm] = useState<SettingsForm>(() => formFromSettings(project.settings));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [confirmFull, setConfirmFull] = useState(false);
  const ids = { method: useId(), reviewBy: useId(), paths: useId(), pathsHint: useId(), pathsError: useId() };

  const save = useMutation({
    mutationFn: (patch: NonNullable<Extract<ReturnType<typeof buildPatch>, { ok: true }>["patch"]>) =>
      api.projects.updateSettings.call({ key: project.key, settings: patch }),
    onSuccess: async (next) => {
      setSaved(next);
      setForm(formFromSettings(next));
      setDone(true);
      await queryClient.invalidateQueries({ queryKey: api.projects.key() });
    },
    onError: (error) => {
      const r = saveErrors(error);
      setErrors(r.errors);
      setFailure(r.message ?? null);
    },
  });

  const disabled = !canEdit || save.isPending;
  const set = <K extends keyof SettingsForm>(k: K, v: SettingsForm[K]) => {
    setDone(false);
    setForm((f) => ({ ...f, [k]: v }));
  };
  const setModel = (cli: (typeof SETTINGS_CLIS)[number], kind: "code" | "review", v: string) => {
    setDone(false);
    setForm((f) => ({ ...f, models: { ...f.models, [cli]: { ...f.models[cli], [kind]: v } } }));
  };
  const built = buildPatch(form, saved);
  const dirty = !built.ok || built.patch !== null;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFailure(null);
    setDone(false);
    if (!built.ok) {
      setErrors(built.errors);
      setFailure(built.message ?? "Có ô chưa hợp lệ, xem chữ đỏ bên dưới từng ô.");
      return;
    }
    setErrors({});
    if (built.patch) save.mutate(built.patch);
  }

  function choosePermission(mode: PermissionMode) {
    // Bật toàn quyền phải qua hộp xác nhận; đổi về workspace thì không cần.
    if (mode === "full" && form.runPermissions !== "full") setConfirmFull(true);
    else set("runPermissions", mode);
  }

  return (
    <form noValidate onSubmit={onSubmit} className="grid gap-4">
      {!canEdit && (
        <p role="note" className="rounded-lg border border-line bg-subtle px-3.5 py-2.5 text-label text-body">
          Bạn đang xem ở chế độ chỉ đọc. Quản trị đội sở hữu dự án hoặc quản trị tổ chức mới sửa được cấu hình.
        </p>
      )}

      <Section title="Merge" hint="Cách PR của agent được merge vào nhánh chính.">
        <fieldset className="grid gap-2">
          <legend className="mb-1.5 text-label font-medium text-ink">Chế độ</legend>
          {(
            [
              ["review", "Cần người duyệt", "Người duyệt PR rồi mới merge."],
              ["auto", "Tự merge khi đạt điều kiện", "Hub merge khi đạt chính sách kết quả và CI (nếu bắt buộc)."],
            ] as const
          ).map(([value, label, hint]) => (
            <label key={value} className="flex items-start gap-2 text-label text-ink">
              <input
                type="radio"
                name="mergeMode"
                value={value}
                checked={form.mergeMode === value}
                onChange={() => set("mergeMode", value)}
                disabled={disabled}
                className="mt-0.5 size-4 accent-accent"
              />
              <span className="grid">
                <span className="font-medium">{label}</span>
                <span className="text-xs text-muted">{hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="grid gap-4 app:grid-cols-2">
          <TextField
            label="Số người duyệt"
            hint="Từ 0 đến 6."
            error={errors.requiredApprovals}
            value={form.requiredApprovals}
            onChange={(v) => set("requiredApprovals", v)}
            disabled={disabled}
            inputMode="numeric"
          />
          <Field invalid={errors.mergeMethod !== undefined}>
            <FieldLabel htmlFor={ids.method}>Cách merge</FieldLabel>
            <Select
              id={ids.method}
              value={form.mergeMethod}
              onChange={(e) => set("mergeMethod", e.currentTarget.value as SettingsForm["mergeMethod"])}
              disabled={disabled}
            >
              <option value="">Mặc định (squash)</option>
              <option value="squash">Squash</option>
              <option value="merge">Merge commit</option>
              <option value="rebase">Rebase</option>
            </Select>
            {errors.mergeMethod && <FieldError>{errors.mergeMethod}</FieldError>}
          </Field>
        </div>
        <Check
          label="Bắt buộc CI xanh"
          hint="Tắt thì repo không có CI vẫn merge được."
          checked={form.requireCi}
          onChange={(v) => set("requireCi", v)}
          disabled={disabled}
        />
        <Check
          label="Merge queue"
          hint="PR vào hàng, hub cập nhật nhánh theo nhánh chính và merge lần lượt từng PR."
          checked={form.mergeQueue}
          onChange={(v) => set("mergeQueue", v)}
          disabled={disabled}
        />
      </Section>

      <Section title="Review chéo" hint="Sau khi agent xong, một agent khác review thay đổi trước khi kết luận run.">
        <Check
          label="Bật review chéo"
          checked={form.crossReview}
          onChange={(v) => set("crossReview", v)}
          disabled={disabled}
        />
        {form.crossReview && (
          <>
            <div className="grid gap-4 app:grid-cols-2">
              <Field invalid={errors.reviewBy !== undefined}>
                <FieldLabel htmlFor={ids.reviewBy}>Agent review</FieldLabel>
                <Select
                  id={ids.reviewBy}
                  value={form.reviewBy}
                  onChange={(e) => set("reviewBy", e.currentTarget.value as SettingsForm["reviewBy"])}
                  disabled={disabled}
                >
                  {SETTINGS_CLIS.map((c) => (
                    <option key={c} value={c}>
                      {CLI_LABEL[c]}
                    </option>
                  ))}
                </Select>
                {errors.reviewBy && <FieldError>{errors.reviewBy}</FieldError>}
              </Field>
              <TextField
                label="Điểm tối thiểu"
                hint="Thang 0 đến 10."
                error={errors.reviewMinScore}
                value={form.reviewMinScore}
                onChange={(v) => set("reviewMinScore", v)}
                disabled={disabled}
                inputMode="decimal"
              />
            </div>
            <Check
              label="Bắt buộc đạt"
              hint="Tắt thì kết quả review chỉ để tham khảo, run không hỏng vì review."
              checked={form.reviewRequired}
              onChange={(v) => set("reviewRequired", v)}
              disabled={disabled}
            />
            <fieldset className="grid gap-3">
              <legend className="mb-1 text-label font-medium text-ink">Chỉ review khi</legend>
              <p className="-mt-1 text-xs text-muted">
                Bỏ trống cả hai thì review mọi run. Điền cả hai thì đạt một trong hai là review.
              </p>
              <TextField
                label="Số dòng đổi từ"
                error={errors.reviewMinLines}
                value={form.reviewMinLines}
                onChange={(v) => set("reviewMinLines", v)}
                disabled={disabled}
                inputMode="numeric"
                suffix="dòng trở lên"
              />
              <div className="grid gap-1.5">
                <label htmlFor={ids.paths} className="text-label font-medium text-ink">
                  Có đổi file khớp
                </label>
                <Textarea
                  id={ids.paths}
                  rows={3}
                  value={form.reviewPaths}
                  onChange={(e) => set("reviewPaths", e.currentTarget.value)}
                  disabled={disabled}
                  placeholder={"src/billing/**\ndb/migrations/**"}
                  spellCheck={false}
                  aria-invalid={errors.reviewPaths ? true : undefined}
                  aria-describedby={errors.reviewPaths ? ids.pathsError : ids.pathsHint}
                  className="font-mono text-sm"
                />
                {errors.reviewPaths ? (
                  <p id={ids.pathsError} className="text-xs text-bad">
                    {errors.reviewPaths}
                  </p>
                ) : (
                  <p id={ids.pathsHint} className="text-xs text-muted">
                    Mỗi dòng một mẫu đường dẫn kiểu glob.
                  </p>
                )}
              </div>
            </fieldset>
          </>
        )}
      </Section>

      <Section title="Plan mode">
        <Check
          label="Lập kế hoạch trước khi làm"
          hint="Agent viết kế hoạch, người trong đội duyệt rồi run mới chạy."
          checked={form.planMode}
          onChange={(v) => set("planMode", v)}
          disabled={disabled}
        />
      </Section>

      <Section
        title="Ngân sách"
        hint="Bỏ trống là không giới hạn. Codex và Gemini không báo USD nên trần USD chỉ có tác dụng với Claude."
      >
        <div className="grid gap-4 app:grid-cols-3">
          <TextField
            label="Mỗi run"
            error={errors.perRunUsd}
            value={form.perRunUsd}
            onChange={(v) => set("perRunUsd", v)}
            disabled={disabled}
            inputMode="decimal"
            placeholder="Không giới hạn"
            suffix="USD"
          />
          <TextField
            label="Mỗi việc"
            hint="Cộng mọi run của việc."
            error={errors.perTaskUsd}
            value={form.perTaskUsd}
            onChange={(v) => set("perTaskUsd", v)}
            disabled={disabled}
            inputMode="decimal"
            placeholder="Không giới hạn"
            suffix="USD"
          />
          <TextField
            label="Số lượt tối đa"
            hint="Lượt trao đổi của agent trong một run."
            error={errors.maxTurns}
            value={form.maxTurns}
            onChange={(v) => set("maxTurns", v)}
            disabled={disabled}
            inputMode="numeric"
            placeholder="Không giới hạn"
          />
        </div>
      </Section>

      <Section title="Model" hint="Bỏ trống thì CLI dùng model mặc định của nó.">
        <div className="grid gap-4">
          {SETTINGS_CLIS.map((cli) => (
            <fieldset key={cli} className="grid gap-3 app:grid-cols-[6rem_1fr_1fr] app:items-start">
              <legend className="sr-only">{CLI_LABEL[cli]}</legend>
              <span aria-hidden="true" className="pt-1 font-medium text-ink app:pt-8">
                {CLI_LABEL[cli]}
              </span>
              <TextField
                label={`Viết code (${CLI_LABEL[cli]})`}
                error={errors[`models.${cli}.code`]}
                value={form.models[cli].code}
                onChange={(v) => setModel(cli, "code", v)}
                disabled={disabled}
                placeholder="Mặc định của CLI"
              />
              <TextField
                label={`Review (${CLI_LABEL[cli]})`}
                error={errors[`models.${cli}.review`]}
                value={form.models[cli].review}
                onChange={(v) => setModel(cli, "review", v)}
                disabled={disabled}
                placeholder="Mặc định của CLI"
              />
            </fieldset>
          ))}
        </div>
      </Section>

      <Section title="Quyền CLI của run">
        <fieldset className="grid gap-2">
          <legend className="sr-only">Quyền CLI của run</legend>
          {(
            [
              [
                "workspace",
                "Trong worktree (khuyên dùng)",
                "Agent sửa file và chạy lệnh build, test trong worktree của run; CLI giữ sandbox và chặn thao tác ngoài worktree.",
              ],
              [
                "full",
                "Toàn quyền",
                "Tắt sandbox và mọi bước hỏi duyệt của CLI. Chỉ dùng trong container dùng một lần hoặc máy riêng cho agent.",
              ],
            ] as const
          ).map(([value, label, hint]) => (
            <label key={value} className="flex items-start gap-2 text-label text-ink">
              <input
                type="radio"
                name="runPermissions"
                value={value}
                checked={form.runPermissions === value}
                onChange={() => choosePermission(value)}
                disabled={disabled}
                className="mt-0.5 size-4 accent-accent"
              />
              <span className="grid">
                <span className={cx("font-medium", value === "full" && "text-bad")}>{label}</span>
                <span className="text-xs text-muted">{hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {form.runPermissions === "full" && (
          <p className="rounded-lg bg-bad-bg px-3.5 py-2.5 text-label text-bad">
            Run của dự án này chạy với toàn quyền của tài khoản trên máy nhận việc.
          </p>
        )}
        {errors.runPermissions && <p className="text-xs text-bad">{errors.runPermissions}</p>}
      </Section>

      {canEdit && (
        <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-3 border-t border-line bg-canvas py-3">
          {failure && <Alert className="mr-auto">{failure}</Alert>}
          {done && !failure && (
            <p role="status" className="mr-auto text-label text-ok">
              Đã lưu cấu hình. Run giao sau đây dùng cấu hình mới.
            </p>
          )}
          <Button
            onClick={() => {
              setForm(formFromSettings(saved));
              setErrors({});
              setFailure(null);
            }}
            disabled={!dirty || save.isPending}
          >
            Bỏ thay đổi
          </Button>
          <Button type="submit" variant="primary" disabled={!dirty || save.isPending}>
            {save.isPending ? "Đang lưu…" : "Lưu cấu hình"}
          </Button>
        </div>
      )}

      <Dialog open={confirmFull} onOpenChange={setConfirmFull}>
        <DialogContent>
          <DialogTitle>Cho agent toàn quyền?</DialogTitle>
          <DialogDescription>
            CLI sẽ chạy không sandbox và không hỏi duyệt (Claude: bypassPermissions, Codex: bỏ sandbox, Gemini: yolo).
          </DialogDescription>
          <ul className="grid list-disc gap-1 pl-5 text-label text-body">
            <li>
              Agent đọc, sửa, xoá được mọi file mà tài khoản trên máy truy cập được, kể cả ngoài worktree: khoá SSH,
              token, cấu hình CLI, mã nguồn dự án khác.
            </li>
            <li>Agent chạy được mọi lệnh và gọi mạng ra ngoài.</li>
            <li>
              Nội dung độc trong issue, tài liệu hay mã nguồn có thể khiến agent xoá dữ liệu hoặc gửi secret ra ngoài.
            </li>
          </ul>
          <p className="text-label text-ink">
            Chỉ bật khi run chạy trong container dùng một lần hoặc trên máy riêng cho agent, không chứa dữ liệu quan
            trọng.
          </p>
          <DialogActions>
            <Button onClick={() => setConfirmFull(false)}>Giữ trong worktree</Button>
            <Button
              variant="dangerSolid"
              onClick={() => {
                set("runPermissions", "full");
                setConfirmFull(false);
              }}
            >
              Bật toàn quyền
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </form>
  );
}
