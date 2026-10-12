import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SsoJoin, SsoSettings } from "@xdev-hive/contracts";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { CopyField } from "../components/copy-field.tsx";
import { Icon, type IconName } from "../components/icons.tsx";
import { Alert } from "../components/ui/alert.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "../components/ui/dialog.tsx";
import { Field, FieldError, FieldHint, FieldLabel } from "../components/ui/field.tsx";
import { Input } from "../components/ui/input.tsx";
import { Pill } from "../components/ui/pill.tsx";
import { Select } from "../components/ui/select.tsx";
import { apiErrorCode, apiErrorMessage, formError } from "../lib/api-errors.ts";
import { formatDay } from "../lib/format.ts";
import { isOrgAdmin } from "../lib/roles.ts";
import {
  checkSsoForm,
  issuerHost,
  SSO_JOIN_LABEL,
  SSO_JOINS,
  type SsoFormErrors,
  type SsoFormValues,
} from "../lib/sso.ts";
import { useOrg } from "../shell/org-context.ts";
import { PageBody, PageHeader } from "../shell/page-header.tsx";

// Lỗi nghiệp vụ của hub (apps/hub, identity/sso.ts) thuộc ô nào trong form.
const SSO_ERROR_FIELDS: Record<string, keyof SsoFormValues> = {
  SSO_DISCOVERY_FAILED: "issuer",
  SSO_SECRET_REQUIRED: "clientSecret",
  SSO_DOMAIN_TAKEN: "domain",
  SSO_DOMAIN_PUBLIC: "domain",
};

// Hub chỉ cho SSO tự tạo tài khoản và tự thêm người vào tổ chức khi tên miền đã xác minh (apps/hub, identity/auth.ts).
const DOMAIN_UNVERIFIED =
  "Tên miền chưa được xác minh nên SSO chưa tạo tài khoản mới và chưa tự thêm người vào tổ chức: người mới vào bằng link mời. Xác minh tên miền bằng bản ghi TXT ở phần bên dưới.";

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
  const { org, api } = useOrg();
  const admin = isOrgAdmin(org.role);
  const settings = useQuery(api.ssoProviders.get.queryOptions({ enabled: admin }));

  let body: ReactNode;
  if (!admin)
    body = (
      <Card className="px-6 py-10 text-center text-muted-foreground">
        Chỉ quản trị tổ chức xem và sửa được cài đặt đăng nhập.
      </Card>
    );
  else if (settings.isPending)
    body = (
      <p aria-busy="true" className="text-muted-foreground">
        Đang tải…
      </p>
    );
  else if (settings.isError) body = <Alert>{apiErrorMessage(settings.error)}</Alert>;
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
      <PageHeader crumb="Quản trị" title="Đăng nhập" />
      <PageBody>{body}</PageBody>
    </>
  );
}

function Method({ icon, name, detail, status }: { icon: IconName; name: string; detail: string; status: ReactNode }) {
  return (
    <li className="flex items-center gap-3 border-b border-border px-4.5 py-3.5 last:border-b-0">
      <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted">
        <Icon name={icon} className="size-5" />
      </span>
      <span className="min-w-0">
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
  const sso = settings.provider;
  const hubWide = <Pill>Cấu hình ở hub</Pill>;
  return (
    <Card>
      <ul aria-label="Các cách đăng nhập">
        <Method
          icon="key"
          name="SSO (OIDC)"
          detail={
            !sso
              ? "Chưa cấu hình. Điền form bên dưới để bật."
              : sso.domainVerified
                ? `${issuerHost(sso.issuer)} · ${sso.domain} · người mới: ${settings.join === "member" ? "tự thêm vào tổ chức" : "chờ duyệt"}`
                : `${issuerHost(sso.issuer)} · ${sso.domain} (chưa xác minh) · người mới: cần lời mời`
          }
          status={sso ? <Pill tone="ok">Đang bật</Pill> : <Pill>Chưa cấu hình</Pill>}
        />
        <Method icon="github" name="GitHub" detail="OAuth app chung của hub, quản trị hub cấu hình." status={hubWide} />
        <Method icon="gitlab" name="GitLab" detail="OAuth app chung của hub, quản trị hub cấu hình." status={hubWide} />
        <Method
          icon="mail"
          name="Email và mật khẩu"
          detail="Người mới đăng ký bằng link mời, trừ khi quản trị hub mở đăng ký tự do."
          status={<Pill tone="ok">Đang bật</Pill>}
        />
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
        <h2 className="text-base font-semibold text-foreground">SSO (OIDC)</h2>
        {configured && (
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setRemoving(true)} disabled={busy}>
            Gỡ SSO
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
            <FieldLabel>Tên miền email</FieldLabel>
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
                    {claim.isPending ? "Đang lấy bản ghi…" : `Xác minh ${taken} bằng bản ghi TXT`}
                  </Button>
                )}
                {claim.isError && <FieldError>{apiErrorMessage(claim.error)}</FieldError>}
              </>
            ) : provider && !provider.domainVerified ? (
              <FieldHint>{DOMAIN_UNVERIFIED}</FieldHint>
            ) : (
              <FieldHint>Người có email tên miền này đăng nhập bằng SSO của tổ chức.</FieldHint>
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
                <FieldHint>Đang dùng Client ID kết thúc bằng {provider.clientIdLastFour}. Nhập lại khi lưu.</FieldHint>
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
              placeholder={configured ? "Đã lưu, không hiện lại" : undefined}
              disabled={busy}
              autoComplete="new-password"
            />
            {errors.clientSecret ? (
              <FieldError>{errors.clientSecret}</FieldError>
            ) : (
              <FieldHint>
                {configured ? "Để trống nếu không đổi." : "Hub lưu mã hoá và không bao giờ hiện lại secret."}
              </FieldHint>
            )}
          </Field>
        </div>
        <Field>
          <FieldLabel>Callback URL (dán vào cấu hình app bên nhà cung cấp)</FieldLabel>
          <CopyField value={settings.callbackUrl} copyLabel="callback URL" />
        </Field>
        <div className="grid gap-1.5">
          <label htmlFor={joinId} className="text-sm font-medium text-foreground">
            Khi người mới đăng nhập SSO lần đầu
          </label>
          <Select id={joinId} name="join" defaultValue={settings.join} disabled={busy}>
            {SSO_JOINS.map((j) => (
              <option key={j} value={j}>
                {SSO_JOIN_LABEL[j]}
              </option>
            ))}
          </Select>
        </div>
        {failure && <Alert>{failure}</Alert>}
        {saved && !failure && (
          <p role="status" className="rounded-lg bg-success-soft px-3.5 py-2.5 text-sm text-success">
            Đã lưu cấu hình SSO.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="submit" variant="default" disabled={busy}>
            {busy ? "Đang lưu…" : "Lưu"}
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
    <Pill tone="ok">Đã xác minh</Pill>
  ) : pending?.verified ? (
    <Pill tone="warn">Chờ lưu cấu hình</Pill>
  ) : (
    <Pill>Chưa xác minh</Pill>
  );

  return (
    <Card className="grid gap-3.5 px-4.5 py-4">
      <div className="flex items-center gap-2.5">
        <h2 className="text-base font-semibold text-foreground">Xác minh tên miền</h2>
        <span className="ml-auto">{status}</span>
      </div>
      {verified && provider ? (
        <p className="text-muted-foreground">
          Tên miền {provider.domain} đã được xác minh là của tổ chức. Có thể xoá bản ghi TXT khỏi DNS.
        </p>
      ) : pending ? (
        <>
          <p className="text-muted-foreground">
            Thêm bản ghi TXT dưới đây vào DNS của {pending.domain}, đợi DNS cập nhật (vài phút tới vài giờ) rồi bấm Kiểm
            tra. Bản ghi dùng được tới {formatDay(pending.expiresAt)}.
          </p>
          <div className="grid grid-cols-1 items-start gap-3.5 app:grid-cols-2">
            <Field>
              <FieldLabel>Tên bản ghi (TXT)</FieldLabel>
              <CopyField value={pending.recordName} copyLabel="tên bản ghi TXT" />
            </Field>
            <Field>
              <FieldLabel>Giá trị</FieldLabel>
              <CopyField value={pending.recordValue} copyLabel="giá trị bản ghi TXT" />
            </Field>
          </div>
          {pending.verified && (
            <p role="status" className="rounded-lg bg-warning-soft px-3.5 py-2.5 text-sm text-warning">
              DNS đã khớp. Lưu cấu hình SSO với tên miền {pending.domain} để hoàn tất xác minh.
            </p>
          )}
        </>
      ) : (
        <p className="text-muted-foreground">
          Chứng minh tổ chức giữ tên miền {provider?.domain} bằng một bản ghi TXT trên DNS. Tên miền đang bị tổ chức
          chưa xác minh khác khai thì sẽ chuyển về tổ chức bạn.
        </p>
      )}
      {check.isError && <Alert>{apiErrorMessage(check.error)}</Alert>}
      {request.isError && <Alert>{apiErrorMessage(request.error)}</Alert>}
      {checked && verified && provider && (
        <p role="status" className="rounded-lg bg-success-soft px-3.5 py-2.5 text-sm text-success">
          Đã xác minh tên miền {provider.domain}.
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
              {request.isPending ? "Đang lấy…" : `Lấy bản ghi TXT cho ${provider.domain}`}
            </Button>
          )}
          {pending && !pending.verified && (
            <Button variant="default" onClick={() => check.mutate()} disabled={check.isPending}>
              {check.isPending ? "Đang kiểm tra…" : "Kiểm tra"}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

function RemoveSso({ onDone, onRemoved }: { onDone: () => void; onRemoved: (next: SsoSettings) => void }) {
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
      <DialogTitle>Gỡ SSO của tổ chức?</DialogTitle>
      <DialogDescription>
        Người đang đăng nhập bằng SSO sẽ phải dùng cách khác (GitHub, GitLab, email). Họ vẫn là thành viên của tổ chức.
        Cấu hình lại SSO thì callback URL giữ nguyên.
      </DialogDescription>
      {remove.isError && <Alert>{apiErrorMessage(remove.error)}</Alert>}
      <DialogActions>
        <Button variant="outline" onClick={onDone} disabled={remove.isPending}>
          Huỷ
        </Button>
        <Button variant="default" onClick={() => remove.mutate()} disabled={remove.isPending}>
          {remove.isPending ? "Đang gỡ…" : "Gỡ SSO"}
        </Button>
      </DialogActions>
    </>
  );
}
