import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { type DeployEnvironment, type DeployTarget, environmentName } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { Input } from "@xdev-hive/ui/input";
import { Pill } from "@xdev-hive/ui/pill";
import { Table, Td, Th } from "@xdev-hive/ui/table";
import { LayersIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Icon } from "@/components/icons.tsx";
import { Field, FieldError, FieldHint, FieldLabel } from "@/components/ui/field.tsx";
import { EmptyState, LoadFailure, TableSkeleton } from "@/components/ui/query-state.tsx";
import { apiErrorMessage, formError } from "@/lib/api-errors.ts";
import { DEPLOY_METHOD_LABEL } from "@/lib/delivery-text.ts";
import { useTeamPermissions } from "@/lib/permissions.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";
import { TargetForm } from "./target-form.tsx";
import { targetSummary } from "./target-presets.ts";

const VI = {
  title: "Môi trường và đích triển khai",
  lead: "Môi trường của hệ thống theo thứ tự dev đến prod, kèm chính sách duyệt. Mỗi dự án có một đích ở mỗi môi trường.",
  loading: "Đang tải môi trường",
  notFound: "Không thấy hệ thống này.",
  envTitle: "Môi trường",
  envLead: "Thứ tự ở đây là thứ tự đẩy bản từ môi trường này sang môi trường kế tiếp.",
  addEnv: "Thêm môi trường",
  envEmptyTitle: "Chưa có môi trường nào",
  envEmpty: "Thêm môi trường đầu tiên, ví dụ dev, staging, prod.",
  colEnv: "Môi trường",
  colPolicy: "Chính sách",
  actions: "Thao tác",
  locked: "Đã khoá",
  approvals: (n: number, h: number) => (n === 0 ? "Không cần duyệt" : `Cần ${n} người duyệt, hết hạn sau ${h} giờ`),
  rolesDeploy: (roles: string) => `Triển khai: ${roles}`,
  rolesApprove: (roles: string) => `Duyệt: ${roles}`,
  anyRole: "mọi vai trò có quyền",
  up: (name: string) => `Đưa ${name} lên trước`,
  down: (name: string) => `Đưa ${name} xuống sau`,
  edit: "Sửa",
  editOf: (name: string) => `Sửa môi trường ${name}`,
  targetsTitle: "Đích của từng dự án",
  targetsLead: "Chọn một ô để thêm hoặc sửa cách dự án được đưa lên môi trường.",
  targetsEmptyTitle: "Hệ thống chưa có dự án",
  targetsEmpty: "Tạo dự án trong hệ thống này để khai báo đích triển khai.",
  needEnv: "Thêm môi trường trước để khai báo đích.",
  colProject: "Dự án",
  noTarget: "Chưa có đích",
  addTarget: (project: string, env: string) => `Thêm đích ${project} ở ${env}`,
  editTarget: (project: string, env: string) => `Sửa đích ${project} ở ${env}`,
  add: "Thêm",
  dlgAdd: "Thêm môi trường",
  dlgEdit: (name: string) => `Sửa môi trường ${name}`,
  dlgLead: "Chính sách này kiểm thêm sau quyền triển khai và duyệt chung của tổ chức.",
  name: "Tên",
  nameHint: "Chữ thường, số và dấu gạch ngang, ví dụ dev, staging, prod.",
  approvalsField: "Số người duyệt",
  approvalsHint: "0 là không cần duyệt. Tối đa 5.",
  ttl: "Duyệt trong (giờ)",
  ttlHint: "Quá hạn mà chưa đủ người duyệt thì lần triển khai hết hạn. 1 đến 168.",
  deployRoles: "Vai trò được triển khai",
  approveRoles: "Vai trò được duyệt",
  rolesHint: "Không chọn vai trò nào là không giới hạn thêm.",
  cancel: "Huỷ",
  save: "Lưu",
  saving: "Đang lưu…",
  numberBad: "Nhập một số hợp lệ.",
};

const ROLES = [
  { id: "admin", label: "Quản trị" },
  { id: "member", label: "Thành viên" },
  { id: "ba", label: "BA" },
  { id: "viewer", label: "Người xem" },
] as const;
type RoleId = (typeof ROLES)[number]["id"];
const roleLabel = (id: string) => ROLES.find((r) => r.id === id)?.label ?? id;

type TargetDlg = { projectId: string; projectName: string; env: DeployEnvironment; target: DeployTarget | null };

/** /systems/:systemId/environments: môi trường và đích triển khai của hệ thống (FR-012…FR-014). */
export function EnvironmentsPage() {
  const { systemId } = useParams({ strict: false }) as { systemId: string };
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const systems = useQuery(api.systems.list.queryOptions({ input: {} }));
  const system = systems.data?.find((s) => s.id === systemId) ?? null;
  const envs = useQuery(api.environments.list.queryOptions({ input: { systemId } }));
  const projects = useQuery(api.projects.list.queryOptions({ input: { systemId } }));
  const targets = useQuery(api.deployTargets.list.queryOptions({ input: { systemId } }));
  const can = useTeamPermissions(system?.teamId ?? "");
  const manage = system !== null && can("servers.manage");
  const servers = useQuery({
    ...api.servers.list.queryOptions({ input: { teamId: system?.teamId } }),
    enabled: manage,
  });
  const jenkins = useQuery({ ...api.ciConnections.list.queryOptions(), enabled: manage });
  const infra = useQuery({ ...api.infraConnections.list.queryOptions(), enabled: manage });

  const [envDlg, setEnvDlg] = useState<DeployEnvironment | "new" | null>(null);
  const [targetDlg, setTargetDlg] = useState<TargetDlg | null>(null);
  const [reorderFailure, setReorderFailure] = useState<string | null>(null);

  const reorder = useMutation({
    mutationFn: (ids: string[]) => api.environments.reorder.call({ systemId, ids }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: api.environments.key() }),
    onError: (error) => setReorderFailure(apiErrorMessage(error)),
  });

  const ordered = [...(envs.data ?? [])].sort((a, b) => a.position - b.position);
  function move(index: number, by: -1 | 1) {
    const ids = ordered.map((e) => e.id);
    const other = index + by;
    const a = ids[index];
    const b = ids[other];
    if (a === undefined || b === undefined) return;
    ids[index] = b;
    ids[other] = a;
    setReorderFailure(null);
    reorder.mutate(ids);
  }

  const targetOf = (projectId: string, environmentId: string) =>
    targets.data?.find((t) => t.projectId === projectId && t.environmentId === environmentId) ?? null;

  const header = (
    <PageHeader title={system ? `${VI.title}: ${system.name}` : VI.title} description={VI.lead}>
      {manage && (
        <Button variant="default" size="sm" onClick={() => setEnvDlg("new")}>
          <Icon name="plus" />
          {VI.addEnv}
        </Button>
      )}
    </PageHeader>
  );

  if (systems.isPending)
    return (
      <>
        {header}
        <PageBody>
          <TableSkeleton label={VI.loading} rows={3} columns={3} />
        </PageBody>
      </>
    );
  if (systems.isError)
    return (
      <>
        {header}
        <PageBody>
          <LoadFailure error={systems.error} retry={systems.refetch} />
        </PageBody>
      </>
    );
  if (!system)
    return (
      <>
        {header}
        <PageBody>
          <Alert variant="destructive">{VI.notFound}</Alert>
        </PageBody>
      </>
    );

  return (
    <>
      {header}
      <PageBody>
        <section aria-labelledby="env-title" className="grid min-w-0 gap-3">
          <div className="grid gap-0.5">
            <h2 id="env-title" className="font-heading text-base font-semibold text-foreground">
              {VI.envTitle}
            </h2>
            <p className="max-w-3xl text-sm text-muted-foreground">{VI.envLead}</p>
          </div>
          {envs.isPending ? (
            <TableSkeleton label={VI.loading} rows={3} columns={3} />
          ) : envs.isError ? (
            <LoadFailure error={envs.error} retry={envs.refetch} />
          ) : ordered.length === 0 ? (
            <EmptyState
              compact
              icon={LayersIcon}
              title={VI.envEmptyTitle}
              description={VI.envEmpty}
              action={
                manage && (
                  <Button variant="default" onClick={() => setEnvDlg("new")}>
                    <Icon name="plus" />
                    {VI.addEnv}
                  </Button>
                )
              }
            />
          ) : (
            <div className="min-w-0 overflow-x-auto rounded-xl border border-border bg-card">
              <Table className="[&_td]:align-top" style={{ minWidth: 560 }}>
                <caption className="sr-only">{VI.envTitle}</caption>
                <thead>
                  <tr>
                    <Th variant="plain">{VI.colEnv}</Th>
                    <Th variant="plain">{VI.colPolicy}</Th>
                    {manage && (
                      <Th variant="plain" className="text-right">
                        {VI.actions}
                      </Th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {ordered.map((env, i) => (
                    <tr key={env.id}>
                      <Td>
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-foreground">{env.name}</span>
                          {env.lock && (
                            <Pill tone="warn" small>
                              {VI.locked}
                            </Pill>
                          )}
                        </span>
                      </Td>
                      <Td>
                        <span className="grid gap-0.5 text-xs text-muted-foreground">
                          <span>{VI.approvals(env.policy.approvals, env.policy.approvalTtlHours)}</span>
                          <span>
                            {VI.rolesDeploy(
                              env.policy.deployRoles.length > 0
                                ? env.policy.deployRoles.map(roleLabel).join(", ")
                                : VI.anyRole,
                            )}
                          </span>
                          <span>
                            {VI.rolesApprove(
                              env.policy.approveRoles.length > 0
                                ? env.policy.approveRoles.map(roleLabel).join(", ")
                                : VI.anyRole,
                            )}
                          </span>
                        </span>
                      </Td>
                      {manage && (
                        <Td className="text-right">
                          <span className="inline-flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={VI.up(env.name)}
                              disabled={i === 0 || reorder.isPending}
                              onClick={() => move(i, -1)}
                            >
                              Lên
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={VI.down(env.name)}
                              disabled={i === ordered.length - 1 || reorder.isPending}
                              onClick={() => move(i, 1)}
                            >
                              Xuống
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={VI.editOf(env.name)}
                              onClick={() => setEnvDlg(env)}
                            >
                              {VI.edit}
                            </Button>
                          </span>
                        </Td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
          {reorderFailure && <Alert variant="destructive">{reorderFailure}</Alert>}
        </section>

        <section aria-labelledby="targets-title" className="grid min-w-0 gap-3">
          <div className="grid gap-0.5">
            <h2 id="targets-title" className="font-heading text-base font-semibold text-foreground">
              {VI.targetsTitle}
            </h2>
            <p className="max-w-3xl text-sm text-muted-foreground">{VI.targetsLead}</p>
          </div>
          {projects.isPending || targets.isPending ? (
            <TableSkeleton label={VI.loading} rows={3} columns={3} />
          ) : projects.isError ? (
            <LoadFailure error={projects.error} retry={projects.refetch} />
          ) : targets.isError ? (
            <LoadFailure error={targets.error} retry={targets.refetch} />
          ) : projects.data.length === 0 ? (
            <EmptyState compact icon={LayersIcon} title={VI.targetsEmptyTitle} description={VI.targetsEmpty} />
          ) : ordered.length === 0 ? (
            <p className="text-sm text-muted-foreground">{VI.needEnv}</p>
          ) : (
            <div className="min-w-0 overflow-x-auto rounded-xl border border-border bg-card">
              <Table className="[&_td]:align-top" style={{ minWidth: 200 + ordered.length * 200 }}>
                <caption className="sr-only">{VI.targetsTitle}</caption>
                <thead>
                  <tr>
                    <Th variant="plain">{VI.colProject}</Th>
                    {ordered.map((env) => (
                      <Th key={env.id} variant="plain">
                        {env.name}
                      </Th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {projects.data.map((p) => (
                    <tr key={p.id}>
                      <Td>
                        <span className="font-medium text-foreground">{p.name}</span>
                      </Td>
                      {ordered.map((env) => {
                        const target = targetOf(p.id, env.id);
                        return (
                          <Td key={env.id}>
                            <span className="grid justify-items-start gap-1">
                              {target ? (
                                <>
                                  <Pill tone="neutral" small>
                                    {DEPLOY_METHOD_LABEL[target.method]}
                                  </Pill>
                                  <span className="font-mono text-xs break-all text-muted-foreground">
                                    {targetSummary(target)}
                                  </span>
                                </>
                              ) : (
                                <span className="text-xs text-muted-foreground">{VI.noTarget}</span>
                              )}
                              {manage && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  aria-label={(target ? VI.editTarget : VI.addTarget)(p.name, env.name)}
                                  onClick={() => setTargetDlg({ projectId: p.id, projectName: p.name, env, target })}
                                >
                                  {target ? VI.edit : VI.add}
                                </Button>
                              )}
                            </span>
                          </Td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </section>
      </PageBody>

      <Dialog open={envDlg !== null} onOpenChange={(open) => !open && setEnvDlg(null)}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain">
          {envDlg && (
            <EnvironmentForm
              systemId={systemId}
              environment={envDlg === "new" ? null : envDlg}
              onDone={() => setEnvDlg(null)}
            />
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={targetDlg !== null} onOpenChange={(open) => !open && setTargetDlg(null)}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain sm:max-w-2xl">
          {targetDlg && (
            <TargetForm
              projectId={targetDlg.projectId}
              environmentId={targetDlg.env.id}
              projectName={targetDlg.projectName}
              environmentName={targetDlg.env.name}
              target={targetDlg.target}
              servers={servers.data ?? []}
              jenkins={jenkins.data ?? []}
              infra={infra.data ?? []}
              otherEnvironments={ordered.filter((e) => e.id !== targetDlg.env.id)}
              onDone={() => setTargetDlg(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

type EnvErrors = Partial<Record<"name" | "approvals" | "approvalTtlHours", string>>;

function EnvironmentForm({
  systemId,
  environment,
  onDone,
}: {
  systemId: string;
  environment: DeployEnvironment | null;
  onDone: () => void;
}) {
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const [deployRoles, setDeployRoles] = useState<RoleId[]>((environment?.policy.deployRoles ?? []) as RoleId[]);
  const [approveRoles, setApproveRoles] = useState<RoleId[]>((environment?.policy.approveRoles ?? []) as RoleId[]);
  const [errors, setErrors] = useState<EnvErrors>({});
  const [failure, setFailure] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (v: { name: string; policy: DeployEnvironment["policy"] }) =>
      environment
        ? api.environments.update.call({ id: environment.id, name: v.name, policy: v.policy })
        : api.environments.create.call({ systemId, name: v.name, policy: v.policy }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: api.environments.key() });
      onDone();
    },
    onError: (error) => {
      const { field, message } = formError(error);
      if (field === "name") setErrors({ name: message });
      else setFailure(message);
    },
  });

  function onSubmit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const form = new FormData(ev.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const approvals = Number(form.get("approvals"));
    const approvalTtlHours = Number(form.get("ttl"));
    const next: EnvErrors = {};
    const parsedName = environmentName.safeParse(name);
    if (!parsedName.success) next.name = parsedName.error.issues[0]?.message ?? VI.numberBad;
    if (!Number.isInteger(approvals) || approvals < 0 || approvals > 5) next.approvals = VI.approvalsHint;
    if (!Number.isInteger(approvalTtlHours) || approvalTtlHours < 1 || approvalTtlHours > 168)
      next.approvalTtlHours = VI.ttlHint;
    setFailure(null);
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    save.mutate({ name, policy: { deployRoles, approveRoles, approvals, approvalTtlHours } });
  }

  const busy = save.isPending;
  return (
    <form noValidate onSubmit={onSubmit} className="grid gap-3.5">
      <DialogTitle>{environment ? VI.dlgEdit(environment.name) : VI.dlgAdd}</DialogTitle>
      <DialogDescription>{VI.dlgLead}</DialogDescription>
      <Field invalid={errors.name !== undefined}>
        <FieldLabel>{VI.name}</FieldLabel>
        <Input
          name="name"
          defaultValue={environment?.name}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          autoFocus
          className="font-mono"
        />
        {errors.name ? <FieldError>{errors.name}</FieldError> : <FieldHint>{VI.nameHint}</FieldHint>}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field invalid={errors.approvals !== undefined}>
          <FieldLabel>{VI.approvalsField}</FieldLabel>
          <Input
            name="approvals"
            defaultValue={environment?.policy.approvals ?? 0}
            inputMode="numeric"
            disabled={busy}
            autoComplete="off"
          />
          {errors.approvals ? <FieldError>{errors.approvals}</FieldError> : <FieldHint>{VI.approvalsHint}</FieldHint>}
        </Field>
        <Field invalid={errors.approvalTtlHours !== undefined}>
          <FieldLabel>{VI.ttl}</FieldLabel>
          <Input
            name="ttl"
            defaultValue={environment?.policy.approvalTtlHours ?? 24}
            inputMode="numeric"
            disabled={busy}
            autoComplete="off"
          />
          {errors.approvalTtlHours ? (
            <FieldError>{errors.approvalTtlHours}</FieldError>
          ) : (
            <FieldHint>{VI.ttlHint}</FieldHint>
          )}
        </Field>
      </div>
      <RoleChecks label={VI.deployRoles} value={deployRoles} onChange={setDeployRoles} disabled={busy} />
      <RoleChecks label={VI.approveRoles} value={approveRoles} onChange={setApproveRoles} disabled={busy} />
      <p className="-mt-2 text-xs text-muted-foreground">{VI.rolesHint}</p>
      {failure && <Alert variant="destructive">{failure}</Alert>}
      <DialogActions>
        <Button variant="outline" onClick={onDone}>
          {VI.cancel}
        </Button>
        <Button type="submit" variant="default" disabled={busy}>
          {busy ? VI.saving : VI.save}
        </Button>
      </DialogActions>
    </form>
  );
}

function RoleChecks({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: RoleId[];
  onChange: (v: RoleId[]) => void;
  disabled: boolean;
}) {
  return (
    <fieldset className="grid gap-1">
      <legend className="text-sm font-medium text-foreground">{label}</legend>
      <div className="flex flex-wrap gap-x-4">
        {ROLES.map((r) => (
          <label key={r.id} className="flex min-h-9 items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              disabled={disabled}
              checked={value.includes(r.id)}
              onChange={(e) => onChange(e.target.checked ? [...value, r.id] : value.filter((x) => x !== r.id))}
            />
            {r.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
