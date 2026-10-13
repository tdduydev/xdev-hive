import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { Project, ProjectSettings } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { Input } from "@xdev-hive/ui/input";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Textarea } from "@xdev-hive/ui/textarea";
import { LockIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { Card } from "@/components/ui/card.tsx";
import { Field, FieldError, FieldHint, FieldLabel } from "@/components/ui/field.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { cx } from "@/lib/cx.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import {
  buildPatch,
  type FieldErrors,
  formFromSettings,
  type PermissionMode,
  REVIEW_CLIS,
  SETTINGS_CLIS,
  type SettingsForm,
  saveErrors,
} from "@/lib/project-settings.ts";
import { teamRoleLookup } from "@/lib/projects.ts";
import { CLI_LABEL } from "@/lib/run-view.ts";
import { useMe } from "@/shell/me-context.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

const text: Dict<{
  title: string;
  projectsCrumb: string;
  sectionsNav: string;
  loading: string;
  notFound: (k: string) => string;
  backToProjects: string;
  readOnlyBanner: string;
  mergeTitle: string;
  mergeHint: string;
  modeLabel: string;
  modeReview: string;
  modeReviewHint: string;
  modeAuto: string;
  modeAutoHint: string;
  reviewers: string;
  reviewersHint: string;
  method: string;
  mDefault: string;
  ciLabel: string;
  ciHint: string;
  queueLabel: string;
  queueHint: string;
  reviewTitle: string;
  reviewHint: string;
  reviewOn: string;
  reviewAgent: string;
  minScore: string;
  minScoreHint: string;
  mustPass: string;
  mustPassHint: string;
  onlyWhen: string;
  linesFrom: string;
  linesSuffix: string;
  filesMatch: string;
  globHint: string;
  onlyWhenHint: string;
  planTitle: string;
  planHint: string;
  sandboxTitle: string;
  sandboxHint: string;
  sandboxLink: string;
  budgetTitle: string;
  budgetHint: string;
  perRun: string;
  perTask: string;
  perTaskHint: string;
  maxTurns: string;
  maxTurnsHint: string;
  unlimited: string;
  modelTitle: string;
  modelHint: string;
  cliDefault: string;
  writeCode: string;
  reviewCode: string;
  permTitle: string;
  pWt: string;
  pWtHint: string;
  pFull: string;
  pFullHint: string;
  fullBanner: string;
  fullLocked: string;
  unsavedChanges: (n: number) => string;
  savedBanner: string;
  discard: string;
  save: string;
  saving: string;
  cfTitle: string;
  cfDesc: string;
  cf1: string;
  cf2: string;
  cf3: string;
  cfNote: string;
  cfKeep: string;
  cfGo: string;
}> = {
  vi: {
    title: "Cấu hình dự án",
    projectsCrumb: "Dự án",
    sectionsNav: "Các phần",
    loading: "Đang tải…",
    notFound: (k) => `Không tìm thấy dự án ${k}, hoặc bạn không ở trong đội sở hữu dự án.`,
    backToProjects: "Về danh sách dự án",
    readOnlyBanner:
      "Bạn đang xem ở chế độ chỉ đọc. Quản trị đội sở hữu dự án hoặc quản trị tổ chức mới sửa được cấu hình.",
    mergeTitle: "Merge",
    mergeHint: "Cách PR của agent được merge vào nhánh chính.",
    modeLabel: "Chế độ",
    modeReview: "Cần người duyệt",
    modeReviewHint: "Người duyệt PR rồi mới merge.",
    modeAuto: "Tự merge khi đạt điều kiện",
    modeAutoHint: "Hub merge khi đạt chính sách kết quả và CI (nếu bắt buộc).",
    reviewers: "Số người duyệt",
    reviewersHint: "Từ 0 đến 6.",
    method: "Cách merge",
    mDefault: "Mặc định (squash)",
    ciLabel: "Bắt buộc CI xanh",
    ciHint: "Tắt thì repo không có CI vẫn merge được.",
    queueLabel: "Merge queue",
    queueHint: "PR vào hàng, hub cập nhật nhánh theo nhánh chính và merge lần lượt từng PR.",
    reviewTitle: "Review chéo",
    reviewHint: "Sau khi agent xong, một agent khác review thay đổi trước khi kết luận run.",
    reviewOn: "Bật review chéo",
    reviewAgent: "Agent review",
    minScore: "Điểm tối thiểu",
    minScoreHint: "Thang 0 đến 10.",
    mustPass: "Bắt buộc đạt",
    mustPassHint: "Tắt thì kết quả review chỉ để tham khảo, run không hỏng vì review.",
    onlyWhen: "Chỉ review khi",
    linesFrom: "Số dòng đổi từ",
    linesSuffix: "dòng",
    filesMatch: "Có đổi file khớp",
    globHint: "Mỗi dòng một mẫu đường dẫn kiểu glob.",
    onlyWhenHint: "Bỏ trống cả hai thì review mọi run. Điền cả hai thì đạt một trong hai là review.",
    planTitle: "Plan mode",
    planHint: "Agent viết kế hoạch, người trong đội duyệt rồi run mới chạy.",
    sandboxTitle: "Sandbox",
    sandboxHint:
      "Run code chạy trên runner host, mỗi run một container gVisor không có mạng; chỉ ra được các địa chỉ trong allowlist.",
    sandboxLink: "Allowlist mạng và image môi trường của dự án",
    budgetTitle: "Ngân sách",
    budgetHint:
      "Bỏ trống là không giới hạn. Codex, Gemini và Antigravity không báo USD nên trần USD chỉ có tác dụng với Claude.",
    perRun: "Mỗi run",
    perTask: "Mỗi việc",
    perTaskHint: "Cộng mọi run của việc.",
    maxTurns: "Số lượt tối đa",
    maxTurnsHint: "Lượt trao đổi của agent trong một run.",
    unlimited: "Không giới hạn",
    modelTitle: "Model",
    modelHint: "Bỏ trống thì CLI dùng model mặc định của nó.",
    cliDefault: "Mặc định của CLI",
    writeCode: "Viết code",
    reviewCode: "Review",
    permTitle: "Quyền CLI của run",
    pWt: "Trong worktree (khuyên dùng)",
    pWtHint:
      "Agent sửa file và chạy lệnh build, test trong worktree của run; CLI giữ sandbox và chặn thao tác ngoài worktree.",
    pFull: "Toàn quyền",
    pFullHint:
      "Tắt sandbox và mọi bước hỏi duyệt của CLI. Chỉ dùng trong container dùng một lần hoặc máy riêng cho agent.",
    fullBanner: "Run của dự án này chạy với toàn quyền của tài khoản trên máy nhận việc.",
    fullLocked: "Chính sách agent của tổ chức không cho dự án bật toàn quyền; run chạy trong worktree.",
    unsavedChanges: (n) => `Có ${n} thay đổi chưa lưu`,
    savedBanner: "Đã lưu cấu hình. Run giao sau đây dùng cấu hình mới.",
    discard: "Bỏ thay đổi",
    save: "Lưu cấu hình",
    saving: "Đang lưu…",
    cfTitle: "Cho agent toàn quyền?",
    cfDesc:
      "CLI sẽ chạy không sandbox và không hỏi duyệt (Claude: bypassPermissions, Codex: bỏ sandbox, Gemini: yolo, Antigravity: --dangerously-skip-permissions).",
    cf1: "Agent đọc và sửa được mọi file tài khoản đó truy cập.",
    cf2: "Agent chạy được mọi lệnh, kể cả lệnh mạng.",
    cf3: "Lỗi của agent có thể làm hỏng máy nhận việc.",
    cfNote:
      "Chỉ bật khi run chạy trong container dùng một lần hoặc trên máy riêng cho agent, không chứa dữ liệu quan trọng.",
    cfKeep: "Giữ trong worktree",
    cfGo: "Bật toàn quyền",
  },
  en: {
    title: "Project settings",
    projectsCrumb: "Projects",
    sectionsNav: "Sections",
    loading: "Loading…",
    notFound: (k) => `Project ${k} not found, or you are not in the owning team.`,
    backToProjects: "Back to projects",
    readOnlyBanner:
      "You are viewing in read-only mode. Only owning team admins or organization admins can edit settings.",
    mergeTitle: "Merge",
    mergeHint: "How agent PRs merge into the main branch.",
    modeLabel: "Mode",
    modeReview: "Requires a reviewer",
    modeReviewHint: "A person approves the PR before merge.",
    modeAuto: "Auto-merge when checks pass",
    modeAutoHint: "The hub merges once the result policy and CI (if required) pass.",
    reviewers: "Required reviewers",
    reviewersHint: "From 0 to 6.",
    method: "Merge method",
    mDefault: "Default (squash)",
    ciLabel: "Require green CI",
    ciHint: "When off, repos without CI can still merge.",
    queueLabel: "Merge queue",
    queueHint: "PRs queue up; the hub rebases each on main and merges them one by one.",
    reviewTitle: "Cross-review",
    reviewHint: "After an agent finishes, another agent reviews the change before the run concludes.",
    reviewOn: "Enable cross-review",
    reviewAgent: "Reviewing agent",
    minScore: "Minimum score",
    minScoreHint: "Scale of 0 to 10.",
    mustPass: "Must pass",
    mustPassHint: "When off, the review is advisory and never fails the run.",
    onlyWhen: "Only review when",
    linesFrom: "Changed lines from",
    linesSuffix: "lines",
    filesMatch: "Changed files match",
    globHint: "One glob path pattern per line.",
    onlyWhenHint: "Leave both empty to review every run. Fill both and either one triggers a review.",
    planTitle: "Plan mode",
    planHint: "The agent writes a plan; someone on the team approves it before the run starts.",
    sandboxTitle: "Sandbox",
    sandboxHint: "Code runs on the runner host, one gVisor container per run with no network except the allowlist.",
    sandboxLink: "Network allowlist and environment image",
    budgetTitle: "Budget",
    budgetHint:
      "Empty means no limit. Codex, Gemini and Antigravity do not report USD, so USD caps only apply to Claude.",
    perRun: "Per run",
    perTask: "Per task",
    perTaskHint: "Sum of every run of the task.",
    maxTurns: "Max turns",
    maxTurnsHint: "Agent turns within one run.",
    unlimited: "No limit",
    modelTitle: "Model",
    modelHint: "Leave empty to use the CLI default model.",
    cliDefault: "CLI default",
    writeCode: "Writing code",
    reviewCode: "Review",
    permTitle: "CLI permissions for runs",
    pWt: "Inside the worktree (recommended)",
    pWtHint:
      "The agent edits files and runs builds and tests in the run worktree; the CLI keeps its sandbox and blocks anything outside it.",
    pFull: "Full access",
    pFullHint:
      "Turns off the CLI sandbox and every approval prompt. Only for throwaway containers or machines dedicated to agents.",
    fullBanner: "Runs in this project use the full rights of the account on the machine that picks them up.",
    fullLocked: "The organization's agent policy does not let projects enable full access; runs stay in the worktree.",
    unsavedChanges: (n) => `${n} unsaved changes`,
    savedBanner: "Settings saved. Subsequent runs will use the new settings.",
    discard: "Discard",
    save: "Save settings",
    saving: "Saving…",
    cfTitle: "Give agents full access?",
    cfDesc:
      "The CLI runs without a sandbox or approval prompts (Claude: bypassPermissions, Codex: no sandbox, Gemini: yolo, Antigravity: --dangerously-skip-permissions).",
    cf1: "The agent can read and change every file that account can reach.",
    cf2: "The agent can run any command, including network commands.",
    cf3: "An agent mistake can damage the machine.",
    cfNote: "Only turn this on for throwaway containers or agent-only machines with no important data.",
    cfKeep: "Keep in worktree",
    cfGo: "Enable full access",
  },
};

/** /projects/$key/settings: merge, review chéo, plan mode, ngân sách, model, quyền CLI của run. */
export function ProjectSettingsPage() {
  const me = useMe();
  const { org, api } = useOrg();
  const t = useT(text);
  const { key } = useParams({ from: "/session/app/in-org/projects/$key/settings" });
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const members = useQuery(api.orgMembers.list.queryOptions());
  const project = projects.data?.find((p) => p.key === key);
  const crumb = <Crumb project={project} projectKey={key} />;

  let body: ReactNode;
  if (projects.isPending || (members.isPending && org.role === "member")) {
    body = (
      <p aria-busy="true" className="text-muted-foreground">
        {t.loading}
      </p>
    );
  } else if (projects.isError || !project) {
    body = (
      <>
        <Alert variant="destructive">{projects.isError ? apiErrorMessage(projects.error) : t.notFound(key)}</Alert>
        <Link to="/projects" className="text-primary hover:text-primary/90">
          {t.backToProjects}
        </Link>
      </>
    );
  } else {
    const canEdit = teamRoleLookup(org.role, members.data, me.id)(project.teamId) === "admin";
    body = <SettingsEditor key={project.id} project={project} canEdit={canEdit} />;
  }

  return (
    <>
      <PageHeader crumb={crumb} title={t.title} />
      <PageBody>{body}</PageBody>
    </>
  );
}

function Crumb({ project, projectKey }: { project: Project | undefined; projectKey: string }) {
  const t = useT(text);
  return (
    <>
      <Link to="/projects" className="text-primary hover:text-primary/90">
        {t.projectsCrumb}
      </Link>{" "}
      /{" "}
      <Link to="/projects/$key" params={{ key: projectKey }} className="text-primary hover:text-primary/90">
        {project?.name ?? projectKey}
      </Link>
    </>
  );
}

function Section({ id, title, hint, children }: { id?: string; title?: string; hint?: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <Card id={id} className="grid gap-4 p-5 scroll-mt-20" role="group" aria-labelledby={title ? headingId : undefined}>
      {title && (
        <div className="grid gap-0.5">
          <h2 id={headingId} className="text-base font-semibold text-foreground">
            {title}
          </h2>
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
      )}
      {children}
    </Card>
  );
}

function SwitchRow({
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
    <div className="flex items-start justify-between gap-4">
      <label htmlFor={id} className="grid cursor-pointer gap-0.5">
        <span className="text-sm font-medium text-foreground">{label}</span>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label} />
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
  const id = useId();
  return (
    <Field invalid={error !== undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="relative flex items-center">
        <Input
          id={id}
          value={value}
          onValueChange={onChange}
          disabled={disabled}
          inputMode={inputMode}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          className={cx("font-mono text-sm", suffix && "pr-12")}
        />
        {suffix && (
          <span className="pointer-events-none absolute right-3 font-mono text-xs text-muted-foreground">{suffix}</span>
        )}
      </div>
      {error ? <FieldError>{error}</FieldError> : hint && <FieldHint>{hint}</FieldHint>}
    </Field>
  );
}

function SettingsEditor({ project, canEdit }: { project: Project; canEdit: boolean }) {
  const { api } = useOrg();
  const t = useT(text);
  // Hub cũ chưa có chính sách thì coi như không khoá, như trước.
  const policy = useQuery({ ...api.policies.get.queryOptions(), retry: false });
  const fullLocked = policy.data?.allowFullPermission === false;
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
    if (mode === "full" && form.runPermissions !== "full") setConfirmFull(true);
    else set("runPermissions", mode);
  }

  const toc = [
    { href: "#merge", label: t.mergeTitle },
    { href: "#review", label: t.reviewTitle },
    { href: "#plan", label: t.planTitle },
    { href: "#sandbox", label: t.sandboxTitle },
    { href: "#budget", label: t.budgetTitle },
    { href: "#model", label: t.modelTitle },
    { href: "#perm", label: t.permTitle },
  ];

  return (
    <form noValidate onSubmit={onSubmit} className="grid gap-6">
      {!canEdit && (
        <p role="note" className="rounded-lg border border-border bg-muted px-3.5 py-2.5 text-sm text-foreground">
          {t.readOnlyBanner}
        </p>
      )}

      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        {/* TOC sidebar */}
        <nav aria-label={t.sectionsNav} className="sticky top-4 hidden w-48 shrink-0 flex-col gap-1 text-sm lg:flex">
          {toc.map((s) => (
            <a
              key={s.href}
              href={s.href}
              className="rounded-md px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {s.label}
            </a>
          ))}
        </nav>

        {/* Content sections */}
        <div className="min-w-0 flex-1 grid gap-4">
          <Section id="merge" title={t.mergeTitle} hint={t.mergeHint}>
            <div role="radiogroup" aria-label={t.modeLabel} className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  ["review", t.modeReview, t.modeReviewHint],
                  ["auto", t.modeAuto, t.modeAutoHint],
                ] as const
              ).map(([value, label, hint]) => {
                const on = form.mergeMode === value;
                return (
                  <label
                    key={value}
                    className={cx(
                      "flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-sm transition-colors",
                      on ? "border-primary bg-accent/40" : "border-border hover:bg-muted/40",
                      disabled && "cursor-not-allowed opacity-60",
                    )}
                  >
                    <input
                      type="radio"
                      name="mergeMode"
                      value={value}
                      checked={on}
                      onChange={() => set("mergeMode", value)}
                      disabled={disabled}
                      className="mt-0.5 size-4 accent-primary"
                    />
                    <span className="grid gap-0.5">
                      <strong className="font-medium text-foreground">{label}</strong>
                      <span className="text-xs text-muted-foreground">{hint}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label={t.reviewers}
                hint={t.reviewersHint}
                error={errors.requiredApprovals}
                value={form.requiredApprovals}
                onChange={(v) => set("requiredApprovals", v)}
                disabled={disabled}
                inputMode="numeric"
              />
              <Field invalid={errors.mergeMethod !== undefined}>
                <FieldLabel htmlFor={ids.method}>{t.method}</FieldLabel>
                <NativeSelect
                  id={ids.method}
                  value={form.mergeMethod}
                  onChange={(e) => set("mergeMethod", e.currentTarget.value as SettingsForm["mergeMethod"])}
                  disabled={disabled}
                >
                  <option value="">{t.mDefault}</option>
                  <option value="squash">Squash</option>
                  <option value="merge">Merge commit</option>
                  <option value="rebase">Rebase</option>
                </NativeSelect>
                {errors.mergeMethod && <FieldError>{errors.mergeMethod}</FieldError>}
              </Field>
            </div>
            <SwitchRow
              label={t.ciLabel}
              hint={t.ciHint}
              checked={form.requireCi}
              onChange={(v) => set("requireCi", v)}
              disabled={disabled}
            />
            <SwitchRow
              label={t.queueLabel}
              hint={t.queueHint}
              checked={form.mergeQueue}
              onChange={(v) => set("mergeQueue", v)}
              disabled={disabled}
            />
          </Section>

          <Section id="review" title={t.reviewTitle} hint={t.reviewHint}>
            <SwitchRow
              label={t.reviewOn}
              checked={form.crossReview}
              onChange={(v) => set("crossReview", v)}
              disabled={disabled}
            />
            {form.crossReview && (
              <div className="grid gap-4 border-l-2 border-border pl-3.5">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field invalid={errors.reviewBy !== undefined}>
                    <FieldLabel htmlFor={ids.reviewBy}>{t.reviewAgent}</FieldLabel>
                    <NativeSelect
                      id={ids.reviewBy}
                      value={form.reviewBy}
                      onChange={(e) => set("reviewBy", e.currentTarget.value as SettingsForm["reviewBy"])}
                      disabled={disabled}
                    >
                      {REVIEW_CLIS.map((c) => (
                        <option key={c} value={c}>
                          {CLI_LABEL[c]}
                        </option>
                      ))}
                    </NativeSelect>
                    {errors.reviewBy && <FieldError>{errors.reviewBy}</FieldError>}
                  </Field>
                  <TextField
                    label={t.minScore}
                    hint={t.minScoreHint}
                    error={errors.reviewMinScore}
                    value={form.reviewMinScore}
                    onChange={(v) => set("reviewMinScore", v)}
                    disabled={disabled}
                    inputMode="decimal"
                  />
                </div>
                <SwitchRow
                  label={t.mustPass}
                  hint={t.mustPassHint}
                  checked={form.reviewRequired}
                  onChange={(v) => set("reviewRequired", v)}
                  disabled={disabled}
                />
                <fieldset className="grid gap-3 rounded-lg border border-dashed border-border p-3 sm:grid-cols-[180px_minmax(0,1fr)]">
                  <legend className="px-1.5 text-xs font-medium text-foreground">{t.onlyWhen}</legend>
                  <TextField
                    label={t.linesFrom}
                    error={errors.reviewMinLines}
                    value={form.reviewMinLines}
                    onChange={(v) => set("reviewMinLines", v)}
                    disabled={disabled}
                    inputMode="numeric"
                    suffix={t.linesSuffix}
                  />
                  <div className="grid gap-1.5">
                    <label htmlFor={ids.paths} className="text-sm font-medium text-foreground">
                      {t.filesMatch}
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
                      className="font-mono text-xs"
                    />
                    {errors.reviewPaths ? (
                      <p id={ids.pathsError} className="text-xs text-destructive">
                        {errors.reviewPaths}
                      </p>
                    ) : (
                      <p id={ids.pathsHint} className="text-xs text-muted-foreground">
                        {t.globHint}
                      </p>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground sm:col-span-2">{t.onlyWhenHint}</span>
                </fieldset>
              </div>
            )}
          </Section>

          <Section id="plan">
            <SwitchRow
              label={t.planTitle}
              hint={t.planHint}
              checked={form.planMode}
              onChange={(v) => set("planMode", v)}
              disabled={disabled}
            />
          </Section>

          <Section id="sandbox">
            <SwitchRow
              label={t.sandboxTitle}
              hint={t.sandboxHint}
              checked={form.sandbox}
              onChange={(v) => set("sandbox", v)}
              disabled={disabled}
            />
            <p className="text-xs">
              <Link
                to="/projects/$key/sandbox"
                params={{ key: project.key }}
                className="text-primary hover:text-primary/90"
              >
                {t.sandboxLink} →
              </Link>
            </p>
          </Section>

          <Section id="budget" title={t.budgetTitle} hint={t.budgetHint}>
            <div className="grid gap-4 sm:grid-cols-3">
              <TextField
                label={t.perRun}
                error={errors.perRunUsd}
                value={form.perRunUsd}
                onChange={(v) => set("perRunUsd", v)}
                disabled={disabled}
                inputMode="decimal"
                placeholder={t.unlimited}
                suffix="USD"
              />
              <TextField
                label={t.perTask}
                hint={t.perTaskHint}
                error={errors.perTaskUsd}
                value={form.perTaskUsd}
                onChange={(v) => set("perTaskUsd", v)}
                disabled={disabled}
                inputMode="decimal"
                placeholder={t.unlimited}
                suffix="USD"
              />
              <TextField
                label={t.maxTurns}
                hint={t.maxTurnsHint}
                error={errors.maxTurns}
                value={form.maxTurns}
                onChange={(v) => set("maxTurns", v)}
                disabled={disabled}
                inputMode="numeric"
                placeholder={t.unlimited}
              />
            </div>
          </Section>

          <Section id="model" title={t.modelTitle} hint={t.modelHint}>
            <div className="grid gap-3 pt-1">
              {SETTINGS_CLIS.map((cli) => (
                <div key={cli} className="grid items-end gap-3 border-b border-border pb-3 sm:grid-cols-[80px_1fr_1fr]">
                  <strong className="pb-2 text-sm font-semibold text-foreground">{CLI_LABEL[cli]}</strong>
                  <TextField
                    label={`${t.writeCode} (${CLI_LABEL[cli]})`}
                    error={errors[`models.${cli}.code`]}
                    value={form.models[cli].code}
                    onChange={(v) => setModel(cli, "code", v)}
                    disabled={disabled}
                    placeholder={t.cliDefault}
                  />
                  <TextField
                    label={`${t.reviewCode} (${CLI_LABEL[cli]})`}
                    error={errors[`models.${cli}.review`]}
                    value={form.models[cli].review}
                    onChange={(v) => setModel(cli, "review", v)}
                    disabled={disabled}
                    placeholder={t.cliDefault}
                  />
                </div>
              ))}
            </div>
          </Section>

          <Section id="perm" title={t.permTitle}>
            <div role="radiogroup" aria-label={t.permTitle} className="grid gap-2">
              <label
                className={cx(
                  "flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-sm transition-colors",
                  form.runPermissions === "workspace"
                    ? "border-primary bg-accent/40"
                    : "border-border hover:bg-muted/40",
                  disabled && "cursor-not-allowed opacity-60",
                )}
              >
                <input
                  type="radio"
                  name="runPermissions"
                  value="workspace"
                  checked={form.runPermissions === "workspace"}
                  onChange={() => choosePermission("workspace")}
                  disabled={disabled}
                  className="mt-0.5 size-4 accent-primary"
                />
                <span className="grid gap-0.5">
                  <strong className="font-medium text-foreground">{t.pWt}</strong>
                  <span className="text-xs text-muted-foreground">{t.pWtHint}</span>
                </span>
              </label>

              <label
                className={cx(
                  "flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-sm transition-colors",
                  form.runPermissions === "full"
                    ? "border-destructive bg-destructive-soft text-destructive"
                    : "border-border hover:bg-muted/40",
                  disabled && "cursor-not-allowed opacity-60",
                )}
              >
                <input
                  type="radio"
                  name="runPermissions"
                  value="full"
                  checked={form.runPermissions === "full"}
                  onChange={() => choosePermission("full")}
                  disabled={disabled || (fullLocked && form.runPermissions !== "full")}
                  className="mt-0.5 size-4 accent-destructive"
                />
                <span className="grid gap-0.5">
                  <strong className={form.runPermissions === "full" ? "text-destructive" : "text-foreground"}>
                    {t.pFull}
                  </strong>
                  <span className="text-xs text-muted-foreground">{t.pFullHint}</span>
                </span>
              </label>
            </div>
            {fullLocked ? (
              <p className="flex items-start gap-2 rounded-lg bg-muted px-3.5 py-2.5 text-xs text-muted-foreground">
                <LockIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
                {t.fullLocked}
              </p>
            ) : (
              form.runPermissions === "full" && (
                <p role="alert" className="rounded-lg bg-destructive-soft px-3.5 py-2.5 text-xs text-destructive">
                  {t.fullBanner}
                </p>
              )
            )}
            {errors.runPermissions && <p className="text-xs text-destructive">{errors.runPermissions}</p>}
          </Section>
        </div>
      </div>

      {canEdit && (
        <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-3 border-t border-border bg-background py-3">
          {dirty && <span className="mr-auto text-xs text-muted-foreground">{t.unsavedChanges(1)}</span>}
          {failure && (
            <Alert variant="destructive" className="mr-auto">
              {failure}
            </Alert>
          )}
          {done && !failure && (
            <p role="status" className="mr-auto text-xs text-success">
              {t.savedBanner}
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setForm(formFromSettings(saved));
              setErrors({});
              setFailure(null);
            }}
            disabled={!dirty || save.isPending}
          >
            {t.discard}
          </Button>
          <Button type="submit" variant="default" disabled={!dirty || save.isPending}>
            {save.isPending ? t.saving : t.save}
          </Button>
        </div>
      )}

      <Dialog open={confirmFull} onOpenChange={setConfirmFull}>
        <DialogContent>
          <DialogTitle>{t.cfTitle}</DialogTitle>
          <DialogDescription>{t.cfDesc}</DialogDescription>
          <ul className="grid list-disc gap-1 pl-5 text-sm text-foreground">
            <li>{t.cf1}</li>
            <li>{t.cf2}</li>
            <li>{t.cf3}</li>
          </ul>
          <p className="text-xs text-muted-foreground">{t.cfNote}</p>
          <DialogActions>
            <Button variant="outline" onClick={() => setConfirmFull(false)}>
              {t.cfKeep}
            </Button>
            <Button
              variant="destructive-solid"
              onClick={() => {
                set("runPermissions", "full");
                setConfirmFull(false);
              }}
            >
              {t.cfGo}
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </form>
  );
}
