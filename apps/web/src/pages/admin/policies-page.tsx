import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AgentPolicy,
  AgentPolicyInput,
  HookEvent,
  InstructionTemplates,
  PolicyHook,
  TemplatePreview,
} from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@xdev-hive/ui/dialog";
import { Input } from "@xdev-hive/ui/input";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { Textarea } from "@xdev-hive/ui/textarea";
import { PlusIcon, XIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useId, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { usePermissions } from "@/lib/permissions.ts";
import { isOrgAdmin } from "@/lib/roles.ts";
import { cn } from "@/lib/utils.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

type Cli = keyof AgentPolicyInput["allowedModels"];
type TemplateKey = keyof InstructionTemplates;
type Form = Omit<AgentPolicy, "updatedAt" | "updatedBy" | "templateSync" | "defaultTemplates">;

const CLIS: { id: Cli; name: string }[] = [
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "gemini", name: "Gemini CLI" },
  { id: "antigravity", name: "Antigravity" },
];
const TEMPLATE_FILES: { id: TemplateKey; path: string }[] = [
  { id: "agents", path: "AGENTS.md" },
  { id: "claude", path: "CLAUDE.md" },
  { id: "mcp", path: ".mcp.json" },
];
const EVENTS: HookEvent[] = ["PreToolUse", "PostToolUse", "Stop"];

const text: Dict<{
  crumb: string;
  title: string;
  lead: string;
  preview: string;
  save: string;
  saving: string;
  saved: string;
  readOnly: string;
  modelHint: string;
  anyModel: string;
  remove: (name: string) => string;
  add: string;
  addModel: (cli: string) => string;
  neverAuto: string;
  neverAutoHint: string;
  perm: string;
  permHint: string;
  defaultPerm: string;
  wt: string;
  full: string;
  allowFull: string;
  allowFullHint: string;
  ownerOnly: string;
  sandboxReq: string;
  sandboxReqHint: string;
  hooksHint: string;
  managedOnly: string;
  managedOnlyHint: string;
  noHooks: string;
  edit: string;
  addHook: string;
  hookTitle: string;
  hookDesc: string;
  hookEvent: string;
  hookName: string;
  hookCommand: string;
  hookMatcher: string;
  hookMatcherHint: string;
  eventHint: Record<HookEvent, string>;
  hookRemove: string;
  done: string;
  cancel: string;
  instr: string;
  instrHint: string;
  standard: string;
  custom: string;
  restore: string;
  variables: string;
  keepSync: string;
  keepSyncHint: string;
  syncNow: string;
  syncQueued: string;
  lastSync: (opened: number, unchanged: number, failed: number, at: string) => string;
  limits: string;
  limitsHint: string;
  runBudget: string;
  dayBudget: string;
  parallel: string;
  retention: string;
  days: string;
  unlimited: string;
  usd: string;
  previewTitle: string;
  previewDesc: string;
  project: string;
  projectPlaceholder: string;
  show: string;
  close: string;
  unsaved: string;
}> = {
  vi: {
    crumb: "Quản trị agent",
    title: "Chính sách agent",
    lead: "Áp cho mọi run trong tổ chức. Hub ghi vào managed settings của CLI trên máy nhận việc; dự án không vượt được.",
    preview: "Xem file sinh ra",
    save: "Lưu chính sách",
    saving: "Đang lưu…",
    saved: "Đã lưu chính sách.",
    readOnly: "Bạn chỉ xem được chính sách. Cần quyền “Sửa chính sách agent” để thay đổi.",
    modelHint: "Model mà dự án được chọn. Dự án chọn model ngoài danh sách thì run dùng model đầu tiên.",
    anyModel: "Mọi model",
    remove: (name) => `Gỡ ${name}`,
    add: "Thêm",
    addModel: (cli) => `Model cho ${cli}`,
    neverAuto: "Không tự lên model đắt nhất",
    neverAutoHint: "Run không chỉ định model thì dùng model đầu danh sách, không để CLI tự chọn fast, max hay Fable.",
    perm: "Quyền CLI",
    permHint: "Mặc định cho dự án mới và giới hạn trên cho mọi dự án.",
    defaultPerm: "Mặc định cho dự án mới",
    wt: "Trong worktree (khuyên dùng)",
    full: "Toàn quyền",
    allowFull: "Cho dự án bật toàn quyền",
    allowFullHint: "Tắt thì nút Toàn quyền trong cấu hình dự án bị khoá; run của dự án đang bật chạy trong worktree.",
    ownerOnly: "Mở lại cần quyền “Cho phép CLI toàn quyền” (mặc định chỉ owner).",
    sandboxReq: "Bắt buộc sandbox",
    sandboxReqHint: "Mọi run code phải chạy trong container gVisor trên runner host.",
    hooksHint: "Lệnh chạy chắc chắn ở các mốc của CLI: trước khi gọi tool, sau khi sửa file, khi kết thúc.",
    managedOnly: "Chỉ chạy hook của tổ chức",
    managedOnlyHint: "Bỏ qua hook và cấu hình .claude/settings.json trong repo.",
    noHooks: "Chưa có hook nào.",
    edit: "Sửa",
    addHook: "Thêm hook",
    hookTitle: "Hook của tổ chức",
    hookDesc: "Worker chạy lệnh này trong worktree của run. Hook Stop lỗi thì run lỗi và không push.",
    hookEvent: "Mốc",
    hookName: "Tên",
    hookCommand: "Lệnh",
    hookMatcher: "Tool cần khớp",
    hookMatcherHint: "Cú pháp matcher của Claude Code, ví dụ Bash hoặc Edit|Write. Bỏ trống là mọi tool.",
    eventHint: {
      PreToolUse: "Trước mỗi lần gọi tool. Chỉ Claude Code chạy được.",
      PostToolUse: "Sau mỗi lần gọi tool. Chỉ Claude Code chạy được.",
      Stop: "Khi agent xong, trước khi worker push. Chạy với mọi CLI.",
    },
    hookRemove: "Xoá hook",
    done: "Xong",
    cancel: "Huỷ",
    instr: "File hướng dẫn agent",
    instrHint: "Mẫu hub commit vào repo khi tạo dự án.",
    standard: "Mẫu chuẩn",
    custom: "Đã sửa",
    restore: "Dùng mẫu chuẩn",
    variables: "Biến: {{project.name}}, {{project.key}}, {{project.branch}}, {{system.name}}, {{mcp.url}}",
    keepSync: "Mở PR khi mẫu đổi",
    keepSyncHint: "Hub mở PR cập nhật file hướng dẫn cho mọi dự án đang hoạt động.",
    syncNow: "Mở PR ngay",
    syncQueued: "Đã xếp việc mở PR cho các dự án.",
    lastSync: (opened, unchanged, failed, at) =>
      `Lần gần nhất (${at}): mở ${opened} PR, ${unchanged} dự án đã đúng mẫu${failed ? `, ${failed} lỗi` : ""}.`,
    limits: "Giới hạn chung",
    limitsHint: "Trần cho mọi dự án; dự án đặt thấp hơn được, cao hơn thì không.",
    runBudget: "Trần mỗi run",
    dayBudget: "Trần mỗi ngày của tổ chức",
    parallel: "Run song song mỗi máy",
    retention: "Giữ log run",
    days: "ngày",
    unlimited: "Không giới hạn",
    usd: "USD",
    previewTitle: "File sinh ra từ mẫu",
    previewDesc: "Điền biến của một dự án vào mẫu đang sửa (chưa cần lưu).",
    project: "Dự án",
    projectPlaceholder: "project key, bỏ trống là dự án mẫu",
    show: "Xem",
    close: "Đóng",
    unsaved: "Có thay đổi chưa lưu.",
  },
  en: {
    crumb: "Agent governance",
    title: "Agent policies",
    lead: "Applies to every run in the organization. The hub writes it to the CLI managed settings on run machines; projects cannot override it.",
    preview: "Preview generated files",
    save: "Save policy",
    saving: "Saving…",
    saved: "Policy saved.",
    readOnly: "You can only view the policy. Editing needs the “Edit agent policies” permission.",
    modelHint: "Models projects may pick. Anything else falls back to the first model.",
    anyModel: "Any model",
    remove: (name) => `Remove ${name}`,
    add: "Add",
    addModel: (cli) => `Model for ${cli}`,
    neverAuto: "Never auto-upgrade to the priciest model",
    neverAutoHint:
      "Runs without a model use the first model in the list instead of letting the CLI pick fast, max or Fable.",
    perm: "CLI permissions",
    permHint: "Default for new projects and the upper bound for all.",
    defaultPerm: "Default for new projects",
    wt: "Inside the worktree (recommended)",
    full: "Full access",
    allowFull: "Let projects enable full access",
    allowFullHint:
      "When off, the Full access option in project settings is locked and full-access projects run in the worktree.",
    ownerOnly: "Turning it back on needs the “Allow full-access CLI” permission (owners by default).",
    sandboxReq: "Require sandbox",
    sandboxReqHint: "Every code run must run in a gVisor container on a runner host.",
    hooksHint: "Commands that always run at CLI events: before a tool call, after edits, at the end.",
    managedOnly: "Only run organization hooks",
    managedOnlyHint: "Ignore hooks and .claude/settings.json from repositories.",
    noHooks: "No hooks yet.",
    edit: "Edit",
    addHook: "Add hook",
    hookTitle: "Organization hook",
    hookDesc:
      "The worker runs this command in the run's worktree. A failing Stop hook fails the run and skips the push.",
    hookEvent: "Event",
    hookName: "Name",
    hookCommand: "Command",
    hookMatcher: "Tool matcher",
    hookMatcherHint: "Claude Code matcher syntax, e.g. Bash or Edit|Write. Leave empty for every tool.",
    eventHint: {
      PreToolUse: "Before every tool call. Claude Code only.",
      PostToolUse: "After every tool call. Claude Code only.",
      Stop: "When the agent finishes, before the worker pushes. Every CLI.",
    },
    hookRemove: "Delete hook",
    done: "Done",
    cancel: "Cancel",
    instr: "Agent instruction files",
    instrHint: "Templates the hub commits to the repo when a project is created.",
    standard: "Standard",
    custom: "Edited",
    restore: "Use the standard template",
    variables: "Variables: {{project.name}}, {{project.key}}, {{project.branch}}, {{system.name}}, {{mcp.url}}",
    keepSync: "Open a PR when the template changes",
    keepSyncHint: "The hub opens a PR updating the instruction files in every active project.",
    syncNow: "Open PRs now",
    syncQueued: "Queued PRs for the projects.",
    lastSync: (opened, unchanged, failed, at) =>
      `Last run (${at}): opened ${opened} PRs, ${unchanged} projects already up to date${failed ? `, ${failed} failed` : ""}.`,
    limits: "Global limits",
    limitsHint: "Ceilings for every project; projects can go lower, not higher.",
    runBudget: "Per-run cap",
    dayBudget: "Organization daily cap",
    parallel: "Parallel runs per machine",
    retention: "Keep run logs",
    days: "days",
    unlimited: "No limit",
    usd: "USD",
    previewTitle: "Generated files",
    previewDesc: "Fill a project's variables into the template being edited (no need to save first).",
    project: "Project",
    projectPlaceholder: "project key, empty for a sample project",
    show: "Show",
    close: "Close",
    unsaved: "You have unsaved changes.",
  },
};

const formOf = (p: AgentPolicy): Form => ({
  allowedModels: p.allowedModels,
  neverAutoUpgrade: p.neverAutoUpgrade,
  defaultPermissionMode: p.defaultPermissionMode,
  allowFullPermission: p.allowFullPermission,
  requireSandbox: p.requireSandbox,
  hooks: p.hooks,
  managedHooksOnly: p.managedHooksOnly,
  templates: p.templates,
  autoSyncTemplates: p.autoSyncTemplates,
  limits: p.limits,
});

function PolicyCard({
  title,
  hint,
  className,
  children,
}: {
  title: string;
  hint: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="text-[15px]">{title}</CardTitle>
        <CardDescription>{hint}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3.5">{children}</CardContent>
    </Card>
  );
}

function SwitchRow({
  label,
  hint,
  checked,
  onChange,
  disabled,
  danger,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean | undefined;
  danger?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <label htmlFor={id} className="grid cursor-pointer gap-0.5">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </label>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        aria-label={label}
        className={cn(danger && "data-checked:bg-destructive")}
      />
    </div>
  );
}

/** Ô số có thể bỏ trống (không giới hạn). */
function LimitInput({
  label,
  unit,
  value,
  onChange,
  disabled,
  step,
  placeholder,
}: {
  label: string;
  unit?: string;
  value: number | null;
  onChange: (v: number | null) => void;
  disabled: boolean;
  step: string;
  placeholder: string;
}) {
  const id = useId();
  const [raw, setRaw] = useState(value === null ? "" : String(value));
  useEffect(() => setRaw(value === null ? "" : String(value)), [value]);
  return (
    <div className="flex flex-col gap-1.5 text-[13px] font-medium">
      <label htmlFor={id}>{label}</label>
      <Input
        id={id}
        type="number"
        min="0"
        step={step}
        inputMode="decimal"
        className="font-mono"
        value={raw}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => {
          setRaw(e.target.value);
          const n = Number(e.target.value);
          onChange(e.target.value.trim() === "" || !Number.isFinite(n) || n <= 0 ? null : n);
        }}
      />
      {unit && <span className="text-xs font-normal text-muted-foreground">{unit}</span>}
    </div>
  );
}

/** Chính sách agent của tổ chức (Policies.dc.html): model, quyền CLI, hook, file hướng dẫn, giới hạn chung. */
export function PoliciesPage() {
  const { org, api } = useOrg();
  const t = useT(text);
  const lang = useLang();
  const can = usePermissions();
  const canWrite = isOrgAdmin(org.role) || can("policies.write");
  const canFull = can("policies.fullaccess");
  const queryClient = useQueryClient();
  const policy = useQuery(api.policies.get.queryOptions());
  const [form, setForm] = useState<Form | null>(null);
  const [saved, setSaved] = useState(false);
  const [tab, setTab] = useState<TemplateKey>("agents");
  const [editingHook, setEditingHook] = useState<{ index: number | null; hook: PolicyHook } | null>(null);
  const [adding, setAdding] = useState<Cli | null>(null);
  const [newModel, setNewModel] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);

  useEffect(() => {
    if (policy.data && !form) setForm(formOf(policy.data));
  }, [policy.data, form]);

  const save = useMutation({
    mutationFn: (f: Form) => api.policies.update.call(f),
    onSuccess: (next) => {
      queryClient.setQueryData(api.policies.get.queryKey(), next);
      setForm(formOf(next));
      setSaved(true);
    },
  });
  const sync = useMutation({ mutationFn: () => api.policies.syncTemplates.call({}) });

  if (policy.isPending || (!form && !policy.isError)) {
    return (
      <>
        <PageHeader crumb={t.crumb} title={t.title} />
        <PageBody>
          <LoadingState />
        </PageBody>
      </>
    );
  }
  if (policy.isError || !form || !policy.data) {
    return (
      <>
        <PageHeader crumb={t.crumb} title={t.title} />
        <PageBody>
          <LoadFailure error={policy.error} retry={() => policy.refetch()} />
        </PageBody>
      </>
    );
  }

  const disabled = !canWrite || save.isPending;
  const dirty = JSON.stringify(form) !== JSON.stringify(formOf(policy.data));
  const update = (patch: Partial<Form>) => {
    setSaved(false);
    setForm({ ...form, ...patch });
  };
  const defaults = policy.data.defaultTemplates;
  const templateText = form.templates[tab] ?? defaults[tab];
  // Đang tắt mà người sửa không có quyền mở lại: khoá công tắc để khỏi lưu rồi mới biết bị từ chối.
  const fullLocked = !policy.data.allowFullPermission && !canFull;

  function addModel(cli: Cli, e: FormEvent) {
    e.preventDefault();
    const name = newModel.trim();
    if (!name || !form) return;
    const list = form.allowedModels[cli];
    if (!list.includes(name)) update({ allowedModels: { ...form.allowedModels, [cli]: [...list, name] } });
    setNewModel("");
    setAdding(null);
  }

  const lastSync = policy.data.templateSync;

  return (
    <>
      <PageHeader crumb={t.crumb} title={t.title}>
        <Button variant="outline" onClick={() => setPreviewOpen(true)}>
          {t.preview}
        </Button>
        {canWrite && (
          <Button onClick={() => save.mutate(form)} disabled={disabled || !dirty}>
            {save.isPending ? t.saving : t.save}
          </Button>
        )}
      </PageHeader>
      <PageBody>
        <p className="-mt-2 max-w-3xl text-muted-foreground">{t.lead}</p>
        {!canWrite && <Alert>{t.readOnly}</Alert>}
        {save.isError && <Alert variant="destructive">{apiErrorMessage(save.error)}</Alert>}
        {saved && !dirty && (
          <p role="status" className="text-sm text-success">
            {t.saved}
          </p>
        )}
        {canWrite && dirty && <p className="text-sm text-muted-foreground">{t.unsaved}</p>}

        <div className="grid items-start gap-4 lg:grid-cols-2">
          <PolicyCard title="Model" hint={t.modelHint}>
            {CLIS.map((c) => (
              <div key={c.id} className="flex flex-col gap-1.5">
                <span className="text-[13px] font-medium">{c.name}</span>
                <div className="flex flex-wrap items-center gap-1.5">
                  {form.allowedModels[c.id].length === 0 && (
                    <span className="text-xs text-muted-foreground">{t.anyModel}</span>
                  )}
                  {form.allowedModels[c.id].map((m, i) => (
                    <span
                      key={m}
                      className={cn(
                        "inline-flex h-6.5 items-center gap-1.5 rounded-full border px-2.5 font-mono text-[12.5px]",
                        i === 0 && "border-transparent bg-accent text-accent-foreground",
                      )}
                    >
                      {m}
                      {canWrite && (
                        <button
                          type="button"
                          aria-label={t.remove(m)}
                          className="text-muted-foreground hover:text-foreground"
                          onClick={() =>
                            update({
                              allowedModels: {
                                ...form.allowedModels,
                                [c.id]: form.allowedModels[c.id].filter((x) => x !== m),
                              },
                            })
                          }
                        >
                          <XIcon className="size-3.5" aria-hidden="true" />
                        </button>
                      )}
                    </span>
                  ))}
                  {canWrite &&
                    (adding === c.id ? (
                      <form className="flex items-center gap-1.5" onSubmit={(e) => addModel(c.id, e)}>
                        <Input
                          autoFocus
                          aria-label={t.addModel(c.name)}
                          className="h-7 w-48 font-mono text-[12.5px]"
                          value={newModel}
                          onChange={(e) => setNewModel(e.target.value)}
                          onKeyDown={(e) => e.key === "Escape" && setAdding(null)}
                        />
                        <Button type="submit" size="sm" variant="outline">
                          {t.add}
                        </Button>
                      </form>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setAdding(c.id);
                          setNewModel("");
                        }}
                        aria-label={t.addModel(c.name)}
                      >
                        <PlusIcon aria-hidden="true" />
                        {t.add}
                      </Button>
                    ))}
                </div>
              </div>
            ))}
            <SwitchRow
              label={t.neverAuto}
              hint={t.neverAutoHint}
              checked={form.neverAutoUpgrade}
              onChange={(v) => update({ neverAutoUpgrade: v })}
              disabled={disabled}
            />
          </PolicyCard>

          <PolicyCard title={t.perm} hint={t.permHint}>
            <div className="flex flex-col gap-1.5 text-[13px] font-medium">
              <label htmlFor="policy-default-perm">{t.defaultPerm}</label>
              <NativeSelect
                id="policy-default-perm"
                value={form.defaultPermissionMode}
                disabled={disabled}
                onChange={(e) => update({ defaultPermissionMode: e.target.value as Form["defaultPermissionMode"] })}
              >
                <option value="workspace">{t.wt}</option>
                <option value="full" disabled={!form.allowFullPermission}>
                  {t.full}
                </option>
              </NativeSelect>
            </div>
            <SwitchRow
              label={t.allowFull}
              hint={fullLocked ? `${t.allowFullHint} ${t.ownerOnly}` : t.allowFullHint}
              checked={form.allowFullPermission}
              onChange={(v) =>
                update({
                  allowFullPermission: v,
                  ...(v ? {} : { defaultPermissionMode: "workspace" as const }),
                })
              }
              disabled={disabled || (fullLocked && !form.allowFullPermission)}
              danger
            />
            <SwitchRow
              label={t.sandboxReq}
              hint={t.sandboxReqHint}
              checked={form.requireSandbox}
              onChange={(v) => update({ requireSandbox: v })}
              disabled={disabled}
            />
          </PolicyCard>

          <PolicyCard title="Hooks" hint={t.hooksHint}>
            <SwitchRow
              label={t.managedOnly}
              hint={t.managedOnlyHint}
              checked={form.managedHooksOnly}
              onChange={(v) => update({ managedHooksOnly: v })}
              disabled={disabled}
            />
            {form.hooks.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">{t.noHooks}</p>
            ) : (
              <ul className="overflow-hidden rounded-[10px] border">
                {form.hooks.map((h, i) => (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: hook không có id; thứ tự là thứ tự chạy.
                    key={i}
                    className="flex items-center gap-2.5 border-b px-3 py-2.25 last:border-b-0"
                  >
                    <Pill className="font-mono">{h.event}</Pill>
                    <span className="flex min-w-0 flex-1 flex-col leading-snug">
                      <span className="text-[13.5px]">{h.name}</span>
                      <span className="truncate font-mono text-xs text-muted-foreground" title={h.command}>
                        {h.command}
                      </span>
                    </span>
                    {canWrite && (
                      <Button size="sm" variant="ghost" onClick={() => setEditingHook({ index: i, hook: h })}>
                        {t.edit}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canWrite && (
              <Button
                size="sm"
                variant="outline"
                className="self-start"
                onClick={() => setEditingHook({ index: null, hook: { event: "PreToolUse", name: "", command: "" } })}
              >
                <PlusIcon aria-hidden="true" />
                {t.addHook}
              </Button>
            )}
          </PolicyCard>

          <PolicyCard title={t.instr} hint={t.instrHint}>
            <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label={t.instr}>
              {TEMPLATE_FILES.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === f.id}
                  onClick={() => setTab(f.id)}
                  className={cn(
                    "inline-flex h-6.5 items-center rounded-full border px-2.5 font-mono text-[12.5px]",
                    tab === f.id && "border-transparent bg-accent text-accent-foreground",
                  )}
                >
                  {f.path}
                </button>
              ))}
              <span className="ml-auto text-xs text-muted-foreground">
                {form.templates[tab] === null ? t.standard : t.custom}
              </span>
            </div>
            <Textarea
              aria-label={TEMPLATE_FILES.find((f) => f.id === tab)?.path}
              className="min-h-56 font-mono text-xs leading-relaxed"
              value={templateText}
              readOnly={disabled}
              onChange={(e) =>
                update({
                  templates: {
                    ...form.templates,
                    // Trùng mẫu chuẩn thì lưu null, để mẫu chuẩn của bản hub mới tự áp.
                    [tab]: e.target.value === defaults[tab] ? null : e.target.value,
                  },
                })
              }
            />
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="font-mono">{t.variables}</span>
              {canWrite && form.templates[tab] !== null && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => update({ templates: { ...form.templates, [tab]: null } })}
                >
                  {t.restore}
                </Button>
              )}
            </div>
            <SwitchRow
              label={t.keepSync}
              hint={t.keepSyncHint}
              checked={form.autoSyncTemplates}
              onChange={(v) => update({ autoSyncTemplates: v })}
              disabled={disabled}
            />
            {(canWrite || lastSync) && (
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span role="status">
                  {sync.isSuccess
                    ? t.syncQueued
                    : sync.isError
                      ? apiErrorMessage(sync.error)
                      : lastSync
                        ? t.lastSync(
                            lastSync.opened,
                            lastSync.unchanged,
                            lastSync.failed.length,
                            new Date(lastSync.at).toLocaleString(lang),
                          )
                        : ""}
                </span>
                {canWrite && (
                  <Button size="sm" variant="outline" disabled={sync.isPending || dirty} onClick={() => sync.mutate()}>
                    {t.syncNow}
                  </Button>
                )}
              </div>
            )}
          </PolicyCard>

          <PolicyCard title={t.limits} hint={t.limitsHint} className="lg:col-span-2">
            <div className="grid gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
              <LimitInput
                label={t.runBudget}
                unit={t.usd}
                step="0.5"
                placeholder={t.unlimited}
                value={form.limits.perRunUsd}
                disabled={disabled}
                onChange={(v) => update({ limits: { ...form.limits, perRunUsd: v } })}
              />
              <LimitInput
                label={t.dayBudget}
                unit={t.usd}
                step="1"
                placeholder={t.unlimited}
                value={form.limits.dailyUsd}
                disabled={disabled}
                onChange={(v) => update({ limits: { ...form.limits, dailyUsd: v } })}
              />
              <LimitInput
                label={t.parallel}
                step="1"
                placeholder={t.unlimited}
                value={form.limits.maxParallelPerMachine}
                disabled={disabled}
                onChange={(v) =>
                  update({ limits: { ...form.limits, maxParallelPerMachine: v === null ? null : Math.round(v) } })
                }
              />
              <div className="flex flex-col gap-1.5 text-[13px] font-medium">
                <label htmlFor="policy-retention">{t.retention}</label>
                <NativeSelect
                  id="policy-retention"
                  value={String(form.limits.runLogRetentionDays)}
                  disabled={disabled}
                  onChange={(e) =>
                    update({
                      limits: {
                        ...form.limits,
                        runLogRetentionDays: Number(e.target.value) as Form["limits"]["runLogRetentionDays"],
                      },
                    })
                  }
                >
                  {[30, 90, 365].map((d) => (
                    <option key={d} value={d}>
                      {d} {t.days}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            </div>
          </PolicyCard>
        </div>
      </PageBody>

      {editingHook && (
        <HookDialog
          initial={editingHook.hook}
          isNew={editingHook.index === null}
          onClose={() => setEditingHook(null)}
          onRemove={() => {
            update({ hooks: form.hooks.filter((_, i) => i !== editingHook.index) });
            setEditingHook(null);
          }}
          onSave={(hook) => {
            const hooks = [...form.hooks];
            if (editingHook.index === null) hooks.push(hook);
            else hooks[editingHook.index] = hook;
            update({ hooks });
            setEditingHook(null);
          }}
        />
      )}
      {previewOpen && <PreviewDialog templates={form.templates} onClose={() => setPreviewOpen(false)} />}
    </>
  );
}

function HookDialog({
  initial,
  isNew,
  onClose,
  onSave,
  onRemove,
}: {
  initial: PolicyHook;
  isNew: boolean;
  onClose: () => void;
  onSave: (hook: PolicyHook) => void;
  onRemove: () => void;
}) {
  const t = useT(text);
  const ids = useId();
  const [hook, setHook] = useState<PolicyHook>(initial);
  const toolEvent = hook.event !== "Stop";
  function submit(e: FormEvent) {
    e.preventDefault();
    const { matcher, ...rest } = hook;
    const m = matcher?.trim();
    onSave({
      ...rest,
      name: hook.name.trim(),
      command: hook.command.trim(),
      ...(toolEvent && m ? { matcher: m } : {}),
    });
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t.hookTitle}</DialogTitle>
            <DialogDescription>{t.hookDesc}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5 text-[13px] font-medium">
            <label htmlFor={`${ids}-event`}>{t.hookEvent}</label>
            <NativeSelect
              id={`${ids}-event`}
              value={hook.event}
              onChange={(e) => setHook({ ...hook, event: e.target.value as HookEvent })}
            >
              {EVENTS.map((ev) => (
                <option key={ev} value={ev}>
                  {ev}
                </option>
              ))}
            </NativeSelect>
            <span className="text-xs font-normal text-muted-foreground">{t.eventHint[hook.event]}</span>
          </div>
          <div className="flex flex-col gap-1.5 text-[13px] font-medium">
            <label htmlFor={`${ids}-name`}>{t.hookName}</label>
            <Input
              id={`${ids}-name`}
              required
              maxLength={120}
              value={hook.name}
              onChange={(e) => setHook({ ...hook, name: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5 text-[13px] font-medium">
            <label htmlFor={`${ids}-command`}>{t.hookCommand}</label>
            <Input
              id={`${ids}-command`}
              required
              maxLength={2000}
              className="font-mono"
              value={hook.command}
              onChange={(e) => setHook({ ...hook, command: e.target.value })}
            />
          </div>
          {toolEvent && (
            <div className="flex flex-col gap-1.5 text-[13px] font-medium">
              <label htmlFor={`${ids}-matcher`}>{t.hookMatcher}</label>
              <Input
                id={`${ids}-matcher`}
                maxLength={200}
                className="font-mono"
                value={hook.matcher ?? ""}
                onChange={(e) => setHook({ ...hook, matcher: e.target.value })}
              />
              <span className="text-xs font-normal text-muted-foreground">{t.hookMatcherHint}</span>
            </div>
          )}
          <DialogActions>
            {!isNew && (
              <Button type="button" variant="destructive" className="mr-auto" onClick={onRemove}>
                {t.hookRemove}
              </Button>
            )}
            <Button type="button" variant="outline" onClick={onClose}>
              {t.cancel}
            </Button>
            <Button type="submit" disabled={!hook.name.trim() || !hook.command.trim()}>
              {t.done}
            </Button>
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PreviewDialog({ templates, onClose }: { templates: InstructionTemplates; onClose: () => void }) {
  const { api } = useOrg();
  const t = useT(text);
  const ids = useId();
  const [project, setProject] = useState("");
  const [file, setFile] = useState(0);
  const preview = useMutation({
    mutationFn: (key: string): Promise<TemplatePreview> =>
      api.policies.preview.call({ templates, ...(key.trim() ? { project: key.trim() } : {}) }),
  });
  // Mở hộp là xem ngay với dự án mẫu.
  // biome-ignore lint/correctness/useExhaustiveDependencies: chỉ chạy một lần khi mở.
  useEffect(() => {
    preview.mutate("");
  }, []);
  const files = preview.data?.files ?? [];
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t.previewTitle}</DialogTitle>
          <DialogDescription>{t.previewDesc}</DialogDescription>
        </DialogHeader>
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            preview.mutate(project);
          }}
        >
          <div className="flex flex-1 flex-col gap-1.5 text-[13px] font-medium">
            <label htmlFor={`${ids}-project`}>{t.project}</label>
            <Input
              id={`${ids}-project`}
              className="font-mono"
              placeholder={t.projectPlaceholder}
              value={project}
              onChange={(e) => setProject(e.target.value)}
            />
          </div>
          <Button type="submit" variant="outline" disabled={preview.isPending}>
            {t.show}
          </Button>
        </form>
        {preview.isError && <Alert variant="destructive">{apiErrorMessage(preview.error)}</Alert>}
        {files.length > 0 && (
          <>
            <div className="flex flex-wrap gap-1.5" role="tablist" aria-label={t.previewTitle}>
              {files.map((f, i) => (
                <button
                  key={f.path}
                  type="button"
                  role="tab"
                  aria-selected={file === i}
                  onClick={() => setFile(i)}
                  className={cn(
                    "inline-flex h-6.5 items-center rounded-full border px-2.5 font-mono text-[12.5px]",
                    file === i && "border-transparent bg-accent text-accent-foreground",
                  )}
                >
                  {f.path}
                </button>
              ))}
            </div>
            <pre className="max-h-96 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
              {files[file]?.content}
            </pre>
          </>
        )}
        <DialogActions>
          <Button variant="outline" onClick={onClose}>
            {t.close}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
