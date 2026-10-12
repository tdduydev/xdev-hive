import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { envImageInput, type Project, SUGGESTED_EGRESS_RULES } from "@xdev-hive/contracts";
import { Button } from "@xdev-hive/ui/button";
import { Input } from "@xdev-hive/ui/input";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { AllowlistEditor } from "@/components/allowlist-editor.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Card } from "@/components/ui/card.tsx";
import { Field, FieldError, FieldHint, FieldLabel } from "@/components/ui/field.tsx";
import { LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { teamRoleLookup } from "@/lib/projects.ts";
import { isOrgAdmin } from "@/lib/roles.ts";
import { useMe } from "@/shell/me-context.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

const orgText: Dict<{
  title: string;
  lead: string;
  readOnlyBanner: string;
  policyTitle: string;
  suggestedLabel: string;
  suggestedHint: string;
  lockLabel: string;
  lockHint: string;
  rulesTitle: string;
  rulesHint: string;
}> = {
  vi: {
    title: "Sandbox",
    lead: "Áp dụng cho run sandbox của mọi dự án trong tổ chức. Mặc định chặn hết.",
    readOnlyBanner: "Bạn đang xem ở chế độ chỉ đọc. Chỉ quản trị tổ chức sửa được chính sách sandbox.",
    policyTitle: "Chính sách của tổ chức",
    suggestedLabel: "Dùng danh sách đề xuất",
    suggestedHint: "Cho run ra các địa chỉ hay cần:",
    lockLabel: "Khoá allowlist",
    lockHint: "Dự án không thêm được mục riêng; chỉ dùng mục của tổ chức.",
    rulesTitle: "Mục mạng của tổ chức",
    rulesHint: "Mọi dự án đều dùng các mục này.",
  },
  en: {
    title: "Sandbox",
    lead: "Applies to sandbox runs of every project in the organization. Everything is blocked by default.",
    readOnlyBanner: "You are viewing in read-only mode. Only organization admins can edit sandbox policies.",
    policyTitle: "Organization policy",
    suggestedLabel: "Use the suggested list",
    suggestedHint: "Let runs reach commonly needed hosts:",
    lockLabel: "Lock the allowlist",
    lockHint: "Projects cannot add their own rules; only organization rules apply.",
    rulesTitle: "Organization network rules",
    rulesHint: "Every project uses these rules.",
  },
};

const projectText: Dict<{
  title: string;
  projectsCrumb: string;
  loading: string;
  notFound: (k: string) => string;
  offBanner: string;
  openSettings: string;
  effectiveTitle: string;
  effectiveHint: string;
  noRules: string;
  effectiveAria: string;
  projectRulesTitle: string;
  projectRulesHint: string;
  lockedNote: string;
  imageTitle: string;
  imageHint: string;
  baseImageLabel: string;
  baseImageHint: string;
  hashLabel: string;
  hashHint: string;
  saveImage: string;
  savingImage: string;
  savedImage: string;
}> = {
  vi: {
    title: "Sandbox",
    projectsCrumb: "Dự án",
    loading: "Đang tải…",
    notFound: (k) => `Không tìm thấy dự án ${k}, hoặc bạn không ở trong đội sở hữu dự án.`,
    offBanner: "Dự án chưa bật sandbox nên run vẫn chạy trên máy dev. Bật ở cấu hình dự án.",
    openSettings: "Mở cấu hình",
    effectiveTitle: "Allowlist hiệu lực",
    effectiveHint: "Gộp từ danh sách đề xuất (nếu tổ chức bật), mục của tổ chức và mục của dự án.",
    noRules: "Run sandbox của dự án không ra được địa chỉ nào.",
    effectiveAria: "Allowlist hiệu lực",
    projectRulesTitle: "Mục mạng của dự án",
    projectRulesHint: "Chỉ áp dụng cho run sandbox của dự án này.",
    lockedNote: "Tổ chức đã khoá allowlist: dự án không thêm được mục riêng.",
    imageTitle: "Image môi trường",
    imageHint: "Runner host dựng image một lần và cache theo hash của script setup.",
    baseImageLabel: "Image gốc",
    baseImageHint: "Image có sẵn CLI agent cần dùng; runner host dựng và cache theo hash script setup.",
    hashLabel: "SHA-256 của .hive/setup.sh",
    hashHint: "Lấy bằng sha256sum .hive/setup.sh trong repo của dự án.",
    saveImage: "Lưu image",
    savingImage: "Đang lưu…",
    savedImage: "Đã lưu image môi trường.",
  },
  en: {
    title: "Sandbox",
    projectsCrumb: "Projects",
    loading: "Loading…",
    notFound: (k) => `Project ${k} not found, or you are not in the owning team.`,
    offBanner:
      "Sandbox is off for this project, so runs still execute on dev machines. Turn it on in project settings.",
    openSettings: "Open settings",
    effectiveTitle: "Effective allowlist",
    effectiveHint: "Merged from the suggested list (if enabled), organization rules and project rules.",
    noRules: "Project sandbox runs cannot reach any external address.",
    effectiveAria: "Effective allowlist",
    projectRulesTitle: "Project network rules",
    projectRulesHint: "Applies only to sandbox runs in this project.",
    lockedNote: "Organization has locked the allowlist: projects cannot add their own rules.",
    imageTitle: "Environment image",
    imageHint: "The runner host builds the image once and caches it by the setup script hash.",
    baseImageLabel: "Base image",
    baseImageHint: "An image that already has the agent CLIs it needs.",
    hashLabel: "SHA-256 of .hive/setup.sh",
    hashHint: "Get it with sha256sum .hive/setup.sh in the project repo.",
    saveImage: "Save image",
    savingImage: "Saving…",
    savedImage: "Environment image saved.",
  },
};

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  const id = useId();
  return (
    <Card className="grid gap-3 p-5" role="group" aria-labelledby={id}>
      <div className="grid gap-0.5">
        <h2 id={id} className="text-base font-semibold text-foreground">
          {title}
        </h2>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </Card>
  );
}

/** Chính sách sandbox của tổ chức: khoá allowlist, danh sách đề xuất và mục mạng dùng chung cho mọi dự án. */
export function SandboxAdminPage() {
  const { api, org } = useOrg();
  const t = useT(orgText);
  const queryClient = useQueryClient();
  const settings = useQuery(api.sandbox.getOrgSettings.queryOptions({ input: {} }));
  const admin = isOrgAdmin(org.role);
  const [draft, setDraft] = useState<{ locked: boolean; useSuggestedDefaults: boolean } | null>(null);
  const save = useMutation({
    mutationFn: (next: { locked: boolean; useSuggestedDefaults: boolean }) => api.sandbox.updateOrgSettings.call(next),
    onError: () => setDraft(null),
    onSuccess: async (next) => {
      queryClient.setQueryData(api.sandbox.getOrgSettings.queryKey({ input: {} }), next);
      setDraft(null);
      await queryClient.invalidateQueries({ queryKey: api.sandbox.effectiveAllowlist.key() });
    },
  });

  let policy: ReactNode;
  if (settings.isPending) policy = <LoadingState />;
  else if (settings.isError) policy = <LoadFailure error={settings.error} retry={settings.refetch} />;
  else {
    const s = draft ?? settings.data;
    const change = (next: { locked: boolean; useSuggestedDefaults: boolean }) => {
      setDraft(next);
      save.mutate(next);
    };
    policy = (
      <div className="grid gap-4">
        <div className="flex items-start justify-between gap-4">
          <div className="grid gap-1">
            <span className="text-sm font-medium text-foreground">{t.suggestedLabel}</span>
            <span className="text-xs text-muted-foreground">
              {t.suggestedHint}{" "}
              <span className="inline-flex flex-wrap gap-1 pt-1">
                {SUGGESTED_EGRESS_RULES.map((rule) => (
                  <code key={rule} className="rounded bg-muted px-1.5 py-0.5 font-mono text-2xs text-foreground">
                    {rule}
                  </code>
                ))}
              </span>
            </span>
          </div>
          <Switch
            checked={s.useSuggestedDefaults}
            disabled={!admin || save.isPending}
            onCheckedChange={(checked) => change({ ...s, useSuggestedDefaults: checked })}
            aria-label={t.suggestedLabel}
          />
        </div>

        <div className="h-px bg-border" />

        <div className="flex items-start justify-between gap-4">
          <div className="grid gap-0.5">
            <span className="text-sm font-medium text-foreground">{t.lockLabel}</span>
            <span className="text-xs text-muted-foreground">{t.lockHint}</span>
          </div>
          <Switch
            checked={s.locked}
            disabled={!admin || save.isPending}
            onCheckedChange={(checked) => change({ ...s, locked: checked })}
            aria-label={t.lockLabel}
          />
        </div>
        {save.isError && <Alert variant="destructive">{apiErrorMessage(save.error)}</Alert>}
      </div>
    );
  }

  return (
    <>
      <PageHeader title={t.title} />
      <PageBody>
        <p className="-mt-2 text-sm text-muted-foreground">{t.lead}</p>
        {!admin && (
          <p role="note" className="rounded-lg border border-border bg-muted px-3.5 py-2.5 text-xs text-foreground">
            {t.readOnlyBanner}
          </p>
        )}
        <Section title={t.policyTitle}>{policy}</Section>
        <Section title={t.rulesTitle} hint={t.rulesHint}>
          <AllowlistEditor canEdit={admin} />
        </Section>
      </PageBody>
    </>
  );
}

/** Sandbox của một dự án: allowlist hiệu lực, mục riêng của dự án và image môi trường. */
export function ProjectSandboxPage() {
  const { key } = useParams({ from: "/session/app/in-org/projects/$key/sandbox" });
  const { api, org } = useOrg();
  const t = useT(projectText);
  const me = useMe();
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const members = useQuery(api.orgMembers.list.queryOptions({ input: {} }));
  const project = projects.data?.find((p) => p.key === key);
  const crumb = (
    <>
      <Link to="/projects" className="text-primary hover:text-primary/90">
        {t.projectsCrumb}
      </Link>
      {" / "}
      <span className="font-mono">{key}</span>
      {" / Sandbox"}
    </>
  );

  let body: ReactNode;
  if (projects.isPending || members.isPending) body = <LoadingState />;
  else if (projects.isError) body = <LoadFailure error={projects.error} retry={projects.refetch} />;
  else if (!project) body = <Alert variant="destructive">{t.notFound(key)}</Alert>;
  else {
    const canEdit = teamRoleLookup(org.role, members.data, me.id)(project.teamId) === "admin";
    body = <ProjectSandbox project={project} canEdit={canEdit} />;
  }
  return (
    <>
      <PageHeader crumb={crumb} title={t.title} />
      <PageBody>{body}</PageBody>
    </>
  );
}

function ProjectSandbox({ project, canEdit }: { project: Project; canEdit: boolean }) {
  const { api } = useOrg();
  const t = useT(projectText);
  const effective = useQuery(api.sandbox.effectiveAllowlist.queryOptions({ input: { projectId: project.id } }));
  return (
    <>
      {!project.settings.features.sandbox && (
        <div
          role="note"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-warning-soft px-3.5 py-2.5 text-xs text-warning"
        >
          <span>{t.offBanner}</span>
          <Link
            to="/projects/$key/settings"
            params={{ key: project.key }}
            className="rounded-md border border-warning/40 bg-background px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
          >
            {t.openSettings}
          </Link>
        </div>
      )}
      <Section title={t.effectiveTitle} hint={t.effectiveHint}>
        {effective.isPending ? (
          <LoadingState />
        ) : effective.isError ? (
          <LoadFailure error={effective.error} retry={effective.refetch} />
        ) : effective.data.rules.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t.noRules}</p>
        ) : (
          <ul aria-label={t.effectiveAria} className="flex flex-wrap gap-1.5">
            {effective.data.rules.map((rule) => (
              <li key={rule}>
                <code className="rounded bg-muted px-2 py-0.5 font-mono text-xs text-foreground">{rule}</code>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title={t.projectRulesTitle} hint={t.projectRulesHint}>
        <AllowlistEditor
          projectId={project.id}
          canEdit={canEdit}
          {...(effective.data?.locked ? { lockedNote: t.lockedNote } : {})}
        />
      </Section>
      <Section title={t.imageTitle} hint={t.imageHint}>
        <EnvImageForm project={project} canEdit={canEdit} />
      </Section>
    </>
  );
}

function EnvImageForm({ project, canEdit }: { project: Project; canEdit: boolean }) {
  const { api } = useOrg();
  const t = useT(projectText);
  const queryClient = useQueryClient();
  const ids = { image: useId(), hash: useId() };
  const image = useQuery(api.sandbox.getImage.queryOptions({ input: { projectId: project.id } }));
  const [errors, setErrors] = useState<{ baseImage?: string; setupScriptHash?: string }>({});
  const [done, setDone] = useState(false);
  const save = useMutation({
    mutationFn: (input: { baseImage: string; setupScriptHash: string }) =>
      api.sandbox.setImage.call({ projectId: project.id, ...input }),
    onSuccess: async () => {
      setDone(true);
      await queryClient.invalidateQueries({ queryKey: api.sandbox.getImage.key() });
    },
  });

  if (image.isPending) return <LoadingState />;
  if (image.isError) return <LoadFailure error={image.error} retry={image.refetch} />;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setDone(false);
    const data = new FormData(e.currentTarget);
    const parsed = envImageInput.safeParse({
      baseImage: String(data.get("baseImage") ?? "").trim(),
      setupScriptHash: String(data.get("setupScriptHash") ?? "")
        .trim()
        .toLowerCase(),
    });
    if (!parsed.success) {
      const next: typeof errors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] as keyof typeof errors;
        next[field] ??= issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    save.mutate(parsed.data);
  }

  return (
    <form noValidate onSubmit={onSubmit} className="grid gap-3">
      <Field invalid={errors.baseImage !== undefined}>
        <FieldLabel htmlFor={ids.image}>{t.baseImageLabel}</FieldLabel>
        <Input
          id={ids.image}
          name="baseImage"
          defaultValue={image.data?.baseImage ?? ""}
          placeholder="node:24-bookworm-slim"
          className="font-mono text-xs"
          disabled={!canEdit}
        />
        {errors.baseImage ? <FieldError>{errors.baseImage}</FieldError> : <FieldHint>{t.baseImageHint}</FieldHint>}
      </Field>
      <Field invalid={errors.setupScriptHash !== undefined}>
        <FieldLabel htmlFor={ids.hash}>{t.hashLabel}</FieldLabel>
        <Input
          id={ids.hash}
          name="setupScriptHash"
          defaultValue={image.data?.setupScriptHash ?? ""}
          className="font-mono text-xs"
          disabled={!canEdit}
        />
        {errors.setupScriptHash ? (
          <FieldError>{errors.setupScriptHash}</FieldError>
        ) : (
          <FieldHint>{t.hashHint}</FieldHint>
        )}
      </Field>
      {save.isError && <Alert variant="destructive">{apiErrorMessage(save.error)}</Alert>}
      {done && (
        <p role="status" className="text-xs text-success">
          {t.savedImage}
        </p>
      )}
      {canEdit && (
        <div className="flex justify-end">
          <Button type="submit" variant="default" disabled={save.isPending}>
            {save.isPending ? t.savingImage : t.saveImage}
          </Button>
        </div>
      )}
    </form>
  );
}
