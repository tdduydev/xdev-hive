import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SsoJoin, SsoSettings } from "@xdev-hive/contracts";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { Icon, type IconName } from "@/components/icons.tsx";
import { PeopleCopyField } from "@/components/person.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card } from "@/components/ui/card.tsx";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.tsx";
import { Field, FieldError, FieldHint, FieldLabel } from "@/components/ui/field.tsx";
import { Input } from "@/components/ui/input.tsx";
import { NativeSelect } from "@/components/ui/native-select.tsx";
import { Pill } from "@/components/ui/pill.tsx";
import { apiErrorCode, apiErrorMessage, formError } from "@/lib/api-errors.ts";
import { formatDay } from "@/lib/format.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { isOrgAdmin } from "@/lib/roles.ts";
import { checkSsoForm, issuerHost, SSO_JOINS, type SsoFormErrors, type SsoFormValues } from "@/lib/sso.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

const text: Dict<{
  domainUnverified: string;
  admin: string;
  signInSettings: string;
  signInMethods: string;
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
  saving: string;
  save: string;
  txtRecordName: string;
  txtRecordValue: string;
  requesting: string;
  checking: string;
  check: string;
  removing: string;
  removeSSO: string;
  adminOnly: string;
  loading: string;
  lead: string;
  setAtHubLevel: string;
  on: string;
  notConfigured: string;
  ssoHint: string;
  emailDomain: string;
  domainHint: string;
  callback: string;
  firstLogin: string;
  ssoSettingsSaved: string;
  verified: string;
  waitingToSaveSettings: string;
  notVerified: string;
  domainVerification: string;
  recordNameTXT: string;
  value: string;
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
  joinLabels: Record<"pending" | "member", string>;
}> = {
  vi: {
    domainUnverified:
      "Tên miền chưa được xác minh nên SSO chưa tạo tài khoản mới và chưa tự thêm người vào tổ chức: người mới vào bằng link mời. Xác minh tên miền bằng bản ghi TXT ở phần bên dưới.",
    admin: "Quản trị",
    signInSettings: "Cài đặt đăng nhập",
    signInMethods: "Cách đăng nhập",
    configureHint: "Chưa cấu hình. Điền form bên dưới để bật.",
    addedAutomatically: "tự thêm vào tổ chức",
    queued: "chờ duyệt",
    oauthHint: "OAuth app chung của hub, quản trị hub cấu hình.",
    emailAndPassword: "Email và mật khẩu",
    emailHint: "Người mới đăng ký bằng link mời, trừ khi quản trị hub mở đăng ký tự do.",
    requestingRecord: "Đang lấy bản ghi…",
    savedNeverShownAgain: "Đã lưu, không hiện lại",
    leaveEmptyToKeepIt: "Để trống nếu không đổi.",
    secretHint: "Hub lưu mã hoá và không bao giờ hiện lại secret.",
    saving: "Đang lưu…",
    save: "Lưu",
    txtRecordName: "tên bản ghi TXT",
    txtRecordValue: "giá trị bản ghi TXT",
    requesting: "Đang lấy…",
    checking: "Đang kiểm tra…",
    check: "Kiểm tra",
    removing: "Đang gỡ…",
    removeSSO: "Gỡ SSO",
    adminOnly: "Chỉ quản trị tổ chức xem và sửa được cài đặt đăng nhập.",
    loading: "Đang tải…",
    lead: "Cách người trong tổ chức đăng nhập vào hub.",
    setAtHubLevel: "Cấu hình ở hub",
    on: "Đang bật",
    notConfigured: "Chưa cấu hình",
    ssoHint: "Dùng nhà cung cấp danh tính của công ty, ví dụ Microsoft Entra, Google Workspace, Keycloak.",
    emailDomain: "Tên miền email",
    domainHint: "Người có email tên miền này đăng nhập bằng SSO của tổ chức.",
    callback: "Callback URL (dán vào cấu hình app bên nhà cung cấp)",
    firstLogin: "Khi người mới đăng nhập SSO lần đầu",
    ssoSettingsSaved: "Đã lưu cấu hình SSO.",
    verified: "Đã xác minh",
    waitingToSaveSettings: "Chờ lưu cấu hình",
    notVerified: "Chưa xác minh",
    domainVerification: "Xác minh tên miền",
    recordNameTXT: "Tên bản ghi (TXT)",
    value: "Giá trị",
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
      pending: "Vào hàng chờ duyệt (khuyên dùng)",
      member: "Tự thêm vào tổ chức với vai trò Thành viên, chưa thuộc đội nào",
    },
  },
  en: {
    domainUnverified:
      "The domain is not verified, so SSO cannot create accounts or add new organization members yet. New people need an invite link. Verify the domain with a TXT record below.",
    admin: "Admin",
    signInSettings: "Sign-in settings",
    signInMethods: "Sign-in methods",
    configureHint: "Not configured. Fill out the form below to enable it.",
    addedAutomatically: "added automatically",
    queued: "queued",
    oauthHint: "Shared hub OAuth app, set up by the hub admin.",
    emailAndPassword: "Email and password",
    emailHint: "New people sign up through an invite link unless the hub admin opens sign-up.",
    requestingRecord: "Requesting record…",
    savedNeverShownAgain: "Saved, never shown again",
    leaveEmptyToKeepIt: "Leave empty to keep it.",
    secretHint: "The hub encrypts the secret and never shows it again.",
    saving: "Saving…",
    save: "Save",
    txtRecordName: "TXT record name",
    txtRecordValue: "TXT record value",
    requesting: "Requesting…",
    checking: "Checking…",
    check: "Check",
    removing: "Removing…",
    removeSSO: "Remove SSO",
    adminOnly: "Only organization admins can view and edit sign-in settings.",
    loading: "Loading…",
    lead: "How people in the organization sign in to the hub.",
    setAtHubLevel: "Set at hub level",
    on: "On",
    notConfigured: "Not configured",
    ssoHint: "Use your company identity provider, e.g. Microsoft Entra, Google Workspace, Keycloak.",
    emailDomain: "Email domain",
    domainHint: "People with this email domain sign in through the organization SSO.",
    callback: "Callback URL (paste into the provider app settings)",
    firstLogin: "When someone signs in with SSO for the first time",
    ssoSettingsSaved: "SSO settings saved.",
    verified: "Verified",
    waitingToSaveSettings: "Waiting to save settings",
    notVerified: "Not verified",
    domainVerification: "Domain verification",
    recordNameTXT: "Record name (TXT)",
    value: "Value",
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
    joinLabels: { pending: "Queue for approval (recommended)", member: "Add them as a Member with no team" },
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

/** Màn 5 của mockup: các cách đăng nhập của tổ chức và form SSO (OIDC). Chỉ quản trị tổ chức xem được. */
export function LoginSettingsPage() {
  const t = useT(text);
  const { org, api } = useOrg();
  const admin = isOrgAdmin(org.role);
  const settings = useQuery(api.ssoProviders.get.queryOptions({ enabled: admin }));

  let body: ReactNode;
  if (!admin) body = <Card className="px-6 py-10 text-center text-muted-foreground">{t.adminOnly}</Card>;
  else if (settings.isPending)
    body = (
      <p aria-busy="true" className="text-muted-foreground">
        {t.loading}
      </p>
    );
  else if (settings.isError) body = <Alert variant="destructive">{apiErrorMessage(settings.error)}</Alert>;
  else
    body = (
      <>
        <Methods settings={settings.data} />
        <SsoForm settings={settings.data} defaultDomain={org.emailDomain} />
        <DomainVerification settings={settings.data} />
      </>
    );

  return (
    <>
      <PageHeader crumb={t.admin} title={t.signInSettings} />
      <PageBody>
        <div className="grid w-full max-w-5xl gap-5">
          <p className="text-muted-foreground">{t.lead}</p>
          {body}
        </div>
      </PageBody>
    </>
  );
}

function Method({ icon, name, detail, status }: { icon: IconName; name: string; detail: string; status: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-3 border-b border-border px-4.5 py-3.5 last:border-b-0">
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
    <Card>
      <ul aria-label={t.signInMethods}>
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
    </Card>
  );
}

interface SsoInput {
  issuer: string;
  domain: string;
  clientId: string;
  clientSecret?: string;
  join: SsoJoin;
}

function SsoForm({ settings, defaultDomain }: { settings: SsoSettings; defaultDomain: string | null }) {
  const t = useT(text);
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const joinId = useId();
  const provider = settings.provider;
  const configured = provider !== null;
  const [errors, setErrors] = useState<SsoFormErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  // Secret chỉ ghi: lưu xong thì xoá khỏi ô, không giữ trong trang lâu hơn cần.
  const [secret, setSecret] = useState("");
  const [saved, setSaved] = useState(false);
  const [removing, setRemoving] = useState(false);
  // Tên miền đang bị tổ chức khác giữ: tổ chức này giành lại được nếu chứng minh giữ DNS (hub kiểm bản ghi TXT).
  const [taken, setTaken] = useState<string | null>(null);
  const claim = useRequestVerification();
  const refresh = (next: SsoSettings) => queryClient.setQueryData(api.ssoProviders.get.queryKey(), next);
  const save = useMutation({
    mutationFn: (input: SsoInput) => api.ssoProviders.upsert.call(input),
    onSuccess: (next) => {
      setSecret("");
      setSaved(true);
      refresh(next);
    },
    onError: (error, input) => {
      setTaken(apiErrorCode(error) === "SSO_DOMAIN_TAKEN" ? input.domain : null);
      const { field, message } = formError(error, SSO_ERROR_FIELDS);
      if (field === "issuer" || field === "domain" || field === "clientId" || field === "clientSecret")
        setErrors({ [field]: message });
      else setFailure(message);
    },
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const values: SsoFormValues = {
      issuer: String(form.get("issuer") ?? "").trim(),
      domain: String(form.get("domain") ?? "")
        .trim()
        .toLowerCase(),
      clientId: String(form.get("clientId") ?? "").trim(),
      clientSecret: String(form.get("clientSecret") ?? ""),
    };
    const local = checkSsoForm(values, configured);
    setErrors(local);
    setFailure(null);
    setSaved(false);
    setTaken(null);
    claim.reset();
    if (Object.values(local).some(Boolean)) return;
    const join = SSO_JOINS.find((j) => j === form.get("join")) ?? "pending";
    const { clientSecret, ...rest } = values;
    save.mutate({ ...rest, join, ...(clientSecret ? { clientSecret } : {}) });
  }

  const busy = save.isPending;
  return (
    <Card className="grid gap-3.5 px-4.5 py-4">
      <div className="flex items-center gap-2.5">
        <div>
          <h2 className="text-base font-semibold text-foreground">SSO (OIDC)</h2>
          <p className="text-sm text-muted-foreground">{t.ssoHint}</p>
        </div>
        {configured && (
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setRemoving(true)} disabled={busy}>
            {t.removeSSO}
          </Button>
        )}
      </div>
      <form noValidate onSubmit={onSubmit} className="grid gap-3.5">
        <div className="grid grid-cols-1 items-start gap-3.5 app:grid-cols-2">
          <Field invalid={errors.issuer !== undefined}>
            <FieldLabel>Issuer URL</FieldLabel>
            <Input
              name="issuer"
              type="url"
              defaultValue={provider?.issuer ?? ""}
              placeholder="https://login.microsoftonline.com/<tenant>/v2.0"
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
            />
            {errors.issuer && <FieldError>{errors.issuer}</FieldError>}
          </Field>
          <Field invalid={errors.domain !== undefined}>
            <FieldLabel>{t.emailDomain}</FieldLabel>
            <Input
              name="domain"
              defaultValue={provider?.domain ?? defaultDomain ?? ""}
              placeholder="congty.vn"
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
            />
            {errors.domain ? (
              <>
                <FieldError>{errors.domain}</FieldError>
                {taken && !claim.isSuccess && (
                  <Button variant="outline" size="sm" onClick={() => claim.mutate(taken)} disabled={claim.isPending}>
                    {claim.isPending ? t.requestingRecord : t.verifyTaken(taken)}
                  </Button>
                )}
                {claim.isError && <FieldError>{apiErrorMessage(claim.error)}</FieldError>}
              </>
            ) : provider && !provider.domainVerified ? (
              <FieldHint>{t.domainUnverified}</FieldHint>
            ) : (
              <FieldHint>{t.domainHint}</FieldHint>
            )}
          </Field>
          <Field invalid={errors.clientId !== undefined}>
            <FieldLabel>Client ID</FieldLabel>
            <Input
              name="clientId"
              placeholder={provider?.clientIdLastFour ? `…${provider.clientIdLastFour}` : undefined}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
            />
            {errors.clientId ? (
              <FieldError>{errors.clientId}</FieldError>
            ) : (
              provider?.clientIdLastFour && (
                // Hub chỉ trả 4 ký tự cuối, mà lưu thì cần Client ID đầy đủ.
                <FieldHint>{t.clientHint(provider.clientIdLastFour)}</FieldHint>
              )
            )}
          </Field>
          <Field invalid={errors.clientSecret !== undefined}>
            <FieldLabel>Client secret</FieldLabel>
            <Input
              name="clientSecret"
              type="password"
              value={secret}
              onValueChange={setSecret}
              placeholder={configured ? t.savedNeverShownAgain : undefined}
              disabled={busy}
              autoComplete="new-password"
            />
            {errors.clientSecret ? (
              <FieldError>{errors.clientSecret}</FieldError>
            ) : (
              <FieldHint>{configured ? t.leaveEmptyToKeepIt : t.secretHint}</FieldHint>
            )}
          </Field>
        </div>
        <Field>
          <FieldLabel>{t.callback}</FieldLabel>
          <PeopleCopyField value={settings.callbackUrl} copyLabel="callback URL" />
        </Field>
        <div className="grid gap-1.5">
          <label htmlFor={joinId} className="text-sm font-medium text-foreground">
            {t.firstLogin}
          </label>
          <NativeSelect id={joinId} name="join" defaultValue={settings.join} disabled={busy}>
            {SSO_JOINS.map((j) => (
              <option key={j} value={j}>
                {t.joinLabels[j]}
              </option>
            ))}
          </NativeSelect>
        </div>
        {failure && <Alert variant="destructive">{failure}</Alert>}
        {saved && !failure && (
          <p role="status" className="rounded-lg bg-success-soft px-3.5 py-2.5 text-sm text-success">
            {t.ssoSettingsSaved}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="submit" variant="default" disabled={busy}>
            {busy ? t.saving : t.save}
          </Button>
        </div>
      </form>
      <Dialog open={removing} onOpenChange={setRemoving}>
        <DialogContent>
          <RemoveSso onDone={() => setRemoving(false)} onRemoved={refresh} />
        </DialogContent>
      </Dialog>
    </Card>
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
    <Card className="grid gap-3.5 px-4.5 py-4">
      <div className="flex items-center gap-2.5">
        <h2 className="text-base font-semibold text-foreground">{t.domainVerification}</h2>
        <span className="ml-auto">{status}</span>
      </div>
      {verified && provider ? (
        <p className="text-muted-foreground">{t.verifiedHint(provider.domain)}</p>
      ) : pending ? (
        <>
          <p className="text-muted-foreground">{t.recordHint(pending.domain, formatDay(pending.expiresAt))}</p>
          <div className="grid grid-cols-1 items-start gap-3.5 app:grid-cols-2">
            <Field>
              <FieldLabel>{t.recordNameTXT}</FieldLabel>
              <PeopleCopyField value={pending.recordName} copyLabel={t.txtRecordName} />
            </Field>
            <Field>
              <FieldLabel>{t.value}</FieldLabel>
              <PeopleCopyField value={pending.recordValue} copyLabel={t.txtRecordValue} />
            </Field>
          </div>
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
      {!verified && (
        <div className="flex justify-end gap-2">
          {canRequest && (
            <Button
              variant={pending ? "outline" : "default"}
              onClick={() => request.mutate(undefined)}
              disabled={request.isPending}
            >
              {request.isPending ? t.requesting : t.requestRecord(provider.domain)}
            </Button>
          )}
          {pending && !pending.verified && (
            <Button variant="default" onClick={() => check.mutate()} disabled={check.isPending}>
              {check.isPending ? t.checking : t.check}
            </Button>
          )}
        </div>
      )}
    </Card>
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
        <Button variant="default" onClick={() => remove.mutate()} disabled={remove.isPending}>
          {remove.isPending ? t.removing : t.removeSSO}
        </Button>
      </DialogActions>
    </>
  );
}
