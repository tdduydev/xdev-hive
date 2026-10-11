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
import { apiErrorMessage, formError } from "../lib/api-errors.ts";
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
};

/** Màn 5 của mockup: các cách đăng nhập của tổ chức và form SSO (OIDC). Chỉ quản trị tổ chức xem được. */
export function LoginSettingsPage() {
  const { org, api } = useOrg();
  const admin = isOrgAdmin(org.role);
  const settings = useQuery(api.ssoProviders.get.queryOptions({ enabled: admin }));

  let body: ReactNode;
  if (!admin)
    body = (
      <Card className="px-6 py-10 text-center text-muted">Chỉ quản trị tổ chức xem và sửa được cài đặt đăng nhập.</Card>
    );
  else if (settings.isPending)
    body = (
      <p aria-busy="true" className="text-muted">
        Đang tải…
      </p>
    );
  else if (settings.isError) body = <Alert>{apiErrorMessage(settings.error)}</Alert>;
  else
    body = (
      <>
        <Methods settings={settings.data} />
        <SsoForm settings={settings.data} defaultDomain={org.emailDomain} />
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
    <li className="flex items-center gap-3 border-b border-line px-4.5 py-3.5 last:border-b-0">
      <span className="grid size-9 shrink-0 place-items-center rounded-md bg-subtle">
        <Icon name={icon} className="size-5" />
      </span>
      <span className="min-w-0">
        <b className="block font-semibold text-ink">{name}</b>
        <small className="block text-xs text-muted">{detail}</small>
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
            sso
              ? `${issuerHost(sso.issuer)} · ${sso.domain} · người mới: ${settings.join === "member" ? "tự thêm vào tổ chức" : "chờ duyệt"}`
              : "Chưa cấu hình. Điền form bên dưới để bật."
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
  const refresh = (next: SsoSettings) => queryClient.setQueryData(api.ssoProviders.get.queryKey(), next);
  const save = useMutation({
    mutationFn: (input: SsoInput) => api.ssoProviders.upsert.call(input),
    onSuccess: (next) => {
      setSecret("");
      setSaved(true);
      refresh(next);
    },
    onError: (error) => {
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
    if (Object.values(local).some(Boolean)) return;
    const join = SSO_JOINS.find((j) => j === form.get("join")) ?? "pending";
    const { clientSecret, ...rest } = values;
    save.mutate({ ...rest, join, ...(clientSecret ? { clientSecret } : {}) });
  }

  const busy = save.isPending;
  return (
    <Card className="grid gap-3.5 px-4.5 py-4">
      <div className="flex items-center gap-2.5">
        <h2 className="text-lg font-semibold text-ink">SSO (OIDC)</h2>
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
              <FieldError>{errors.domain}</FieldError>
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
          <label htmlFor={joinId} className="text-label font-medium text-ink">
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
          <p role="status" className="rounded-lg bg-ok-bg px-3.5 py-2.5 text-label text-ok">
            Đã lưu cấu hình SSO.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="submit" variant="primary" disabled={busy}>
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
        <Button onClick={onDone} disabled={remove.isPending}>
          Huỷ
        </Button>
        <Button variant="primary" onClick={() => remove.mutate()} disabled={remove.isPending}>
          {remove.isPending ? "Đang gỡ…" : "Gỡ SSO"}
        </Button>
      </DialogActions>
    </>
  );
}
