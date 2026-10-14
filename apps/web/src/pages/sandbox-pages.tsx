import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { envImageInput, type Project, SUGGESTED_EGRESS_RULES } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Input } from "@xdev-hive/ui/input";
import { type ReactNode, useId, useState } from "react";
import { AllowlistEditor } from "@/components/allowlist-editor.tsx";
import { FormRow, SettingsSection, SwitchRow } from "@/components/page/settings.tsx";
import { UnsavedChangesGuard } from "@/components/page/unsaved-guard.tsx";
import { Field, FieldError } from "@/components/ui/field.tsx";
import { LoadFailure, SectionsSkeleton } from "@/components/ui/query-state.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { cx } from "@/lib/cx.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { teamRoleLookup } from "@/lib/projects.ts";
import { isOrgAdmin } from "@/lib/roles.ts";
import { useMe } from "@/shell/me-context.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

type OrgPolicy = { locked: boolean; useSuggestedDefaults: boolean };

const orgText: Dict<{
  title: string;
  lead: string;
  loading: string;
  readOnlyBanner: string;
  policyTitle: string;
  savePolicy: string;
  suggestedLabel: string;
  suggestedHint: string;
  lockLabel: string;
  lockHint: string;
  rulesTitle: string;
  rulesHint: string;
}> = {
  vi: {
    title: "Sandbox",
    lead: "Mạng mà run sandbox của mọi dự án trong tổ chức được ra. Mặc định chặn hết.",
    loading: "Đang tải chính sách sandbox…",
    readOnlyBanner: "Bạn đang xem ở chế độ chỉ đọc. Chỉ quản trị tổ chức sửa được chính sách sandbox.",
    policyTitle: "Chính sách của tổ chức",
    savePolicy: "Lưu chính sách",
    suggestedLabel: "Dùng danh sách đề xuất",
    suggestedHint: "Cho run ra các địa chỉ hay cần:",
    lockLabel: "Khoá allowlist",
    lockHint: "Dự án không thêm được mục riêng; chỉ dùng mục của tổ chức.",
    rulesTitle: "Mục mạng của tổ chức",
    rulesHint: "Mọi dự án đều dùng các mục này.",
  },
  en: {
    title: "Sandbox",
    lead: "Network access for sandbox runs of every project in the organization. Everything is blocked by default.",
    loading: "Loading sandbox policy…",
    readOnlyBanner: "You are viewing in read-only mode. Only organization admins can edit sandbox policies.",
    policyTitle: "Organization policy",
    savePolicy: "Save policy",
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
  lead: (key: string) => string;
  projectsCrumb: string;
  loading: string;
  notFound: (k: string) => string;
  backToProjects: string;
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
  savedImage: string;
}> = {
  vi: {
    title: "Sandbox",
    lead: (k) => `Allowlist mạng và image môi trường cho run sandbox của dự án ${k}.`,
    projectsCrumb: "Dự án",
    loading: "Đang tải sandbox của dự án…",
    notFound: (k) => `Không tìm thấy dự án ${k}, hoặc bạn không ở trong đội sở hữu dự án.`,
    backToProjects: "Về danh sách dự án",
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
    baseImageHint: "Image có sẵn các CLI agent mà run cần.",
    hashLabel: "SHA-256 của .hive/setup.sh",
    hashHint: "Lấy bằng sha256sum .hive/setup.sh trong repo của dự án.",
    saveImage: "Lưu image",
    savedImage: "Đã lưu image môi trường.",
  },
  en: {
    title: "Sandbox",
    lead: (k) => `Network allowlist and environment image for sandbox runs of project ${k}.`,
    projectsCrumb: "Projects",
    loading: "Loading project sandbox…",
    notFound: (k) => `Project ${k} not found, or you are not in the owning team.`,
    backToProjects: "Back to projects",
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
    savedImage: "Environment image saved.",
  },
};

/** Chính sách sandbox của tổ chức: khoá allowlist, danh sách đề xuất và mục mạng dùng chung cho mọi dự án. */
export function SandboxAdminPage() {
  const { api, org } = useOrg();
  const t = useT(orgText);
  const queryClient = useQueryClient();
  const settings = useQuery(api.sandbox.getOrgSettings.queryOptions({ input: {} }));
  const admin = isOrgAdmin(org.role);
  const [draft, setDraft] = useState<OrgPolicy | null>(null);
  const save = useMutation({
    mutationFn: (next: OrgPolicy) => api.sandbox.updateOrgSettings.call(next),
    onSuccess: async (next) => {
      queryClient.setQueryData(api.sandbox.getOrgSettings.queryKey({ input: {} }), next);
      setDraft(null);
      await queryClient.invalidateQueries({ queryKey: api.sandbox.effectiveAllowlist.key() });
    },
  });
  const saved = settings.data
    ? { locked: settings.data.locked, useSuggestedDefaults: settings.data.useSuggestedDefaults }
    : null;
  const dirty =
    draft !== null &&
    saved !== null &&
    (draft.locked !== saved.locked || draft.useSuggestedDefaults !== saved.useSuggestedDefaults);

  let body: ReactNode;
  if (settings.isPending) body = <SectionsSkeleton sections={2} label={t.loading} />;
  else if (settings.isError) body = <LoadFailure error={settings.error} retry={settings.refetch} />;
  else {
    const s = draft ?? settings.data;
    const change = (next: OrgPolicy) => {
      save.reset();
      setDraft(next);
    };
    body = (
      <>
        <SettingsSection
          title={t.policyTitle}
          save={
            admin
              ? {
                  dirty,
                  saving: save.isPending,
                  saved: save.isSuccess,
                  error: save.isError ? apiErrorMessage(save.error) : undefined,
                  onSave: () => save.mutate({ locked: s.locked, useSuggestedDefaults: s.useSuggestedDefaults }),
                  onDiscard: () => {
                    save.reset();
                    setDraft(null);
                  },
                  saveLabel: t.savePolicy,
                }
              : undefined
          }
        >
          <SwitchRow
            label={t.suggestedLabel}
            hint={
              <>
                {t.suggestedHint}{" "}
                <span className="font-mono text-foreground/80">{SUGGESTED_EGRESS_RULES.join(", ")}</span>
              </>
            }
            checked={s.useSuggestedDefaults}
            disabled={!admin || save.isPending}
            onChange={(checked) => change({ ...s, useSuggestedDefaults: checked })}
          />
          <SwitchRow
            label={t.lockLabel}
            hint={t.lockHint}
            checked={s.locked}
            disabled={!admin || save.isPending}
            onChange={(checked) => change({ ...s, locked: checked })}
          />
        </SettingsSection>
        <SettingsSection title={t.rulesTitle} description={t.rulesHint}>
          <AllowlistEditor canEdit={admin} />
        </SettingsSection>
      </>
    );
  }

  return (
    <>
      <PageHeader title={t.title} description={t.lead} width="form" />
      <PageBody width="form">
        <UnsavedChangesGuard when={dirty} />
        {!admin && (
          <p role="note" className="rounded-lg border border-border bg-muted px-3.5 py-2.5 text-xs text-foreground">
            {t.readOnlyBanner}
          </p>
        )}
        {body}
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
  const link = "rounded-sm text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring";
  const crumb = (
    <>
      <Link to="/projects" className={link}>
        {t.projectsCrumb}
      </Link>
      {" / "}
      {project ? (
        <Link to="/projects/$key/settings" params={{ key }} className={cx(link, "font-mono")}>
          {key}
        </Link>
      ) : (
        <span className="font-mono">{key}</span>
      )}
    </>
  );

  let body: ReactNode;
  if (projects.isPending || members.isPending) body = <SectionsSkeleton sections={3} label={t.loading} />;
  else if (projects.isError) body = <LoadFailure error={projects.error} retry={projects.refetch} />;
  else if (!project)
    body = (
      <Alert variant="destructive" className="grid justify-items-start gap-2">
        {t.notFound(key)}
        <Link to="/projects" className={cx(link, "text-sm font-medium")}>
          {t.backToProjects}
        </Link>
      </Alert>
    );
  else {
    const canEdit = teamRoleLookup(org.role, members.data, me.id)(project.teamId) === "admin";
    body = <ProjectSandbox project={project} canEdit={canEdit} />;
  }
  return (
    <>
      <PageHeader crumb={crumb} title={t.title} description={t.lead(key)} width="form" />
      <PageBody width="form">{body}</PageBody>
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
      <SettingsSection title={t.effectiveTitle} description={t.effectiveHint}>
        {effective.isPending ? (
          <div role="status" aria-busy="true" className="flex flex-wrap gap-1.5">
            <span className="sr-only">{t.loading}</span>
            <Skeleton aria-hidden="true" className="h-6 w-40" />
            <Skeleton aria-hidden="true" className="h-6 w-32" />
            <Skeleton aria-hidden="true" className="h-6 w-44" />
          </div>
        ) : effective.isError ? (
          <LoadFailure error={effective.error} retry={effective.refetch} />
        ) : effective.data.rules.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.noRules}</p>
        ) : (
          <ul aria-label={t.effectiveAria} className="flex flex-wrap gap-1.5">
            {effective.data.rules.map((rule) => (
              <li key={rule}>
                <code className="rounded-md border border-border px-2 py-0.5 font-mono text-xs text-foreground">
                  {rule}
                </code>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
      <SettingsSection title={t.projectRulesTitle} description={t.projectRulesHint}>
        <AllowlistEditor
          projectId={project.id}
          canEdit={canEdit}
          {...(effective.data?.locked ? { lockedNote: t.lockedNote } : {})}
        />
      </SettingsSection>
      <EnvImageSection project={project} canEdit={canEdit} />
    </>
  );
}

interface ImageDraft {
  baseImage: string;
  setupScriptHash: string;
}

function EnvImageSection({ project, canEdit }: { project: Project; canEdit: boolean }) {
  const { api } = useOrg();
  const t = useT(projectText);
  const queryClient = useQueryClient();
  const ids = { image: useId(), hash: useId() };
  const image = useQuery(api.sandbox.getImage.queryOptions({ input: { projectId: project.id } }));
  const [draft, setDraft] = useState<ImageDraft | null>(null);
  const [errors, setErrors] = useState<{ baseImage?: string; setupScriptHash?: string }>({});
  const save = useMutation({
    mutationFn: (input: ImageDraft) => api.sandbox.setImage.call({ projectId: project.id, ...input }),
    onSuccess: (next) => {
      queryClient.setQueryData(api.sandbox.getImage.queryKey({ input: { projectId: project.id } }), next);
      setDraft(null);
    },
  });
  const stored: ImageDraft = {
    baseImage: image.data?.baseImage ?? "",
    setupScriptHash: image.data?.setupScriptHash ?? "",
  };
  const value = draft ?? stored;
  const dirty =
    draft !== null && (draft.baseImage !== stored.baseImage || draft.setupScriptHash !== stored.setupScriptHash);
  const edit = (patch: Partial<ImageDraft>) => {
    save.reset();
    setDraft({ ...value, ...patch });
  };

  function submit() {
    const parsed = envImageInput.safeParse({
      baseImage: value.baseImage.trim(),
      setupScriptHash: value.setupScriptHash.trim().toLowerCase(),
    });
    if (!parsed.success) {
      const next: typeof errors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] as keyof typeof errors;
        next[field] ??= issue.message;
      }
      setErrors(next);
      // Lỗi nằm dưới ô; đưa con trỏ tới ô sai đầu tiên để người dùng sửa ngay.
      document.getElementById(next.baseImage ? ids.image : ids.hash)?.focus();
      return;
    }
    setErrors({});
    save.mutate(parsed.data);
  }

  return (
    <SettingsSection
      title={t.imageTitle}
      description={t.imageHint}
      save={
        canEdit && image.data !== undefined
          ? {
              dirty,
              saving: save.isPending,
              saved: save.isSuccess,
              error: save.isError ? apiErrorMessage(save.error) : undefined,
              onSave: submit,
              onDiscard: () => {
                save.reset();
                setErrors({});
                setDraft(null);
              },
              saveLabel: t.saveImage,
              savedLabel: t.savedImage,
            }
          : undefined
      }
    >
      <UnsavedChangesGuard when={dirty} />
      {image.isPending ? (
        <div role="status" aria-busy="true" className="grid gap-3">
          <span className="sr-only">{t.loading}</span>
          <Skeleton aria-hidden="true" className="h-9 w-full" />
          <Skeleton aria-hidden="true" className="h-9 w-full" />
        </div>
      ) : image.isError ? (
        <LoadFailure error={image.error} retry={image.refetch} />
      ) : (
        <>
          <FormRow label={t.baseImageLabel} hint={t.baseImageHint} htmlFor={ids.image}>
            <Field invalid={errors.baseImage !== undefined}>
              <Input
                id={ids.image}
                value={value.baseImage}
                onChange={(e) => edit({ baseImage: e.currentTarget.value })}
                placeholder="node:24-bookworm-slim"
                className="font-mono text-xs"
                spellCheck={false}
                disabled={!canEdit}
              />
              {errors.baseImage && <FieldError>{errors.baseImage}</FieldError>}
            </Field>
          </FormRow>
          <FormRow label={t.hashLabel} hint={t.hashHint} htmlFor={ids.hash}>
            <Field invalid={errors.setupScriptHash !== undefined}>
              <Input
                id={ids.hash}
                value={value.setupScriptHash}
                onChange={(e) => edit({ setupScriptHash: e.currentTarget.value })}
                className="font-mono text-xs"
                spellCheck={false}
                disabled={!canEdit}
              />
              {errors.setupScriptHash && <FieldError>{errors.setupScriptHash}</FieldError>}
            </Field>
          </FormRow>
        </>
      )}
    </SettingsSection>
  );
}
