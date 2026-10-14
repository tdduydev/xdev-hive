import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SsoJoin, SsoSettings } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { Input } from "@xdev-hive/ui/input";
import { Pill } from "@xdev-hive/ui/pill";
import { type ReactNode, useId, useState } from "react";
import { Icon, type IconName } from "@/components/icons.tsx";
import { DangerZone } from "@/components/page/danger-zone.tsx";
import { FormRow, RadioCards, SettingsSection } from "@/components/page/settings.tsx";
import { UnsavedChangesGuard } from "@/components/page/unsaved-guard.tsx";
import { PeopleCopyField } from "@/components/person.tsx";
import { Field, FieldError } from "@/components/ui/field.tsx";
import { LoadFailure, SectionsSkeleton } from "@/components/ui/query-state.tsx";
import { apiErrorCode, apiErrorMessage, formError } from "@/lib/api-errors.ts";
import { formatDay } from "@/lib/format.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { isOrgAdmin } from "@/lib/roles.ts";
import { checkSsoForm, issuerHost, SSO_JOINS, type SsoFormErrors, type SsoFormValues } from "@/lib/sso.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

const text: Dict<{
  domainUnverified: string;
  title: string;
  description: string;
  signInMethods: string;
  signInMethodsHint: string;
  configureHint: string;
  addedAutomatically: string;
  queued: string;
  oauthHint: string;
  emailAndPassword: string;
  emailHint: string;
  requestingRecord: string;
  savedNeverShownAgain: string;
  leaveEmptyToKeepIt: string;
  secretHint: string;
  saved: string;
  checkFields: string;
  txtRecordName: string;
  txtRecordValue: string;
  requesting: string;
  checking: string;
  check: string;
  removing: string;
  removeSSO: string;
  adminOnly: string;
  loading: string;
  setAtHubLevel: string;
  on: string;
  notConfigured: string;
  ssoHint: string;
  emailDomain: string;
  domainHint: string;
  callback: string;
  callbackHint: string;
  firstLogin: string;
  firstLoginHint: string;
  issuerHint: string;
  verified: string;
  waitingToSaveSettings: string;
  notVerified: string;
  domainVerification: string;
  domainVerificationHint: string;
  recordNameTXT: string;
  value: string;
  dangerHint: string;
  removeRowHint: string;
  removeOrganizationSSO: string;
  removeHint: string;
  cancel: string;
  unverifiedMethod: (host: string, domain: string) => string;
  verifiedMethod: (host: string, domain: string, join: string) => string;
  verifyTaken: (domain: string) => string;
  clientHint: (last: string) => string;
  verifiedHint: (domain: string) => string;
  recordHint: (domain: string, expiry: string) => string;
  recordMatched: (domain: string) => string;
  claimHint: (domain: string | undefined) => string;
  verifiedMessage: (domain: string) => string;
  requestRecord: (domain: string) => string;
  joinLabels: Record<SsoJoin, { title: string; description: string }>;
}> = {
  vi: {
    domainUnverified:
      "Tên miền chưa được xác minh nên SSO chưa tạo tài khoản mới và chưa tự thêm người vào tổ chức: người mới vào bằng link mời. Xác minh tên miền bằng bản ghi TXT ở phần bên dưới.",
    title: "Đăng nhập",
    description: "Cách người trong tổ chức đăng nhập vào hub: SSO của công ty và xác minh tên miền email.",
    signInMethods: "Cách đăng nhập",
    signInMethodsHint: "Trạng thái từng cách đăng nhập của tổ chức.",
    configureHint: "Chưa cấu hình. Điền mục SSO bên dưới để bật.",
    addedAutomatically: "tự thêm vào tổ chức",
    queued: "chờ duyệt",
    oauthHint: "OAuth app chung của hub, quản trị hub cấu hình.",
    emailAndPassword: "Email và mật khẩu",
    emailHint: "Người mới đăng ký bằng link mời, trừ khi quản trị hub mở đăng ký tự do.",
    requestingRecord: "Đang lấy bản ghi…",
    savedNeverShownAgain: "Đã lưu, không hiện lại",
    leaveEmptyToKeepIt: "Để trống nếu không đổi.",
    secretHint: "Hub lưu mã hoá và không bao giờ hiện lại secret.",
    saved: "Đã lưu cấu hình SSO.",
    checkFields: "Chưa lưu được. Kiểm tra các ô báo lỗi rồi lưu lại.",
    txtRecordName: "tên bản ghi TXT",
    txtRecordValue: "giá trị bản ghi TXT",
    requesting: "Đang lấy…",
    checking: "Đang kiểm tra…",
    check: "Kiểm tra",
    removing: "Đang gỡ…",
    removeSSO: "Gỡ SSO",
    adminOnly: "Chỉ quản trị tổ chức xem và sửa được cài đặt đăng nhập.",
    loading: "Đang tải…",
    setAtHubLevel: "Cấu hình ở hub",
    on: "Đang bật",
    notConfigured: "Chưa cấu hình",
    ssoHint: "Dùng nhà cung cấp danh tính của công ty, ví dụ Microsoft Entra, Google Workspace, Keycloak.",
    emailDomain: "Tên miền email",
    domainHint: "Người có email tên miền này đăng nhập bằng SSO của tổ chức.",
    callback: "Callback URL",
    callbackHint: "Dán vào cấu hình app bên nhà cung cấp.",
    firstLogin: "Khi người mới đăng nhập SSO lần đầu",
    firstLoginHint: "Chỉ áp dụng khi tên miền đã xác minh.",
    issuerHint: "Lấy trong cấu hình app bên nhà cung cấp.",
    verified: "Đã xác minh",
    waitingToSaveSettings: "Chờ lưu cấu hình",
    notVerified: "Chưa xác minh",
    domainVerification: "Xác minh tên miền",
    domainVerificationHint: "Chứng minh tổ chức giữ tên miền email bằng bản ghi TXT trên DNS.",
    recordNameTXT: "Tên bản ghi (TXT)",
    value: "Giá trị",
    dangerHint: "Thao tác ở đây ảnh hưởng tới cách mọi người đăng nhập.",
    removeRowHint: "Người đang dùng SSO phải đăng nhập bằng cách khác. Họ vẫn là thành viên.",
    removeOrganizationSSO: "Gỡ SSO của tổ chức?",
    removeHint:
      "Người đang đăng nhập bằng SSO sẽ phải dùng cách khác (GitHub, GitLab, email). Họ vẫn là thành viên của tổ chức. Cấu hình lại SSO thì callback URL giữ nguyên.",
    cancel: "Huỷ",
    unverifiedMethod: (host, domain) => `${host} · ${domain} (chưa xác minh) · người mới: cần lời mời`,
    verifiedMethod: (host, domain, join) => `${host} · ${domain} · người mới: ${join}`,
    verifyTaken: (domain) => `Xác minh ${domain} bằng bản ghi TXT`,
    clientHint: (last) => `Đang dùng Client ID kết thúc bằng ${last}. Nhập lại khi lưu.`,
    verifiedHint: (domain) => `Tên miền ${domain} đã được xác minh là của tổ chức. Có thể xoá bản ghi TXT khỏi DNS.`,
    recordHint: (domain, expiry) =>
      `Thêm bản ghi TXT dưới đây vào DNS của ${domain}, đợi DNS cập nhật (vài phút tới vài giờ) rồi bấm Kiểm tra. Bản ghi dùng được tới ${expiry}.`,
    recordMatched: (domain) => `DNS đã khớp. Lưu cấu hình SSO với tên miền ${domain} để hoàn tất xác minh.`,
    claimHint: (domain) =>
      `Chứng minh tổ chức giữ tên miền ${domain} bằng một bản ghi TXT trên DNS. Tên miền đang bị tổ chức chưa xác minh khác khai thì sẽ chuyển về tổ chức bạn.`,
    verifiedMessage: (domain) => `Đã xác minh tên miền ${domain}.`,
    requestRecord: (domain) => `Lấy bản ghi TXT cho ${domain}`,
    joinLabels: {
      pending: {
        title: "Vào hàng chờ duyệt (khuyên dùng)",
        description: "Quản trị duyệt từng người trước khi họ vào tổ chức.",
      },
      member: {
        title: "Tự thêm vào tổ chức",
        description: "Vai trò Thành viên, chưa thuộc đội nào.",
      },
    },
  },
  en: {
    domainUnverified:
      "The domain is not verified, so SSO cannot create accounts or add new organization members yet. New people need an invite link. Verify the domain with a TXT record below.",
    title: "Sign-in",
    description: "How people in the organization sign in to the hub: company SSO and email domain verification.",
    signInMethods: "Sign-in methods",
    signInMethodsHint: "Status of each way people sign in to the organization.",
    configureHint: "Not configured. Fill out the SSO section below to enable it.",
    addedAutomatically: "added automatically",
    queued: "queued",
    oauthHint: "Shared hub OAuth app, set up by the hub admin.",
    emailAndPassword: "Email and password",
    emailHint: "New people sign up through an invite link unless the hub admin opens sign-up.",
    requestingRecord: "Requesting record…",
    savedNeverShownAgain: "Saved, never shown again",
    leaveEmptyToKeepIt: "Leave empty to keep it.",
    secretHint: "The hub encrypts the secret and never shows it again.",
    saved: "SSO settings saved.",
    checkFields: "Not saved. Check the fields with errors and try again.",
    txtRecordName: "TXT record name",
    txtRecordValue: "TXT record value",
    requesting: "Requesting…",
    checking: "Checking…",
    check: "Check",
    removing: "Removing…",
    removeSSO: "Remove SSO",
    adminOnly: "Only organization admins can view and edit sign-in settings.",
    loading: "Loading…",
    setAtHubLevel: "Set at hub level",
    on: "On",
    notConfigured: "Not configured",
    ssoHint: "Use your company identity provider, e.g. Microsoft Entra, Google Workspace, Keycloak.",
    emailDomain: "Email domain",
    domainHint: "People with this email domain sign in through the organization SSO.",
    callback: "Callback URL",
    callbackHint: "Paste into the provider app settings.",
    firstLogin: "When someone signs in with SSO for the first time",
    firstLoginHint: "Applies only when the domain is verified.",
    issuerHint: "Find it in the provider app settings.",
    verified: "Verified",
    waitingToSaveSettings: "Waiting to save settings",
    notVerified: "Not verified",
    domainVerification: "Domain verification",
    domainVerificationHint: "Prove the organization owns its email domain with a DNS TXT record.",
    recordNameTXT: "Record name (TXT)",
    value: "Value",
    dangerHint: "Actions here change how everyone signs in.",
    removeRowHint: "People using SSO must sign in another way. They remain members.",
    removeOrganizationSSO: "Remove organization SSO?",
    removeHint:
      "People using SSO will need another sign-in method (GitHub, GitLab, email). They remain organization members. The callback URL stays the same when SSO is configured again.",
    cancel: "Cancel",
    unverifiedMethod: (host, domain) => `${host} · ${domain} (not verified) · new people: invite required`,
    verifiedMethod: (host, domain, join) => `${host} · ${domain} · new people: ${join}`,
    verifyTaken: (domain) => `Verify ${domain} with a TXT record`,
    clientHint: (last) => `Current Client ID ends in ${last}. Re-enter it to save.`,
    verifiedHint: (domain) =>
      `${domain} is verified as belonging to the organization. You can remove the TXT record from DNS.`,
    recordHint: (domain, expiry) =>
      `Add this TXT record to the DNS of ${domain}, wait for DNS to update (minutes to hours), then check. This record is valid until ${expiry}.`,
    recordMatched: (domain) => `DNS matches. Save SSO settings with ${domain} to complete verification.`,
    claimHint: (domain) =>
      `Prove ownership of ${domain} with a DNS TXT record. A domain claimed by another unverified organization will transfer to yours.`,
    verifiedMessage: (domain) => `${domain} is verified.`,
    requestRecord: (domain) => `Request TXT record for ${domain}`,
    joinLabels: {
      pending: {
        title: "Queue for approval (recommended)",
        description: "An admin approves each person before they join the organization.",
      },
      member: {
        title: "Add them automatically",
        description: "Member role, no team.",
      },
    },
  },
};

// Lỗi nghiệp vụ của hub (apps/hub, identity/sso.ts) thuộc ô nào trong form.
const SSO_ERROR_FIELDS: Record<string, keyof SsoFormValues> = {
  SSO_DISCOVERY_FAILED: "issuer",
  SSO_SECRET_REQUIRED: "clientSecret",
  SSO_DOMAIN_TAKEN: "domain",
  SSO_DOMAIN_PUBLIC: "domain",
};

/** Lấy bản ghi TXT; kết quả là cấu hình SSO mới, ghi thẳng vào cache để cả trang cập nhật. */
function useRequestVerification() {
  const { api } = useOrg();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (domain?: string) => api.ssoProviders.requestDomainVerification.call(domain ? { domain } : {}),
    onSuccess: (next) => queryClient.setQueryData(api.ssoProviders.get.queryKey(), next),
  });
}

function useRefreshSettings() {
  const { api } = useOrg();
  const queryClient = useQueryClient();
  return (next: SsoSettings) => queryClient.setQueryData(api.ssoProviders.get.queryKey(), next);
}

/** Màn 5 của mockup: các cách đăng nhập của tổ chức và form SSO (OIDC). Chỉ quản trị tổ chức xem được. */
export function LoginSettingsPage() {
  const t = useT(text);
  const { org, api } = useOrg();
  const admin = isOrgAdmin(org.role);
  const settings = useQuery(api.ssoProviders.get.queryOptions({ enabled: admin }));

  let body: ReactNode;
  if (!admin)
    body = (
      <p role="note" className="rounded-lg border border-border bg-muted px-3.5 py-2.5 text-sm text-foreground">
        {t.adminOnly}
      </p>
    );
  else if (settings.isPending) body = <SectionsSkeleton label={t.loading} />;
  else if (settings.isError) body = <LoadFailure error={settings.error} retry={settings.refetch} />;
  else
    body = (
      <>
        <Methods settings={settings.data} />
        <SsoForm settings={settings.data} defaultDomain={org.emailDomain} />
        <DomainVerification settings={settings.data} />
        {settings.data.provider && <RemoveSsoZone />}
      </>
    );

  return (
    <>
      <PageHeader title={t.title} description={t.description} width="form" />
      <PageBody width="form">{body}</PageBody>
    </>
  );
}

function Method({ icon, name, detail, status }: { icon: IconName; name: string; detail: string; status: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
      <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted">
        <Icon name={icon} className="size-5" />
      </span>
      <span className="min-w-0 flex-1 basis-40">
        <b className="block font-semibold text-foreground">{name}</b>
        <small className="block text-xs text-muted-foreground">{detail}</small>
      </span>
      <span className="ml-auto">{status}</span>
    </li>
  );
}

/**
 * Trạng thái từng cách đăng nhập. SSO cấu hình theo tổ chức nên biết chắc trạng thái. GitHub, GitLab, email là cấu
 * hình chung của hub (biến môi trường), hub chưa có API cho biết đang bật cách nào, nên chỉ ghi nơi cấu hình.
 */
function Methods({ settings }: { settings: SsoSettings }) {
  const t = useT(text);
  const sso = settings.provider;
  const hubWide = <Pill>{t.setAtHubLevel}</Pill>;
  return (
    <SettingsSection title={t.signInMethods} description={t.signInMethodsHint}>
      <ul aria-label={t.signInMethods} className="grid divide-y divide-border">
        <Method
          icon="key"
          name="SSO (OIDC)"
          detail={
            !sso
              ? t.configureHint
              : sso.domainVerified
                ? t.verifiedMethod(
                    issuerHost(sso.issuer),
                    sso.domain,
                    settings.join === "member" ? t.addedAutomatically : t.queued,
                  )
                : t.unverifiedMethod(issuerHost(sso.issuer), sso.domain)
          }
          status={sso ? <Pill tone="ok">{t.on}</Pill> : <Pill>{t.notConfigured}</Pill>}
        />
        <Method icon="github" name="GitHub" detail={t.oauthHint} status={hubWide} />
        <Method icon="gitlab" name="GitLab" detail={t.oauthHint} status={hubWide} />
        <Method icon="mail" name={t.emailAndPassword} detail={t.emailHint} status={<Pill tone="ok">{t.on}</Pill>} />
      </ul>
    </SettingsSection>
  );
}

interface SsoInput {
  issuer: string;
  domain: string;
  clientId: string;
  clientSecret?: string;
  join: SsoJoin;
}

type SsoDraft = SsoFormValues & { join: SsoJoin };

/**
 * Hub không trả Client ID đầy đủ lẫn secret, nên hai ô này luôn bắt đầu trống và "có thay đổi" nghĩa là đã nhập gì đó.
 * Chưa cấu hình thì tên miền điền sẵn từ tên miền email của tổ chức và chưa tính là thay đổi.
 */
function draftOf(settings: SsoSettings, defaultDomain: string | null): SsoDraft {
  const provider = settings.provider;
  return {
    issuer: provider?.issuer ?? "",
    domain: provider?.domain ?? defaultDomain ?? "",
    clientId: "",
    clientSecret: "",
    join: settings.join,
  };
}

function SsoForm({ settings, defaultDomain }: { settings: SsoSettings; defaultDomain: string | null }) {
  const t = useT(text);
  const { api } = useOrg();
  const refresh = useRefreshSettings();
  const ids = { issuer: useId(), domain: useId(), clientId: useId(), clientSecret: useId(), callback: useId() };
  const provider = settings.provider;
  const configured = provider !== null;
  const [draft, setDraft] = useState<SsoDraft>(() => draftOf(settings, defaultDomain));
  const [errors, setErrors] = useState<SsoFormErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // Tên miền đang bị tổ chức khác giữ: tổ chức này giành lại được nếu chứng minh giữ DNS (hub kiểm bản ghi TXT).
  const [taken, setTaken] = useState<string | null>(null);
  const claim = useRequestVerification();
  const base = draftOf(settings, defaultDomain);
  const dirty = (Object.keys(base) as (keyof SsoDraft)[]).some((key) => draft[key] !== base[key]);
  // Gỡ SSO ở vùng nguy hiểm: form quay về trạng thái chưa cấu hình thay vì giữ giá trị của cấu hình vừa gỡ.
  const [wasConfigured, setWasConfigured] = useState(configured);
  if (wasConfigured !== configured) {
    setWasConfigured(configured);
    if (!configured) {
      setDraft(base);
      setSaved(false);
    }
  }

  const save = useMutation({
    mutationFn: (input: SsoInput) => api.ssoProviders.upsert.call(input),
    onSuccess: (next) => {
      // Secret chỉ ghi: lưu xong thì xoá khỏi ô, không giữ trong trang lâu hơn cần.
      setDraft(draftOf(next, defaultDomain));
      setSaved(true);
      refresh(next);
    },
    onError: (error, input) => {
      setTaken(apiErrorCode(error) === "SSO_DOMAIN_TAKEN" ? input.domain : null);
      const { field, message } = formError(error, SSO_ERROR_FIELDS);
      if (field === "issuer" || field === "domain" || field === "clientId" || field === "clientSecret") {
        setErrors({ [field]: message });
        setFailure(t.checkFields);
      } else setFailure(message);
    },
  });

  function edit<K extends keyof SsoDraft>(key: K, value: SsoDraft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    setSaved(false);
  }

  function onSave() {
    const values: SsoFormValues = {
      issuer: draft.issuer.trim(),
      domain: draft.domain.trim().toLowerCase(),
      clientId: draft.clientId.trim(),
      clientSecret: draft.clientSecret,
    };
    const local = checkSsoForm(values, configured);
    const invalid = Object.values(local).some(Boolean);
    setErrors(local);
    setFailure(invalid ? t.checkFields : null);
    setSaved(false);
    setTaken(null);
    claim.reset();
    if (invalid) return;
    const { clientSecret, ...rest } = values;
    save.mutate({ ...rest, join: draft.join, ...(clientSecret ? { clientSecret } : {}) });
  }

  const busy = save.isPending;
  return (
    <>
      <UnsavedChangesGuard when={dirty} />
      <SettingsSection
        id="sso"
        title="SSO (OIDC)"
        description={t.ssoHint}
        save={{
          dirty,
          saving: busy,
          saved,
          error: failure,
          savedLabel: t.saved,
          onSave,
          onDiscard: () => {
            setDraft(base);
            setErrors({});
            setFailure(null);
            setTaken(null);
            claim.reset();
          },
        }}
      >
        {provider && !provider.domainVerified && (
          <p role="note" className="rounded-lg bg-warning-soft px-3.5 py-2.5 text-sm text-warning">
            {t.domainUnverified}
          </p>
        )}
        <FormRow label="Issuer URL" hint={t.issuerHint} htmlFor={ids.issuer}>
          <Field invalid={errors.issuer !== undefined}>
            <Input
              id={ids.issuer}
              type="url"
              value={draft.issuer}
              onValueChange={(v) => edit("issuer", v)}
              placeholder="https://login.microsoftonline.com/<tenant>/v2.0"
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
            />
            {errors.issuer && <FieldError>{errors.issuer}</FieldError>}
          </Field>
        </FormRow>
        <FormRow label={t.emailDomain} hint={t.domainHint} htmlFor={ids.domain}>
          <Field invalid={errors.domain !== undefined}>
            <Input
              id={ids.domain}
              value={draft.domain}
              onValueChange={(v) => edit("domain", v)}
              placeholder="congty.vn"
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
            />
            {errors.domain && (
              <>
                <FieldError>{errors.domain}</FieldError>
                {taken && !claim.isSuccess && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="justify-self-start"
                    onClick={() => claim.mutate(taken)}
                    disabled={claim.isPending}
                  >
                    {claim.isPending ? t.requestingRecord : t.verifyTaken(taken)}
                  </Button>
                )}
                {claim.isError && <FieldError>{apiErrorMessage(claim.error)}</FieldError>}
              </>
            )}
          </Field>
        </FormRow>
        <FormRow
          label="Client ID"
          hint={provider?.clientIdLastFour ? t.clientHint(provider.clientIdLastFour) : undefined}
          htmlFor={ids.clientId}
        >
          <Field invalid={errors.clientId !== undefined}>
            <Input
              id={ids.clientId}
              value={draft.clientId}
              onValueChange={(v) => edit("clientId", v)}
              // Hub chỉ trả 4 ký tự cuối, mà lưu thì cần Client ID đầy đủ.
              placeholder={provider?.clientIdLastFour ? `…${provider.clientIdLastFour}` : undefined}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
            />
            {errors.clientId && <FieldError>{errors.clientId}</FieldError>}
          </Field>
        </FormRow>
        <FormRow
          label="Client secret"
          hint={configured ? t.leaveEmptyToKeepIt : t.secretHint}
          htmlFor={ids.clientSecret}
        >
          <Field invalid={errors.clientSecret !== undefined}>
            <Input
              id={ids.clientSecret}
              type="password"
              value={draft.clientSecret}
              onValueChange={(v) => edit("clientSecret", v)}
              placeholder={configured ? t.savedNeverShownAgain : undefined}
              disabled={busy}
              autoComplete="new-password"
            />
            {errors.clientSecret && <FieldError>{errors.clientSecret}</FieldError>}
          </Field>
        </FormRow>
        <FormRow label={t.callback} hint={t.callbackHint} htmlFor={ids.callback}>
          <PeopleCopyField id={ids.callback} value={settings.callbackUrl} copyLabel="callback URL" />
        </FormRow>
        <FormRow label={t.firstLogin} hint={t.firstLoginHint}>
          <RadioCards
            name="join"
            label={t.firstLogin}
            value={draft.join}
            onChange={(v) => edit("join", v)}
            disabled={busy}
            options={SSO_JOINS.map((j) => ({
              value: j,
              title: t.joinLabels[j].title,
              description: t.joinLabels[j].description,
            }))}
          />
        </FormRow>
      </SettingsSection>
    </>
  );
}

/**
 * Chứng minh tổ chức giữ tên miền: quản trị thêm bản ghi TXT vào DNS rồi bấm Kiểm tra. Đã xác minh thì SSO tự tạo tài
 * khoản cho người trong tên miền và áp chính sách người mới; tên miền đang bị tổ chức chưa xác minh giữ thì hub gỡ
 * khỏi tổ chức đó.
 */
function DomainVerification({ settings }: { settings: SsoSettings }) {
  const t = useT(text);
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const request = useRequestVerification();
  const recordNameId = useId();
  const recordValueId = useId();
  const [checked, setChecked] = useState(false);
  const check = useMutation({
    mutationFn: () => api.ssoProviders.checkDomainVerification.call(),
    onMutate: () => setChecked(false),
    onSuccess: (next) => {
      setChecked(true);
      queryClient.setQueryData(api.ssoProviders.get.queryKey(), next);
    },
  });
  const provider = settings.provider;
  const pending = settings.domainVerification;
  if (!provider && !pending) return null;

  const verified = provider?.domainVerified === true && !pending;
  // Bản ghi đang chờ là của tên miền khác (vd. tên miền đang giành): vẫn cho lấy bản ghi cho tên miền đang cấu hình.
  const canRequest = provider !== null && !provider.domainVerified && pending?.domain !== provider.domain;
  const status = verified ? (
    <Pill tone="ok">{t.verified}</Pill>
  ) : pending?.verified ? (
    <Pill tone="warn">{t.waitingToSaveSettings}</Pill>
  ) : (
    <Pill>{t.notVerified}</Pill>
  );

  return (
    <SettingsSection
      id="domain"
      title={t.domainVerification}
      description={t.domainVerificationHint}
      actions={
        <>
          {status}
          {!verified && canRequest && (
            <Button
              variant={pending ? "outline" : "default"}
              size="sm"
              onClick={() => request.mutate(undefined)}
              disabled={request.isPending}
            >
              {request.isPending ? t.requesting : t.requestRecord(provider.domain)}
            </Button>
          )}
          {!verified && pending && !pending.verified && (
            <Button variant="default" size="sm" onClick={() => check.mutate()} disabled={check.isPending}>
              {check.isPending ? t.checking : t.check}
            </Button>
          )}
        </>
      }
    >
      {verified && provider ? (
        <p className="text-muted-foreground">{t.verifiedHint(provider.domain)}</p>
      ) : pending ? (
        <>
          <p className="text-muted-foreground">{t.recordHint(pending.domain, formatDay(pending.expiresAt))}</p>
          <FormRow label={t.recordNameTXT} htmlFor={recordNameId}>
            <PeopleCopyField id={recordNameId} value={pending.recordName} copyLabel={t.txtRecordName} />
          </FormRow>
          <FormRow label={t.value} htmlFor={recordValueId}>
            <PeopleCopyField id={recordValueId} value={pending.recordValue} copyLabel={t.txtRecordValue} />
          </FormRow>
          {pending.verified && (
            <p role="status" className="rounded-lg bg-warning-soft px-3.5 py-2.5 text-sm text-warning">
              {t.recordMatched(pending.domain)}
            </p>
          )}
        </>
      ) : (
        <p className="text-muted-foreground">{t.claimHint(provider?.domain)}</p>
      )}
      {check.isError && <Alert variant="destructive">{apiErrorMessage(check.error)}</Alert>}
      {request.isError && <Alert variant="destructive">{apiErrorMessage(request.error)}</Alert>}
      {checked && verified && provider && (
        <p role="status" className="rounded-lg bg-success-soft px-3.5 py-2.5 text-sm text-success">
          {t.verifiedMessage(provider.domain)}
        </p>
      )}
    </SettingsSection>
  );
}

function RemoveSsoZone() {
  const t = useT(text);
  const refresh = useRefreshSettings();
  const [removing, setRemoving] = useState(false);
  return (
    <>
      <DangerZone description={`${t.dangerHint} ${t.removeRowHint}`}>
        <Button variant="destructive" onClick={() => setRemoving(true)}>
          {t.removeSSO}
        </Button>
      </DangerZone>
      <Dialog open={removing} onOpenChange={setRemoving}>
        <DialogContent>
          <RemoveSso onDone={() => setRemoving(false)} onRemoved={refresh} />
        </DialogContent>
      </Dialog>
    </>
  );
}

function RemoveSso({ onDone, onRemoved }: { onDone: () => void; onRemoved: (next: SsoSettings) => void }) {
  const t = useT(text);
  const { api } = useOrg();
  const remove = useMutation({
    mutationFn: () => api.ssoProviders.remove.call(),
    onSuccess: (next) => {
      onDone();
      onRemoved(next);
    },
  });
  return (
    <>
      <DialogTitle>{t.removeOrganizationSSO}</DialogTitle>
      <DialogDescription>{t.removeHint}</DialogDescription>
      {remove.isError && <Alert variant="destructive">{apiErrorMessage(remove.error)}</Alert>}
      <DialogActions>
        <Button variant="outline" onClick={onDone} disabled={remove.isPending}>
          {t.cancel}
        </Button>
        <Button variant="destructive-solid" onClick={() => remove.mutate()} disabled={remove.isPending}>
          {remove.isPending ? t.removing : t.removeSSO}
        </Button>
      </DialogActions>
    </>
  );
}
