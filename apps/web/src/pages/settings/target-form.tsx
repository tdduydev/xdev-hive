import { ORPCError } from "@orpc/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DEPLOY_METHODS,
  type DeployEnvironment,
  type DeployServer,
  type DeployTarget,
  type InfraConnection,
  type JenkinsConnection,
  targetUpsertInput,
} from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { DialogActions, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { Input } from "@xdev-hive/ui/input";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/native-select";
import { Textarea } from "@xdev-hive/ui/textarea";
import { type FormEvent, type ReactNode, useState } from "react";
import { Field, FieldError, FieldHint, FieldLabel } from "@/components/ui/field.tsx";
import { apiErrorCode, apiErrorMessage } from "@/lib/api-errors.ts";
import { DEPLOY_METHOD_LABEL } from "@/lib/delivery-text.ts";
import { useOrg } from "@/shell/org-context.ts";
import {
  draftFromConfig,
  draftToConfig,
  emptyDraft,
  type ParamDraft,
  presetById,
  TARGET_PRESETS,
  type TargetDraft,
  type VariableDraft,
  validateDraft,
} from "./target-presets.ts";

const VI = {
  addTitle: (project: string, env: string) => `Thêm đích: ${project} ở ${env}`,
  editTitle: (project: string, env: string) => `Sửa đích: ${project} ở ${env}`,
  lead: "Cách hub đưa bản mới của dự án lên môi trường này. Biến bí mật chỉ ghi: hub không bao giờ trả giá trị đã lưu.",
  method: "Cách triển khai",
  preset: "Mẫu",
  presetNone: "Không dùng mẫu",
  presetHint: "Chọn mẫu để điền sẵn các bước. Sau đó chọn máy chủ và sửa cho đúng máy của bạn.",
  branch: "Nhánh",
  branchHint: "Bỏ trống là nhánh mặc định của repo.",
  server: "Máy chủ",
  serverNone: "Chọn máy chủ",
  noServers: "Đội chưa có máy chủ nào. Thêm máy chủ ở trang Máy chủ trước.",
  connection: "Kết nối",
  connectionNone: "Chọn kết nối",
  noConnections: "Chưa có kết nối phù hợp. Thêm ở trang Kết nối CI/CD trước.",
  workdir: "Thư mục làm việc",
  composeProject: "Tên compose project",
  precheck: "Bước kiểm trước",
  backupOn: "Có bước sao lưu",
  backup: "Bước sao lưu",
  upload: "Đưa mã lên máy chủ",
  uploadGit: "Đóng gói mã của commit bằng git archive",
  uploadNone: "Không đưa mã lên (script tự lấy mã)",
  deploy: "Bước triển khai",
  timeout: "Hết hạn (giây)",
  variables: "Biến cho script",
  addVariable: "Thêm biến",
  varName: "Tên biến",
  varValue: "Giá trị",
  varSecret: "Bí mật",
  varStored: "Đã lưu. Bỏ trống để giữ giá trị này.",
  varRemove: (name: string) => `Xoá biến ${name || "chưa đặt tên"}`,
  jobPath: "Đường dẫn job Jenkins",
  params: "Tham số build",
  addParam: "Thêm tham số",
  paramName: "Tên tham số",
  paramValue: "Giá trị",
  paramRemove: (name: string) => `Xoá tham số ${name || "chưa đặt tên"}`,
  promoteOn: "Đẩy từ môi trường khác (cùng build)",
  promoteFrom: "Môi trường nguồn",
  promoteFromNone: "Chọn môi trường",
  promoteParam: "Tham số nhận số build",
  rollbackOn: "Có job quay lại riêng",
  rollbackJob: "Đường dẫn job quay lại",
  jobName: "Tên job GitLab",
  application: "Tên application Argo CD",
  credential: "Credential trên máy chạy",
  credentialHint:
    "Tên credential trong kho bí mật của máy chạy deploy, ví dụ jenkins-ci. Hub chỉ giữ tên, không giữ giá trị.",
  syncToRevision: "Đồng bộ tới đúng commit đã chọn",
  namespace: "Namespace",
  kind: "Loại workload",
  workload: "Tên workload",
  container: "Tên container",
  imageTemplate: "Mẫu image",
  imageHint: "Phải có {{tag}}, ví dụ registry.example.com/app:{{tag}}.",
  health: "Health check",
  healthOn: "Kiểm health sau khi triển khai",
  healthUrl: "URL health",
  healthStatus: "Mã HTTP mong đợi",
  healthMatchPath: "Trường JSON cần khớp",
  healthMatchEquals: "Giá trị cần khớp",
  healthMatchHint: "Bỏ trống trường JSON là chỉ kiểm mã HTTP. {{commit8}} là 8 ký tự đầu của commit.",
  healthTimeout: "Chờ tối đa (giây)",
  healthInterval: "Thử lại mỗi (giây)",
  cancel: "Huỷ",
  save: "Lưu đích",
  saving: "Đang lưu…",
  conflictTitle: "Đích này vừa được người khác sửa.",
  conflictBody: "Tải cấu hình mới để xem thay đổi, rồi áp lại phần bạn sửa. Biến bí mật phải nhập lại.",
  conflictReload: "Tải cấu hình mới",
  conflictReloading: "Đang tải…",
  conflictReloaded: "Đã tải cấu hình mới. Kiểm lại các ô rồi lưu.",
  required: "Không được để trống.",
  unknownIssue: (path: string, message: string) => (path ? `${message} (${path})` : message),
};

// Đường dẫn trong cấu hình (lỗi của zod) -> khoá lỗi của ô trên form.
const PATH_TO_FIELD: Record<string, string> = {
  "steps.precheck.script": "precheck",
  "steps.precheck.timeoutSec": "precheckTimeout",
  "steps.backup.script": "backup",
  "steps.backup.timeoutSec": "backupTimeout",
  "steps.deploy.script": "deploy",
  "steps.deploy.timeoutSec": "deployTimeout",
  name: "workload",
};

function issueField(path: readonly unknown[]): string {
  const keys = path.map((p) => String(typeof p === "object" && p !== null && "key" in p ? p.key : p));
  if (keys[0] === "config") keys.shift();
  const joined = keys.join(".");
  return PATH_TO_FIELD[joined] ?? joined;
}

function serverIssue(error: unknown): { field: string; message: string } | null {
  if (!(error instanceof ORPCError) || error.code !== "BAD_REQUEST") return null;
  const data: unknown = error.data;
  if (typeof data !== "object" || data === null || !("issues" in data) || !Array.isArray(data.issues)) return null;
  const issue = data.issues[0] as { message?: unknown; path?: unknown } | undefined;
  if (!issue || typeof issue.message !== "string" || !Array.isArray(issue.path)) return null;
  return { field: issueField(issue.path), message: issue.message };
}

function TextField({
  label,
  value,
  onChange,
  error,
  hint,
  mono = false,
  type = "text",
  placeholder,
  disabled,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  hint?: ReactNode;
  mono?: boolean;
  type?: string;
  placeholder?: string | undefined;
  disabled?: boolean;
  inputMode?: "numeric";
}) {
  return (
    <Field invalid={error !== undefined}>
      <FieldLabel>{label}</FieldLabel>
      <Input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        inputMode={inputMode}
        {...(mono ? { className: "font-mono" } : {})}
      />
      {error ? <FieldError>{error}</FieldError> : hint ? <FieldHint>{hint}</FieldHint> : null}
    </Field>
  );
}

function ScriptField({
  label,
  value,
  onChange,
  error,
  timeout,
  onTimeout,
  timeoutError,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  timeout: string;
  onTimeout: (value: string) => void;
  timeoutError?: string | undefined;
}) {
  return (
    <div className="grid gap-2">
      <Field invalid={error !== undefined}>
        <FieldLabel>{label}</FieldLabel>
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={8}
          spellCheck={false}
          className="font-mono text-xs"
        />
        {error && <FieldError>{error}</FieldError>}
      </Field>
      <div className="max-w-40">
        <TextField label={VI.timeout} value={timeout} onChange={onTimeout} error={timeoutError} inputMode="numeric" />
      </div>
    </div>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex min-h-9 items-center gap-2 text-sm text-foreground">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 accent-primary"
      />
      {label}
    </label>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="grid min-w-0 gap-3 rounded-lg border border-border p-3">
      <legend className="px-1 text-sm font-medium text-foreground">{title}</legend>
      {children}
    </fieldset>
  );
}

function SelectField({
  label,
  value,
  onChange,
  placeholder,
  options,
  error,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  options: { id: string; label: string }[];
  error?: string | undefined;
  hint?: string | undefined;
}) {
  return (
    <Field invalid={error !== undefined}>
      <FieldLabel>{label}</FieldLabel>
      <NativeSelect aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="w-full">
        <NativeSelectOption value="">{placeholder}</NativeSelectOption>
        {options.map((o) => (
          <NativeSelectOption key={o.id} value={o.id}>
            {o.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {error ? <FieldError>{error}</FieldError> : hint ? <FieldHint>{hint}</FieldHint> : null}
    </Field>
  );
}

function PairList({
  items,
  onChange,
  nameLabel,
  valueLabel,
  addLabel,
  removeLabel,
}: {
  items: ParamDraft[];
  onChange: (items: ParamDraft[]) => void;
  nameLabel: string;
  valueLabel: string;
  addLabel: string;
  removeLabel: (name: string) => string;
}) {
  return (
    <div className="grid gap-2">
      {items.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: dòng không có id, thứ tự là danh tính
        <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
          <TextField
            label={nameLabel}
            value={p.name}
            mono
            onChange={(name) => onChange(items.map((x, j) => (j === i ? { ...x, name } : x)))}
          />
          <TextField
            label={valueLabel}
            value={p.value}
            mono
            onChange={(value) => onChange(items.map((x, j) => (j === i ? { ...x, value } : x)))}
          />
          <Button
            variant="ghost"
            size="sm"
            aria-label={removeLabel(p.name)}
            onClick={() => onChange(items.filter((_, j) => j !== i))}
          >
            Xoá
          </Button>
        </div>
      ))}
      <div>
        <Button variant="outline" size="sm" onClick={() => onChange([...items, { name: "", value: "" }])}>
          {addLabel}
        </Button>
      </div>
    </div>
  );
}

function VariableList({
  items,
  onChange,
  errors,
}: {
  items: VariableDraft[];
  onChange: (items: VariableDraft[]) => void;
  errors: Record<string, string>;
}) {
  const patch = (i: number, p: Partial<VariableDraft>) => onChange(items.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <div className="grid gap-3">
      {items.map((v, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: dòng không có id, thứ tự là danh tính
        <div key={i} className="grid gap-2 rounded-lg bg-muted/40 p-2">
          <div className="grid grid-cols-[1fr_auto] items-end gap-2">
            <TextField
              label={VI.varName}
              value={v.name}
              mono
              error={errors[`variables.${i}.name`]}
              onChange={(name) => patch(i, { name })}
            />
            <Button
              variant="ghost"
              size="sm"
              aria-label={VI.varRemove(v.name)}
              onClick={() => onChange(items.filter((_, j) => j !== i))}
            >
              Xoá
            </Button>
          </div>
          <TextField
            label={VI.varValue}
            value={v.value}
            mono
            type={v.secret ? "password" : "text"}
            placeholder={v.secret && v.stored ? "••••••••" : undefined}
            hint={v.secret && v.stored ? VI.varStored : undefined}
            error={errors[`variables.${i}.value`]}
            onChange={(value) => patch(i, { value })}
          />
          <Check
            label={VI.varSecret}
            checked={v.secret}
            onChange={(secret) => patch(i, { secret, stored: secret ? v.stored : false })}
          />
        </div>
      ))}
      <div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onChange([...items, { name: "", secret: false, value: "", stored: false }])}
        >
          {VI.addVariable}
        </Button>
      </div>
    </div>
  );
}

export interface TargetFormProps {
  projectId: string;
  environmentId: string;
  projectName: string;
  environmentName: string;
  target: DeployTarget | null;
  servers: DeployServer[];
  jenkins: JenkinsConnection[];
  infra: InfraConnection[];
  /** Các môi trường khác của hệ thống, làm nguồn cho "đẩy từ môi trường khác". */
  otherEnvironments: DeployEnvironment[];
  onDone: () => void;
}

export function TargetForm(props: TargetFormProps) {
  const { projectId, environmentId, target, servers, jenkins, infra, otherEnvironments, onDone } = props;
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<TargetDraft>(() =>
    target ? draftFromConfig(target.config) : emptyDraft("ssh-script"),
  );
  const [version, setVersion] = useState<number | null>(target?.configVersion ?? null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [reloaded, setReloaded] = useState(false);
  const [presetId, setPresetId] = useState("");

  const set = <K extends keyof TargetDraft>(key: K, value: TargetDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const e = (key: string) => errors[key];

  const save = useMutation({
    mutationFn: (config: ReturnType<typeof draftToConfig>) =>
      api.deployTargets.upsert.call({
        projectId,
        environmentId,
        config: config as never,
        expectedConfigVersion: version,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: api.deployTargets.key() });
      onDone();
    },
    onError: (error) => {
      if (apiErrorCode(error) === "TARGET_VERSION_CONFLICT") {
        setConflict(true);
        return;
      }
      const issue = serverIssue(error);
      if (issue) setErrors({ [issue.field]: issue.message });
      else setFailure(apiErrorMessage(error));
    },
  });

  const reload = useMutation({
    mutationFn: () => api.deployTargets.get.call({ id: (target as DeployTarget).id }),
    onSuccess: (fresh) => {
      setDraft(draftFromConfig(fresh.config));
      setVersion(fresh.configVersion);
      setConflict(false);
      setReloaded(true);
      setErrors({});
    },
    onError: (error) => setFailure(apiErrorMessage(error)),
  });

  function onSubmit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    setFailure(null);
    setReloaded(false);
    const own = validateDraft(draft);
    const config = draftToConfig(draft);
    const parsed = targetUpsertInput.safeParse({
      projectId,
      environmentId,
      config,
      expectedConfigVersion: version,
    });
    const next = { ...own };
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issueField(issue.path);
        if (next[field] === undefined) next[field] = issue.message;
      }
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    save.mutate(config);
  }

  function applyPreset(id: string) {
    setPresetId(id);
    const preset = presetById(id);
    if (preset) setDraft({ ...preset.draft(), serverId: draft.serverId });
  }

  const busy = save.isPending || reload.isPending;
  const serverOptions = servers.map((s) => ({ id: s.id, label: `${s.name} (${s.user}@${s.host})` }));
  const jenkinsOptions = jenkins.map((c) => ({ id: c.id, label: c.name }));
  const infraKind = draft.method === "kubectl" ? "kubernetes" : "argocd";
  const infraOptions = infra.filter((c) => c.kind === infraKind).map((c) => ({ id: c.id, label: c.name }));
  const connectionOptions = draft.method === "jenkins-job" ? jenkinsOptions : infraOptions;

  return (
    <form noValidate onSubmit={onSubmit} className="grid gap-3.5">
      <DialogTitle>{(target ? VI.editTitle : VI.addTitle)(props.projectName, props.environmentName)}</DialogTitle>
      <DialogDescription>{VI.lead}</DialogDescription>

      <Field>
        <FieldLabel>{VI.method}</FieldLabel>
        <NativeSelect
          aria-label={VI.method}
          value={draft.method}
          disabled={target !== null || busy}
          onChange={(ev) => {
            setPresetId("");
            setDraft(emptyDraft(ev.target.value as TargetDraft["method"]));
          }}
          className="w-full"
        >
          {DEPLOY_METHODS.map((m) => (
            <NativeSelectOption key={m} value={m}>
              {DEPLOY_METHOD_LABEL[m]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>

      {!target && draft.method === "ssh-script" && (
        <Field>
          <FieldLabel>{VI.preset}</FieldLabel>
          <NativeSelect
            aria-label={VI.preset}
            value={presetId}
            onChange={(ev) => applyPreset(ev.target.value)}
            className="w-full"
          >
            <NativeSelectOption value="">{VI.presetNone}</NativeSelectOption>
            {TARGET_PRESETS.map((p) => (
              <NativeSelectOption key={p.id} value={p.id}>
                {p.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <FieldHint>{presetById(presetId)?.description ?? VI.presetHint}</FieldHint>
        </Field>
      )}

      {draft.method === "ssh-script" && (
        <>
          <SelectField
            label={VI.server}
            value={draft.serverId}
            onChange={(v) => set("serverId", v)}
            placeholder={VI.serverNone}
            options={serverOptions}
            error={e("serverId")}
            hint={servers.length === 0 ? VI.noServers : undefined}
          />
          <TextField
            label={VI.workdir}
            value={draft.workdir}
            mono
            error={e("workdir")}
            onChange={(v) => set("workdir", v)}
          />
          <TextField
            label={VI.composeProject}
            value={draft.composeProject}
            mono
            error={e("composeProject")}
            onChange={(v) => set("composeProject", v)}
          />
          <ScriptField
            label={VI.precheck}
            value={draft.precheck}
            onChange={(v) => set("precheck", v)}
            error={e("precheck")}
            timeout={draft.precheckTimeout}
            onTimeout={(v) => set("precheckTimeout", v)}
            timeoutError={e("precheckTimeout")}
          />
          <Check label={VI.backupOn} checked={draft.backupOn} onChange={(v) => set("backupOn", v)} />
          {draft.backupOn && (
            <ScriptField
              label={VI.backup}
              value={draft.backup}
              onChange={(v) => set("backup", v)}
              error={e("backup")}
              timeout={draft.backupTimeout}
              onTimeout={(v) => set("backupTimeout", v)}
              timeoutError={e("backupTimeout")}
            />
          )}
          <Field>
            <FieldLabel>{VI.upload}</FieldLabel>
            <NativeSelect
              aria-label={VI.upload}
              value={draft.uploadMode}
              onChange={(ev) => set("uploadMode", ev.target.value as TargetDraft["uploadMode"])}
              className="w-full"
            >
              <NativeSelectOption value="git-archive">{VI.uploadGit}</NativeSelectOption>
              <NativeSelectOption value="none">{VI.uploadNone}</NativeSelectOption>
            </NativeSelect>
          </Field>
          <ScriptField
            label={VI.deploy}
            value={draft.deploy}
            onChange={(v) => set("deploy", v)}
            error={e("deploy")}
            timeout={draft.deployTimeout}
            onTimeout={(v) => set("deployTimeout", v)}
            timeoutError={e("deployTimeout")}
          />
          <Group title={VI.variables}>
            <VariableList items={draft.variables} onChange={(v) => set("variables", v)} errors={errors} />
          </Group>
        </>
      )}

      {(draft.method === "jenkins-job" || draft.method === "argocd" || draft.method === "kubectl") && (
        <SelectField
          label={VI.connection}
          value={draft.connectionId}
          onChange={(v) => set("connectionId", v)}
          placeholder={VI.connectionNone}
          options={connectionOptions}
          error={e("connectionId")}
          hint={connectionOptions.length === 0 ? VI.noConnections : undefined}
        />
      )}

      {(draft.method === "jenkins-job" || draft.method === "argocd") && (
        <TextField
          label={VI.credential}
          value={draft.credential}
          mono
          placeholder="jenkins-ci"
          error={e("credential")}
          hint={VI.credentialHint}
          onChange={(v) => set("credential", v)}
        />
      )}

      {draft.method === "jenkins-job" && (
        <>
          <TextField
            label={VI.jobPath}
            value={draft.jobPath}
            mono
            error={e("jobPath")}
            onChange={(v) => set("jobPath", v)}
          />
          <Group title={VI.params}>
            <PairList
              items={draft.params}
              onChange={(v) => set("params", v)}
              nameLabel={VI.paramName}
              valueLabel={VI.paramValue}
              addLabel={VI.addParam}
              removeLabel={VI.paramRemove}
            />
          </Group>
          <Check label={VI.promoteOn} checked={draft.promoteOn} onChange={(v) => set("promoteOn", v)} />
          {draft.promoteOn && (
            <>
              <SelectField
                label={VI.promoteFrom}
                value={draft.promoteFrom}
                onChange={(v) => set("promoteFrom", v)}
                placeholder={VI.promoteFromNone}
                options={otherEnvironments.map((x) => ({ id: x.id, label: x.name }))}
                error={e("promote.fromEnvironmentId")}
              />
              <TextField
                label={VI.promoteParam}
                value={draft.promoteParam}
                mono
                error={e("promote.buildParam")}
                onChange={(v) => set("promoteParam", v)}
              />
            </>
          )}
          <Check label={VI.rollbackOn} checked={draft.rollbackOn} onChange={(v) => set("rollbackOn", v)} />
          {draft.rollbackOn && (
            <>
              <TextField
                label={VI.rollbackJob}
                value={draft.rollbackJobPath}
                mono
                error={e("rollbackJob.jobPath")}
                onChange={(v) => set("rollbackJobPath", v)}
              />
              <Group title={VI.params}>
                <PairList
                  items={draft.rollbackParams}
                  onChange={(v) => set("rollbackParams", v)}
                  nameLabel={VI.paramName}
                  valueLabel={VI.paramValue}
                  addLabel={VI.addParam}
                  removeLabel={VI.paramRemove}
                />
              </Group>
            </>
          )}
        </>
      )}

      {draft.method === "gitlab-manual" && (
        <TextField label={VI.jobName} value={draft.jobName} error={e("jobName")} onChange={(v) => set("jobName", v)} />
      )}

      {draft.method === "argocd" && (
        <>
          <TextField
            label={VI.application}
            value={draft.application}
            mono
            error={e("application")}
            onChange={(v) => set("application", v)}
          />
          <Check label={VI.syncToRevision} checked={draft.syncToRevision} onChange={(v) => set("syncToRevision", v)} />
          <div className="max-w-40">
            <TextField
              label={VI.timeout}
              value={draft.timeoutSec}
              inputMode="numeric"
              error={e("timeoutSec")}
              onChange={(v) => set("timeoutSec", v)}
            />
          </div>
        </>
      )}

      {draft.method === "kubectl" && (
        <>
          <TextField
            label={VI.namespace}
            value={draft.namespace}
            mono
            error={e("namespace")}
            onChange={(v) => set("namespace", v)}
          />
          <Field>
            <FieldLabel>{VI.kind}</FieldLabel>
            <NativeSelect
              aria-label={VI.kind}
              value={draft.kind}
              onChange={(ev) => set("kind", ev.target.value as TargetDraft["kind"])}
              className="w-full"
            >
              <NativeSelectOption value="Deployment">Deployment</NativeSelectOption>
              <NativeSelectOption value="StatefulSet">StatefulSet</NativeSelectOption>
            </NativeSelect>
          </Field>
          <TextField
            label={VI.workload}
            value={draft.workload}
            mono
            error={e("workload")}
            onChange={(v) => set("workload", v)}
          />
          <TextField
            label={VI.container}
            value={draft.container}
            mono
            error={e("container")}
            onChange={(v) => set("container", v)}
          />
          <TextField
            label={VI.imageTemplate}
            value={draft.imageTemplate}
            mono
            error={e("imageTemplate")}
            hint={VI.imageHint}
            onChange={(v) => set("imageTemplate", v)}
          />
          <div className="max-w-40">
            <TextField
              label={VI.timeout}
              value={draft.timeoutSec}
              inputMode="numeric"
              error={e("timeoutSec")}
              onChange={(v) => set("timeoutSec", v)}
            />
          </div>
        </>
      )}

      {draft.method !== "kubectl" && (
        <TextField
          label={VI.branch}
          value={draft.branch}
          mono
          error={e("branch")}
          hint={VI.branchHint}
          onChange={(v) => set("branch", v)}
        />
      )}

      <Group title={VI.health}>
        <Check label={VI.healthOn} checked={draft.healthOn} onChange={(v) => set("healthOn", v)} />
        {draft.healthOn && (
          <>
            <TextField
              label={VI.healthUrl}
              value={draft.healthUrl}
              mono
              type="url"
              error={e("health.url")}
              onChange={(v) => set("healthUrl", v)}
            />
            <div className="grid grid-cols-3 gap-2">
              <TextField
                label={VI.healthStatus}
                value={draft.healthStatus}
                inputMode="numeric"
                error={e("health.expectStatus")}
                onChange={(v) => set("healthStatus", v)}
              />
              <TextField
                label={VI.healthTimeout}
                value={draft.healthTimeout}
                inputMode="numeric"
                error={e("health.timeoutSec")}
                onChange={(v) => set("healthTimeout", v)}
              />
              <TextField
                label={VI.healthInterval}
                value={draft.healthInterval}
                inputMode="numeric"
                error={e("health.intervalSec")}
                onChange={(v) => set("healthInterval", v)}
              />
            </div>
            <TextField
              label={VI.healthMatchPath}
              value={draft.healthMatchPath}
              mono
              error={e("health.match.path")}
              onChange={(v) => set("healthMatchPath", v)}
            />
            <TextField
              label={VI.healthMatchEquals}
              value={draft.healthMatchEquals}
              mono
              error={e("health.match.equals")}
              hint={VI.healthMatchHint}
              onChange={(v) => set("healthMatchEquals", v)}
            />
          </>
        )}
      </Group>

      {conflict && (
        <Alert variant="destructive" className="grid justify-items-start gap-2" role="alert">
          <strong>{VI.conflictTitle}</strong>
          <span>{VI.conflictBody}</span>
          <Button variant="outline" size="sm" disabled={reload.isPending} onClick={() => reload.mutate()}>
            {reload.isPending ? VI.conflictReloading : VI.conflictReload}
          </Button>
        </Alert>
      )}
      {reloaded && <Alert role="status">{VI.conflictReloaded}</Alert>}
      {failure && <Alert variant="destructive">{failure}</Alert>}

      <DialogActions>
        <Button variant="outline" onClick={onDone}>
          {VI.cancel}
        </Button>
        <Button type="submit" variant="default" disabled={busy || conflict}>
          {save.isPending ? VI.saving : VI.save}
        </Button>
      </DialogActions>
    </form>
  );
}
