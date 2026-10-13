import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Alert } from "@xdev-hive/ui/alert";
import { Button, buttonVariants } from "@xdev-hive/ui/button";
import { Input } from "@xdev-hive/ui/input";
import { type FormEvent, type ReactNode, useState } from "react";
import { OnboardingInviteForm } from "@/components/outside/onboarding-invite-form.tsx";
import {
  checkNameSlug,
  type NameSlugErrors,
  OnboardingNameFields,
} from "@/components/outside/onboarding-name-fields.tsx";
import { OnboardingSignOut } from "@/components/outside/onboarding-sign-out.tsx";
import { OutsideLayout } from "@/components/outside/outside-layout.tsx";
import { Card } from "@/components/ui/card.tsx";
import { Field, FieldError, FieldHint, FieldLabel } from "@/components/ui/field.tsx";
import { formError } from "@/lib/api-errors.ts";
import { cx } from "@/lib/cx.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { canInvite } from "@/lib/invites.ts";
import { orgStore } from "@/lib/org-store.ts";
import { orgsMineQuery } from "@/lib/orgs.ts";
import { client } from "@/lib/rpc.ts";
import { nextTeamColor } from "@/lib/teams.ts";
import { useMe } from "@/shell/me-context.ts";
import { type CurrentOrg, useOrgs } from "@/shell/org-context.ts";

const stepText: Dict<{
  org: string;
  firstTeam: string;
  invite: string;
  teamBody: (name: string) => string;
  inviteBody: (name: string) => string;
  forbidden: (name: string) => string;
}> = {
  vi: {
    org: "Tổ chức",
    firstTeam: "Đội đầu tiên",
    invite: "Mời người",
    teamBody: (name) => `Đội của ${name} sở hữu hệ thống và dự án. Bạn là quản trị của đội này.`,
    inviteBody: (name) => `Mời đồng nghiệp vào ${name}. Mỗi người nhận một link dùng một lần, hết hạn sau 7 ngày.`,
    forbidden: (name) => `Chỉ quản trị tổ chức mời được người vào ${name}.`,
  },
  en: {
    org: "Organization",
    firstTeam: "First team",
    invite: "Invite people",
    teamBody: (name) => `${name} teams own systems and projects. You will be this team’s admin.`,
    inviteBody: (name) => `Invite colleagues to ${name}. Each person gets a one-time link that expires in 7 days.`,
    forbidden: (name) => `Only organization admins can invite people to ${name}.`,
  },
};
const text: Dict<
  Record<
    | "steps"
    | "orgTitle"
    | "orgBody"
    | "orgName"
    | "orgPlaceholder"
    | "slugHint"
    | "domain"
    | "domainHint"
    | "cancel"
    | "creatingOrg"
    | "nextTeam"
    | "teamTitle"
    | "teamName"
    | "teamPlaceholder"
    | "teamSlugHint"
    | "later"
    | "creatingTeam"
    | "nextInvite"
    | "loading"
    | "inviteTitle"
    | "openTeams"
    | "done",
    string
  >
> = {
  vi: {
    steps: "Các bước",
    orgTitle: "Tạo tổ chức",
    orgBody: "Tổ chức chứa các đội, hệ thống và dự án. Bạn là chủ sở hữu.",
    orgName: "Tên tổ chức",
    orgPlaceholder: "Ví dụ: Acme Software xDev",
    slugHint: "Dùng trong đường dẫn và trong lệnh của agent.",
    domain: "Tên miền email (không bắt buộc)",
    domainHint: "Người có email tên miền này thấy tổ chức khi đăng nhập SSO. Họ vẫn cần được duyệt hoặc mời.",
    cancel: "Huỷ",
    creatingOrg: "Đang tạo tổ chức…",
    nextTeam: "Tiếp: tạo đội",
    teamTitle: "Tạo đội đầu tiên",
    teamName: "Tên đội",
    teamPlaceholder: "Ví dụ: Thanh toán",
    teamSlugHint: "Dùng trong đường dẫn và tên hệ thống.",
    later: "Để sau",
    creatingTeam: "Đang tạo đội…",
    nextInvite: "Tiếp: mời người",
    loading: "Đang tải…",
    inviteTitle: "Mời người",
    openTeams: "Vào trang Đội và hệ thống",
    done: "Xong: vào Đội và hệ thống",
  },
  en: {
    steps: "Steps",
    orgTitle: "Create your organization",
    orgBody: "An organization holds teams, systems and projects. You are the owner.",
    orgName: "Organization name",
    orgPlaceholder: "e.g. Acme Software xDev",
    slugHint: "Used in URLs and agent commands.",
    domain: "Email domain (optional)",
    domainHint:
      "People with this email domain see the organization at SSO sign-in. They still need approval or an invite.",
    cancel: "Cancel",
    creatingOrg: "Creating organization…",
    nextTeam: "Next: create team",
    teamTitle: "Create the first team",
    teamName: "Team name",
    teamPlaceholder: "e.g. Payments",
    teamSlugHint: "Used in URLs and system names.",
    later: "Later",
    creatingTeam: "Creating team…",
    nextInvite: "Next: invite people",
    loading: "Loading…",
    inviteTitle: "Invite people",
    openTeams: "Open Teams & systems",
    done: "Done: open Teams & systems",
  },
};

function Steps({ current }: { current: number }) {
  const t = { ...useT(text), ...useT(stepText) };
  return (
    <ol
      aria-label={t.steps}
      className="flex items-center gap-2 border-b border-border bg-muted px-4 py-4 text-xs text-muted-foreground"
    >
      {[t.org, t.firstTeam, t.invite].map((label, i) => (
        <li
          key={label}
          aria-current={i === current ? "step" : undefined}
          className="flex flex-1 flex-wrap items-center gap-1.5"
        >
          <span
            className={cx(
              "grid size-6 shrink-0 place-items-center rounded-full border text-2xs font-semibold",
              i === current && "border-primary bg-primary text-primary-foreground",
              i < current && "border-transparent bg-success-soft text-success",
              i > current && "border-input",
            )}
          >
            {i < current ? "✓" : i + 1}
          </span>
          <span className={i === current ? "font-semibold text-foreground" : ""}>{label}</span>
          {i < 2 && <span aria-hidden="true" className="hidden h-px min-w-2 flex-1 bg-border sm:block" />}
        </li>
      ))}
    </ol>
  );
}

function Heading({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div>
      <h1 className="flex items-center gap-2 font-heading text-2xl font-semibold text-foreground">{title}</h1>
      <p className="mt-1 text-muted-foreground">{children}</p>
    </div>
  );
}

/** Màn 2 của mockup: tạo tổ chức, rồi đội đầu tiên, rồi mời người. Mỗi bước là một trang, tải lại vẫn ở đúng bước. */
export function OnboardingPage() {
  const t = { ...useT(text), ...useT(stepText) };
  const { buoc, doi } = useSearch({ from: "/session/orgs/new" });
  const { current } = useOrgs();
  const step = buoc === "moi" ? 2 : buoc === "doi" ? 1 : 0;
  return (
    <OutsideLayout header={<OnboardingSignOut />}>
      <Card className="mx-auto grid w-full max-w-140 gap-0 overflow-hidden p-0 shadow-lg">
        <Steps current={step} />
        <div className="grid gap-4.5 p-5 sm:p-7">
          {step === 0 && <OrgStep />}
          {/* Ngay sau khi tạo tổ chức, danh sách tổ chức có thể chưa kịp cập nhật vào trang: chờ thay vì báo lỗi. */}
          {step === 1 &&
            (current ? (
              <TeamStep current={current} />
            ) : (
              <p aria-busy="true" className="text-muted-foreground">
                {t.loading}
              </p>
            ))}
          {step === 2 && <InviteStep teamId={doi} />}
        </div>
      </Card>
    </OutsideLayout>
  );
}

type OrgErrors = NameSlugErrors & { emailDomain?: string | undefined };

function OrgStep() {
  const t = { ...useT(text), ...useT(stepText) };
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { orgs } = useOrgs();
  const [errors, setErrors] = useState<OrgErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (input: { name: string; slug: string; emailDomain?: string }) => client.orgs.create(input),
    onSuccess: async (org) => {
      orgStore.set(org.id);
      // Bước sau chỉ mở khi đã thuộc tổ chức, và route kiểm điều đó trên cache: tải lại cache trước khi chuyển bước.
      await queryClient.fetchQuery({ ...orgsMineQuery, staleTime: 0 });
      await navigate({ to: "/orgs/new", search: { buoc: "doi" } });
    },
    onError: (error) => {
      const { field, message } = formError(error);
      if (field === "name" || field === "slug" || field === "emailDomain") setErrors({ [field]: message });
      else setFailure(message);
    },
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const local = checkNameSlug(form);
    setErrors(local);
    setFailure(null);
    if (local.name || local.slug) return;
    const emailDomain = String(form.get("emailDomain") ?? "").trim();
    create.mutate({
      name: String(form.get("name")).trim(),
      slug: String(form.get("slug")),
      ...(emailDomain ? { emailDomain } : {}),
    });
  }

  const busy = create.isPending || create.isSuccess;
  return (
    <form noValidate onSubmit={onSubmit} className="grid gap-4.5">
      <Heading title={t.orgTitle}>{t.orgBody}</Heading>
      <OnboardingNameFields
        nameLabel={t.orgName}
        namePlaceholder={t.orgPlaceholder}
        slugPrefix={`${window.location.host}/`}
        slugHint={t.slugHint}
        errors={errors}
        disabled={busy}
        autoFocus
      />
      <Field invalid={errors.emailDomain !== undefined}>
        <FieldLabel>{t.domain}</FieldLabel>
        <Input name="emailDomain" placeholder="congty.vn" disabled={busy} autoComplete="off" spellCheck={false} />
        {errors.emailDomain ? <FieldError>{errors.emailDomain}</FieldError> : <FieldHint>{t.domainHint}</FieldHint>}
      </Field>
      {failure && <Alert variant="destructive">{failure}</Alert>}
      <div className="flex justify-end gap-2">
        {orgs.length > 0 && (
          <Link to="/" className={buttonVariants({ variant: "ghost" })}>
            {t.cancel}
          </Link>
        )}
        <Button type="submit" variant="default" disabled={busy}>
          {busy ? t.creatingOrg : t.nextTeam}
        </Button>
      </div>
    </form>
  );
}

function TeamStep({ current: { org, api } }: { current: CurrentOrg }) {
  const t = { ...useT(text), ...useT(stepText) };
  const me = useMe();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [errors, setErrors] = useState<NameSlugErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const create = useMutation({
    // Người tạo là quản trị đội, để đội có người quản trị ngay và hiện trong danh sách thành viên của đội.
    mutationFn: (input: { name: string; slug: string }) =>
      api.teams.create.call({ ...input, color: nextTeamColor(0), adminUserId: me.id }),
    onSuccess: async (team) => {
      await queryClient.invalidateQueries({ queryKey: api.teams.key() });
      await navigate({ to: "/orgs/new", search: { buoc: "moi", doi: team.id } });
    },
    onError: (error) => {
      const { field, message } = formError(error);
      if (field === "name" || field === "slug") setErrors({ [field]: message });
      else setFailure(message);
    },
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const local = checkNameSlug(form);
    setErrors(local);
    setFailure(null);
    if (local.name || local.slug) return;
    create.mutate({ name: String(form.get("name")).trim(), slug: String(form.get("slug")) });
  }

  const busy = create.isPending || create.isSuccess;
  return (
    <form noValidate onSubmit={onSubmit} className="grid gap-4.5">
      <Heading title={t.teamTitle}>{t.teamBody(org.name)}</Heading>
      <OnboardingNameFields
        nameLabel={t.teamName}
        namePlaceholder={t.teamPlaceholder}
        slugPlaceholder="thanh-toan"
        slugHint={t.teamSlugHint}
        errors={errors}
        disabled={busy}
        autoFocus
      />
      {failure && <Alert variant="destructive">{failure}</Alert>}
      <div className="flex justify-end gap-2">
        <Link to="/admin/teams" className={buttonVariants({ variant: "ghost" })}>
          {t.later}
        </Link>
        <Button type="submit" variant="default" disabled={busy}>
          {busy ? t.creatingTeam : t.nextInvite}
        </Button>
      </div>
    </form>
  );
}

function InviteStep({ teamId }: { teamId: string | undefined }) {
  const t = { ...useT(text), ...useT(stepText) };
  const { current } = useOrgs();
  const navigate = useNavigate();
  const leave = () => navigate({ to: "/admin/teams", search: teamId ? { doi: teamId } : {} });
  if (!current)
    return (
      <p aria-busy="true" className="text-muted-foreground">
        {t.loading}
      </p>
    );
  // Hub chỉ cho quản trị mời người; người đã tạo tổ chức là chủ sở hữu, nhưng tổ chức đang chọn có thể là tổ chức khác.
  if (!canInvite(current.org.role))
    return (
      <div className="grid gap-4.5">
        <Heading title={t.inviteTitle}>{t.forbidden(current.org.name)}</Heading>
        <div className="flex justify-end">
          <Button variant="default" onClick={leave}>
            {t.openTeams}
          </Button>
        </div>
      </div>
    );
  return (
    <OnboardingInviteForm
      title={<Heading title={t.inviteTitle}>{t.inviteBody(current.org.name)}</Heading>}
      defaultTeamId={teamId}
      cancelLabel={t.later}
      doneLabel={t.done}
      onClose={leave}
    />
  );
}
