import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ScmConnection,
  type ScmConnectionCreateInput,
  type ScmConnectionTestResult,
  scmConnectionCreateInput,
} from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { Input } from "@xdev-hive/ui/input";
import { Pill } from "@xdev-hive/ui/pill";
import { Table, Td, Th } from "@xdev-hive/ui/table";
import { Textarea } from "@xdev-hive/ui/textarea";
import { type FormEvent, useState } from "react";
import { Icon } from "@/components/icons.tsx";
import { Card } from "@/components/ui/card.tsx";
import { Field, FieldError, FieldHint, FieldLabel } from "@/components/ui/field.tsx";
import { apiErrorMessage, formError } from "@/lib/api-errors.ts";
import { formatDay } from "@/lib/format.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { SCM_LABEL } from "@/lib/projects.ts";
import { isOrgAdmin } from "@/lib/roles.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

const text: Dict<{
  crumb: string;
  title: string;
  lead: string;
  add: string;
  loading: string;
  emptyTitle: string;
  emptyAdmin: string;
  emptyMember: string;
  adminOnly: string;
  colName: string;
  colKind: string;
  colAuth: string;
  colOwner: string;
  colCreated: string;
  actions: string;
  authApp: string;
  authToken: string;
  test: string;
  testing: string;
  remove: string;
  testOk: string;
  testFail: string;
  missing: (scopes: string) => string;
  unverified: (scopes: string) => string;
  dlgTitle: string;
  dlgLead: string;
  fKind: string;
  fAuth: string;
  authAppLong: string;
  authTokenLong: string;
  fName: string;
  fNamePh: string;
  fBaseUrl: string;
  fBaseUrlGhHint: string;
  fBaseUrlGlHint: string;
  fOwnerGh: string;
  fOwnerGl: string;
  fOwnerHint: string;
  fToken: string;
  fTokenGhHint: string;
  fTokenGlHint: string;
  fAppId: string;
  fInstallation: string;
  fInstallationHint: string;
  fKey: string;
  fKeyHint: string;
  cancel: string;
  save: string;
  saving: string;
  removeTitle: (name: string) => string;
  removeLead: string;
  removing: string;
  invalid: string;
}> = {
  vi: {
    crumb: "Dự án và hạ tầng",
    title: "Kết nối Git",
    lead: "Hub dùng kết nối GitHub hoặc GitLab để tạo repo, mở PR, đặt webhook và cấp quyền clone cho agent.",
    add: "Thêm kết nối",
    loading: "Đang tải…",
    emptyTitle: "Chưa có kết nối Git",
    emptyAdmin:
      "Thêm một kết nối GitHub (GitHub App hoặc token) hoặc GitLab (token có scope api). Sau đó tạo dự án từ repo có sẵn hoặc repo mới.",
    emptyMember: "Nhờ quản trị tổ chức thêm kết nối GitHub hoặc GitLab để tạo dự án.",
    adminOnly: "Chỉ quản trị tổ chức thêm, kiểm tra và xoá được kết nối.",
    colName: "Tên",
    colKind: "Loại",
    colAuth: "Xác thực",
    colOwner: "Owner mặc định",
    colCreated: "Ngày thêm",
    actions: "Thao tác",
    authApp: "GitHub App",
    authToken: "Token",
    test: "Kiểm tra",
    testing: "Đang kiểm tra…",
    remove: "Xoá",
    testOk: "Kết nối dùng được",
    testFail: "Kết nối chưa dùng được",
    missing: (s) => `Thiếu quyền: ${s}.`,
    unverified: (s) => `Chưa kiểm được trước: ${s}.`,
    dlgTitle: "Thêm kết nối Git",
    dlgLead: "Token và khoá riêng được hub mã hoá khi lưu; web không đọc lại được.",
    fKind: "Nền tảng",
    fAuth: "Cách xác thực",
    authAppLong: "GitHub App (nên dùng cho tổ chức)",
    authTokenLong: "Personal access token",
    fName: "Tên kết nối",
    fNamePh: "Ví dụ: GitHub công ty",
    fBaseUrl: "Địa chỉ API (không bắt buộc)",
    fBaseUrlGhHint: "Bỏ trống với github.com. GitHub Enterprise: https://ghe.example.com/api/v3",
    fBaseUrlGlHint: "Bỏ trống với gitlab.com. GitLab tự cài: https://gitlab.example.com",
    fOwnerGh: "Tổ chức GitHub",
    fOwnerGl: "Group GitLab (không bắt buộc)",
    fOwnerHint: "Repo mới tạo ở đây nếu không chọn chỗ khác.",
    fToken: "Token",
    fTokenGhHint:
      "Fine-grained token cần Administration, Contents, Pull requests, Webhooks (Read and write); token cổ điển cần scope repo.",
    fTokenGlHint: "Personal, group hoặc project access token có scope api.",
    fAppId: "App ID",
    fInstallation: "Installation ID",
    fInstallationHint: "Số cuối đường dẫn trang cài app trên tổ chức GitHub.",
    fKey: "Khoá riêng (PEM)",
    fKeyHint: "Dán nguyên nội dung file .pem tải từ trang cài đặt GitHub App.",
    cancel: "Huỷ",
    save: "Thêm kết nối",
    saving: "Đang lưu…",
    removeTitle: (n) => `Xoá kết nối ${n}?`,
    removeLead: "Chỉ xoá được kết nối chưa dự án nào dùng. Hub xoá luôn token đã lưu.",
    removing: "Đang xoá…",
    invalid: "Dữ liệu chưa hợp lệ.",
  },
  en: {
    crumb: "Projects & infra",
    title: "Git connections",
    lead: "The hub uses a GitHub or GitLab connection to create repos, open PRs, set webhooks and grant agents clone access.",
    add: "Add connection",
    loading: "Loading…",
    emptyTitle: "No Git connections yet",
    emptyAdmin:
      "Add a GitHub connection (GitHub App or token) or a GitLab one (token with api scope). Then create a project from an existing or new repo.",
    emptyMember: "Ask an organization admin to add a GitHub or GitLab connection so projects can be created.",
    adminOnly: "Only organization admins can add, test and remove connections.",
    colName: "Name",
    colKind: "Platform",
    colAuth: "Auth",
    colOwner: "Default owner",
    colCreated: "Added",
    actions: "Actions",
    authApp: "GitHub App",
    authToken: "Token",
    test: "Test",
    testing: "Testing…",
    remove: "Remove",
    testOk: "Connection works",
    testFail: "Connection is not usable yet",
    missing: (s) => `Missing permissions: ${s}.`,
    unverified: (s) => `Not verifiable in advance: ${s}.`,
    dlgTitle: "Add Git connection",
    dlgLead: "The hub encrypts tokens and private keys at rest; the web cannot read them back.",
    fKind: "Platform",
    fAuth: "Authentication",
    authAppLong: "GitHub App (recommended for organizations)",
    authTokenLong: "Personal access token",
    fName: "Connection name",
    fNamePh: "e.g. Company GitHub",
    fBaseUrl: "API address (optional)",
    fBaseUrlGhHint: "Leave empty for github.com. GitHub Enterprise: https://ghe.example.com/api/v3",
    fBaseUrlGlHint: "Leave empty for gitlab.com. Self-hosted: https://gitlab.example.com",
    fOwnerGh: "GitHub organization",
    fOwnerGl: "GitLab group (optional)",
    fOwnerHint: "New repos go here unless another owner is chosen.",
    fToken: "Token",
    fTokenGhHint:
      "Fine-grained tokens need Administration, Contents, Pull requests, Webhooks (Read and write); classic tokens need the repo scope.",
    fTokenGlHint: "Personal, group or project access token with the api scope.",
    fAppId: "App ID",
    fInstallation: "Installation ID",
    fInstallationHint: "The number at the end of the app installation page URL on your GitHub organization.",
    fKey: "Private key (PEM)",
    fKeyHint: "Paste the whole .pem file downloaded from the GitHub App settings page.",
    cancel: "Cancel",
    save: "Add connection",
    saving: "Saving…",
    removeTitle: (n) => `Remove connection ${n}?`,
    removeLead: "Only connections no project uses can be removed. The hub deletes the stored token too.",
    removing: "Removing…",
    invalid: "Some fields are not valid.",
  },
};

/** /admin/git: kết nối GitHub/GitLab của tổ chức. Ai trong tổ chức cũng xem được; chỉ quản trị tổ chức sửa. */
export function GitConnectionsPage() {
  const { org, api } = useOrg();
  const t = useT(text);
  const admin = isOrgAdmin(org.role);
  const connections = useQuery(api.scmConnections.list.queryOptions());
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ScmConnection | null>(null);

  return (
    <>
      <PageHeader crumb={t.crumb} title={t.title}>
        {admin && connections.data && connections.data.length > 0 && (
          <Button variant="default" onClick={() => setAdding(true)}>
            <Icon name="plus" />
            {t.add}
          </Button>
        )}
      </PageHeader>
      <PageBody>
        <p className="-mt-2 text-sm text-muted-foreground">{t.lead}</p>
        {connections.isPending ? (
          <p aria-busy="true" className="text-muted-foreground">
            {t.loading}
          </p>
        ) : connections.isError ? (
          <Alert variant="destructive">{apiErrorMessage(connections.error)}</Alert>
        ) : connections.data.length === 0 ? (
          <Card className="grid justify-items-center gap-2 px-6 py-10 text-center">
            <span className="mb-1 grid size-10 place-items-center rounded-lg bg-accent text-accent-foreground">
              <Icon name="github" className="size-5" />
            </span>
            <h2 className="text-base font-semibold text-foreground">{t.emptyTitle}</h2>
            <p className="max-w-md text-muted-foreground">{admin ? t.emptyAdmin : t.emptyMember}</p>
            {admin && (
              <Button variant="default" className="mt-2" onClick={() => setAdding(true)}>
                <Icon name="plus" />
                {t.add}
              </Button>
            )}
          </Card>
        ) : (
          <>
            {!admin && <p className="text-sm text-muted-foreground">{t.adminOnly}</p>}
            <ConnectionTable connections={connections.data} admin={admin} onRemove={setRemoving} />
          </>
        )}
      </PageBody>
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] w-140 overflow-y-auto">
          {adding && <AddConnectionForm onDone={() => setAdding(false)} />}
        </DialogContent>
      </Dialog>
      <Dialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <DialogContent>
          {removing && <RemoveConnection connection={removing} onDone={() => setRemoving(null)} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

function ConnectionTable({
  connections,
  admin,
  onRemove,
}: {
  connections: ScmConnection[];
  admin: boolean;
  onRemove: (c: ScmConnection) => void;
}) {
  const t = useT(text);
  const { api } = useOrg();
  const [results, setResults] = useState<Record<string, ScmConnectionTestResult | string>>({});
  const test = useMutation({
    mutationFn: (id: string) => api.scmConnections.test.call({ id }),
    onSuccess: (result, id) => setResults((r) => ({ ...r, [id]: result })),
    onError: (error, id) => setResults((r) => ({ ...r, [id]: apiErrorMessage(error) })),
  });
  return (
    <Card className="overflow-hidden">
      <Table className="min-w-180">
        <caption className="sr-only">{t.title}</caption>
        <thead>
          <tr>
            <Th>{t.colName}</Th>
            <Th>{t.colKind}</Th>
            <Th>{t.colAuth}</Th>
            <Th>{t.colOwner}</Th>
            <Th>{t.colCreated}</Th>
            {admin && <Th>{t.actions}</Th>}
          </tr>
        </thead>
        <tbody>
          {connections.map((c) => {
            const result = results[c.id];
            return (
              <tr key={c.id}>
                <Td>
                  <span className="grid gap-1">
                    <b className="font-medium text-foreground">{c.name}</b>
                    {c.baseUrl && <span className="font-mono text-xs text-muted-foreground">{c.baseUrl}</span>}
                    {result !== undefined && <TestResult result={result} />}
                  </span>
                </Td>
                <Td className="whitespace-nowrap">
                  <span className="inline-flex items-center gap-2">
                    <Icon name={c.kind} className="size-4 text-muted-foreground" />
                    {SCM_LABEL[c.kind]}
                  </span>
                </Td>
                <Td className="whitespace-nowrap">{c.authMode === "app" ? t.authApp : t.authToken}</Td>
                <Td className="font-mono text-xs">{c.defaultOwner ?? "—"}</Td>
                <Td className="whitespace-nowrap">{formatDay(c.createdAt)}</Td>
                {admin && (
                  <Td className="whitespace-nowrap">
                    <span className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`${t.test} ${c.name}`}
                        disabled={test.isPending}
                        onClick={() => test.mutate(c.id)}
                      >
                        {test.isPending && test.variables === c.id ? t.testing : t.test}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`${t.remove} ${c.name}`}
                        onClick={() => onRemove(c)}
                      >
                        {t.remove}
                      </Button>
                    </span>
                  </Td>
                )}
              </tr>
            );
          })}
        </tbody>
      </Table>
    </Card>
  );
}

function TestResult({ result }: { result: ScmConnectionTestResult | string }) {
  const t = useT(text);
  if (typeof result === "string") return <span className="text-xs text-destructive">{result}</span>;
  return (
    <span role="status" className="grid justify-items-start gap-1 text-xs text-muted-foreground">
      <Pill tone={result.ok ? "ok" : "warn"} small>
        {result.ok ? t.testOk : t.testFail}
      </Pill>
      {result.message && <span>{result.message}</span>}
      {result.missingScopes.length > 0 && <span>{t.missing(result.missingScopes.join(", "))}</span>}
      {result.unverifiedScopes.length > 0 && <span>{t.unverified(result.unverifiedScopes.join(", "))}</span>}
    </span>
  );
}

interface InputExtra {
  placeholder?: string;
  autoFocus?: boolean;
  spellCheck?: boolean;
  inputMode?: "numeric";
  type?: "password";
  className?: string;
}

type FieldName = "name" | "baseUrl" | "defaultOwner" | "token" | "appId" | "installationId" | "privateKey";

function AddConnectionForm({ onDone }: { onDone: () => void }) {
  const t = useT(text);
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<"github" | "gitlab">("github");
  const [authMode, setAuthMode] = useState<"token" | "app">("token");
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const app = kind === "github" && authMode === "app";

  const create = useMutation({
    mutationFn: (input: ScmConnectionCreateInput) => api.scmConnections.create.call(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: api.scmConnections.key() });
      onDone();
    },
    onError: (error) => {
      const { field, message } = formError(error, { SCM_CONNECTION_NAME_TAKEN: "name" });
      if (field) setErrors({ [field]: message });
      else setFailure(message);
    },
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const read = (k: string) => String(form.get(k) ?? "").trim();
    const optional = (k: string) => read(k) || undefined;
    const common = { kind, name: read("name"), baseUrl: optional("baseUrl"), defaultOwner: optional("defaultOwner") };
    const input =
      kind === "gitlab"
        ? { ...common, token: read("token") }
        : app
          ? {
              ...common,
              authMode,
              appId: read("appId"),
              installationId: Number(read("installationId")) || 0,
              // PEM cần giữ nguyên xuống dòng; chỉ bỏ khoảng trắng hai đầu.
              privateKey: String(form.get("privateKey") ?? "").trim(),
            }
          : { ...common, authMode, token: read("token") };
    setFailure(null);
    const parsed = scmConnectionCreateInput.safeParse(input);
    if (!parsed.success) {
      const byField: Partial<Record<FieldName, string>> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "") as FieldName;
        byField[key] ??= issue.message;
      }
      setErrors(byField);
      if (Object.keys(byField).length === 0) setFailure(t.invalid);
      return;
    }
    setErrors({});
    create.mutate(parsed.data);
  }

  const busy = create.isPending;
  const radio = (name: string, value: string, checked: boolean, onChange: () => void, label: string) => (
    <label key={value} className="flex items-center gap-2 text-sm text-foreground">
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        disabled={busy}
        className="size-4 accent-accent"
      />
      {label}
    </label>
  );
  const field = (name: FieldName, label: string, hint?: string, extra?: InputExtra) => (
    <Field invalid={errors[name] !== undefined}>
      <FieldLabel>{label}</FieldLabel>
      <Input name={name} disabled={busy} autoComplete="off" spellCheck={false} {...extra} />
      {errors[name] ? <FieldError>{errors[name]}</FieldError> : hint && <FieldHint>{hint}</FieldHint>}
    </Field>
  );

  return (
    <form noValidate onSubmit={onSubmit} className="grid gap-3.5">
      <DialogTitle>{t.dlgTitle}</DialogTitle>
      <DialogDescription>{t.dlgLead}</DialogDescription>
      <fieldset className="grid gap-1.5">
        <legend className="mb-1.5 text-sm font-medium text-foreground">{t.fKind}</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-1.5">
          {radio("kind", "github", kind === "github", () => setKind("github"), "GitHub")}
          {radio("kind", "gitlab", kind === "gitlab", () => setKind("gitlab"), "GitLab")}
        </div>
      </fieldset>
      {kind === "github" && (
        <fieldset className="grid gap-1.5">
          <legend className="mb-1.5 text-sm font-medium text-foreground">{t.fAuth}</legend>
          <div className="grid gap-1.5">
            {radio("authMode", "token", authMode === "token", () => setAuthMode("token"), t.authTokenLong)}
            {radio("authMode", "app", authMode === "app", () => setAuthMode("app"), t.authAppLong)}
          </div>
        </fieldset>
      )}
      {field("name", t.fName, undefined, { placeholder: t.fNamePh, autoFocus: true, spellCheck: true })}
      {field("defaultOwner", kind === "github" ? t.fOwnerGh : t.fOwnerGl, t.fOwnerHint)}
      {app ? (
        <>
          <div className="grid gap-3.5 app:grid-cols-2">
            {field("appId", t.fAppId, undefined, { inputMode: "numeric" })}
            {field("installationId", t.fInstallation, t.fInstallationHint, { inputMode: "numeric" })}
          </div>
          <Field invalid={errors.privateKey !== undefined}>
            <FieldLabel>{t.fKey}</FieldLabel>
            <Textarea
              name="privateKey"
              rows={5}
              disabled={busy}
              spellCheck={false}
              className="font-mono text-xs"
              placeholder="-----BEGIN RSA PRIVATE KEY-----"
            />
            {errors.privateKey ? <FieldError>{errors.privateKey}</FieldError> : <FieldHint>{t.fKeyHint}</FieldHint>}
          </Field>
        </>
      ) : (
        field("token", t.fToken, kind === "github" ? t.fTokenGhHint : t.fTokenGlHint, { type: "password" })
      )}
      {field("baseUrl", t.fBaseUrl, kind === "github" ? t.fBaseUrlGhHint : t.fBaseUrlGlHint, {
        placeholder: kind === "github" ? "https://api.github.com" : "https://gitlab.com",
        className: "font-mono",
      })}
      {failure && <Alert variant="destructive">{failure}</Alert>}
      <DialogActions>
        <Button variant="outline" onClick={onDone}>
          {t.cancel}
        </Button>
        <Button type="submit" variant="default" disabled={busy}>
          {busy ? t.saving : t.save}
        </Button>
      </DialogActions>
    </form>
  );
}

function RemoveConnection({ connection, onDone }: { connection: ScmConnection; onDone: () => void }) {
  const t = useT(text);
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.scmConnections.remove.call({ id: connection.id }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: api.scmConnections.key() });
      onDone();
    },
  });
  return (
    <>
      <DialogTitle>{t.removeTitle(connection.name)}</DialogTitle>
      <DialogDescription>{t.removeLead}</DialogDescription>
      {remove.isError && <Alert variant="destructive">{apiErrorMessage(remove.error)}</Alert>}
      <DialogActions>
        <Button variant="outline" onClick={onDone}>
          {t.cancel}
        </Button>
        <Button variant="default" disabled={remove.isPending} onClick={() => remove.mutate()}>
          {remove.isPending ? t.removing : t.remove}
        </Button>
      </DialogActions>
    </>
  );
}
