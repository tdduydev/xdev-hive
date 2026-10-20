import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConnectionTestResult, JenkinsTokenItem } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { Input } from "@xdev-hive/ui/input";
import { Pill } from "@xdev-hive/ui/pill";
import { Table, Td, Th } from "@xdev-hive/ui/table";
import { KeyRoundIcon } from "lucide-react";
import { type FormEvent, Fragment, useState } from "react";
import { Field, FieldError, FieldHint, FieldLabel } from "@/components/ui/field.tsx";
import { EmptyState, LoadFailure, TableSkeleton } from "@/components/ui/query-state.tsx";
import { apiErrorMessage, formError } from "@/lib/api-errors.ts";
import { formatDayTime } from "@/lib/format.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

const text: Dict<{
  title: string;
  lead: string;
  loading: string;
  emptyTitle: string;
  empty: string;
  colConnection: string;
  colUser: string;
  colChecked: string;
  actions: string;
  none: string;
  neverChecked: string;
  checkedOk: string;
  checkedFail: string;
  noToken: string;
  add: string;
  replace: string;
  addFor: (name: string) => string;
  replaceFor: (name: string) => string;
  test: string;
  testing: string;
  testOf: (name: string) => string;
  testOk: string;
  testFail: string;
  testUser: (user: string) => string;
  remove: string;
  removeOf: (name: string) => string;
  dlgAdd: (name: string) => string;
  dlgReplace: (name: string) => string;
  dlgLead: string;
  fUser: string;
  fUserHint: string;
  fToken: string;
  fTokenHint: string;
  fTokenKeep: string;
  cancel: string;
  save: string;
  saving: string;
  removeTitle: (name: string) => string;
  removeLead: string;
  removing: string;
}> = {
  vi: {
    title: "Token Jenkins",
    lead: "Mỗi người dùng token Jenkins của mình để chạy job và xem build. Hub mã hoá token khi lưu và không hiện lại.",
    loading: "Đang tải…",
    emptyTitle: "Tổ chức chưa có kết nối Jenkins",
    empty: "Nhờ người quản lý kết nối CI thêm Jenkins trước. Sau đó bạn thêm token của mình ở đây.",
    colConnection: "Kết nối",
    colUser: "User Jenkins",
    colChecked: "Lần kiểm cuối",
    actions: "Thao tác",
    none: "—",
    neverChecked: "Chưa kiểm",
    checkedOk: "Token dùng được",
    checkedFail: "Token bị từ chối",
    noToken: "Chưa có token",
    add: "Thêm token",
    replace: "Thay token",
    addFor: (n) => `Thêm token cho ${n}`,
    replaceFor: (n) => `Thay token cho ${n}`,
    test: "Kiểm",
    testing: "Đang kiểm…",
    testOf: (n) => `Kiểm token ${n}`,
    testOk: "Dùng được",
    testFail: "Chưa dùng được",
    testUser: (u) => `Đăng nhập là ${u}`,
    remove: "Xoá",
    removeOf: (n) => `Xoá token ${n}`,
    dlgAdd: (n) => `Thêm token Jenkins cho ${n}`,
    dlgReplace: (n) => `Thay token Jenkins cho ${n}`,
    dlgLead:
      "Tạo API token ở Jenkins: trang cá nhân, mục Security, Add new Token. Hub không đọc lại được token sau khi lưu.",
    fUser: "User Jenkins",
    fUserHint: "Tên đăng nhập của bạn trên Jenkins, không phải email Hive.",
    fToken: "API token",
    fTokenHint: "Dán token vừa tạo.",
    fTokenKeep: "Nhập token mới; token cũ bị thay ngay khi lưu.",
    cancel: "Huỷ",
    save: "Lưu token",
    saving: "Đang lưu…",
    removeTitle: (n) => `Xoá token Jenkins cho ${n}?`,
    removeLead: "Bạn sẽ không chạy được job hay xem build trên kết nối này cho đến khi thêm token mới.",
    removing: "Đang xoá…",
  },
  en: {
    title: "Jenkins tokens",
    lead: "Everyone uses their own Jenkins token to run jobs and see builds. The hub encrypts tokens at rest and never shows them again.",
    loading: "Loading…",
    emptyTitle: "The organization has no Jenkins connection",
    empty: "Ask someone who manages CI connections to add Jenkins first. Then add your token here.",
    colConnection: "Connection",
    colUser: "Jenkins user",
    colChecked: "Last check",
    actions: "Actions",
    none: "—",
    neverChecked: "Not checked",
    checkedOk: "Token works",
    checkedFail: "Token rejected",
    noToken: "No token",
    add: "Add token",
    replace: "Replace token",
    addFor: (n) => `Add token for ${n}`,
    replaceFor: (n) => `Replace token for ${n}`,
    test: "Test",
    testing: "Testing…",
    testOf: (n) => `Test token ${n}`,
    testOk: "Works",
    testFail: "Not usable yet",
    testUser: (u) => `Signed in as ${u}`,
    remove: "Remove",
    removeOf: (n) => `Remove token ${n}`,
    dlgAdd: (n) => `Add Jenkins token for ${n}`,
    dlgReplace: (n) => `Replace Jenkins token for ${n}`,
    dlgLead:
      "Create an API token in Jenkins: your profile, Security, Add new Token. The hub cannot read the token back once saved.",
    fUser: "Jenkins user",
    fUserHint: "Your Jenkins login name, not your Hive email.",
    fToken: "API token",
    fTokenHint: "Paste the token you just created.",
    fTokenKeep: "Enter a new token; the old one is replaced on save.",
    cancel: "Cancel",
    save: "Save token",
    saving: "Saving…",
    removeTitle: (n) => `Remove Jenkins token for ${n}?`,
    removeLead: "You cannot run jobs or see builds on this connection until you add a new token.",
    removing: "Removing…",
  },
};

type TestState = ConnectionTestResult | string;
type Edit = { kind: "save" | "remove"; item: JenkinsTokenItem };

/** /settings/jenkins-tokens: token Jenkins của chính tôi, một dòng mỗi kết nối (FR-001, Q3). */
export function JenkinsTokensPage() {
  const { api } = useOrg();
  const t = useT(text);
  const items = useQuery(api.ciTokens.list.queryOptions());
  const [edit, setEdit] = useState<Edit | null>(null);

  return (
    <>
      <PageHeader title={t.title} description={t.lead} />
      <PageBody>
        {items.isPending ? (
          <TableSkeleton label={t.loading} rows={3} columns={4} />
        ) : items.isError ? (
          <LoadFailure error={items.error} retry={items.refetch} />
        ) : items.data.length === 0 ? (
          <EmptyState icon={KeyRoundIcon} title={t.emptyTitle} description={t.empty} />
        ) : (
          <TokenTable items={items.data} onEdit={setEdit} />
        )}
      </PageBody>
      <Dialog open={edit?.kind === "save"} onOpenChange={(open) => !open && setEdit(null)}>
        <DialogContent>
          {edit?.kind === "save" && <TokenForm item={edit.item} onDone={() => setEdit(null)} />}
        </DialogContent>
      </Dialog>
      <Dialog open={edit?.kind === "remove"} onOpenChange={(open) => !open && setEdit(null)}>
        <DialogContent>
          {edit?.kind === "remove" && <RemoveToken item={edit.item} onDone={() => setEdit(null)} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

function TokenTable({ items, onEdit }: { items: JenkinsTokenItem[]; onEdit: (edit: Edit) => void }) {
  const t = useT(text);
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const [results, setResults] = useState<Record<string, TestState>>({});
  const test = useMutation({
    mutationFn: (connectionId: string) => api.ciTokens.test.call({ connectionId }),
    onSuccess: async (result, id) => {
      setResults((r) => ({ ...r, [id]: result }));
      // Hub ghi lại kết quả lần kiểm; đọc lại để cột "Lần kiểm cuối" khớp.
      await queryClient.invalidateQueries({ queryKey: api.ciTokens.key() });
    },
    onError: (error, id) => setResults((r) => ({ ...r, [id]: apiErrorMessage(error) })),
  });
  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
      <Table className="[&_td]:align-top" style={{ minWidth: 640 }}>
        <caption className="sr-only">{t.title}</caption>
        <thead>
          <tr>
            <Th variant="plain">{t.colConnection}</Th>
            <Th variant="plain">{t.colUser}</Th>
            <Th variant="plain">{t.colChecked}</Th>
            <Th variant="plain" className="text-right">
              {t.actions}
            </Th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const result = results[item.connectionId];
            const token = item.token;
            return (
              <Fragment key={item.connectionId}>
                <tr className={result !== undefined ? "[&>td]:border-b-0" : undefined}>
                  <Td>
                    <span className="grid gap-0.5">
                      <span className="font-medium text-foreground">{item.connectionName}</span>
                      <span className="font-mono text-xs break-all text-muted-foreground">{item.url}</span>
                    </span>
                  </Td>
                  <Td>{token ? <span className="font-mono text-xs">{token.jenkinsUser}</span> : t.none}</Td>
                  <Td>
                    {token ? (
                      <span className="grid justify-items-start gap-1">
                        {token.lastCheckOk === null ? (
                          <span className="text-muted-foreground">{t.neverChecked}</span>
                        ) : (
                          <Pill tone={token.lastCheckOk ? "ok" : "bad"} small>
                            {token.lastCheckOk ? t.checkedOk : t.checkedFail}
                          </Pill>
                        )}
                        {token.lastCheckedAt && (
                          <span className="text-xs text-muted-foreground tabular-nums">
                            {formatDayTime(token.lastCheckedAt)}
                          </span>
                        )}
                      </span>
                    ) : (
                      <Pill tone="warn" small>
                        {t.noToken}
                      </Pill>
                    )}
                  </Td>
                  <Td className="py-1.5 text-right whitespace-nowrap">
                    <span className="inline-flex items-center gap-1">
                      {token && (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={t.testOf(item.connectionName)}
                          disabled={test.isPending}
                          onClick={() => test.mutate(item.connectionId)}
                        >
                          {test.isPending && test.variables === item.connectionId ? t.testing : t.test}
                        </Button>
                      )}
                      <Button
                        variant={token ? "ghost" : "outline"}
                        size="sm"
                        aria-label={token ? t.replaceFor(item.connectionName) : t.addFor(item.connectionName)}
                        onClick={() => onEdit({ kind: "save", item })}
                      >
                        {token ? t.replace : t.add}
                      </Button>
                      {token && (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={t.removeOf(item.connectionName)}
                          onClick={() => onEdit({ kind: "remove", item })}
                        >
                          {t.remove}
                        </Button>
                      )}
                    </span>
                  </Td>
                </tr>
                {result !== undefined && (
                  <tr className="bg-muted/30">
                    <Td colSpan={4} className="pt-0 whitespace-normal">
                      <TestResult name={item.connectionName} result={result} />
                    </Td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </Table>
    </div>
  );
}

function TestResult({ name, result }: { name: string; result: TestState }) {
  const t = useT(text);
  if (typeof result === "string")
    return (
      <p role="alert" className="pt-2 text-xs text-destructive">
        {t.testOf(name)}: {result}
      </p>
    );
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-2 text-xs text-muted-foreground">
      <span className="sr-only">{t.testOf(name)}:</span>
      <Pill tone={result.ok ? "ok" : "bad"} small>
        {result.ok ? t.testOk : t.testFail}
      </Pill>
      {result.message && <span>{result.message}</span>}
      {result.user && <span>{t.testUser(result.user)}</span>}
    </div>
  );
}

function TokenForm({ item, onDone }: { item: JenkinsTokenItem; onDone: () => void }) {
  const t = useT(text);
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const [errors, setErrors] = useState<{ jenkinsUser?: string; token?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const replacing = item.token !== null;

  const save = useMutation({
    mutationFn: (input: { jenkinsUser: string; token: string }) =>
      api.ciTokens.upsert.call({ connectionId: item.connectionId, ...input }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: api.ciTokens.key() });
      // Token mới có thể làm người theo dõi của kết nối đọc lại được; danh sách kết nối phải đọc lại.
      await queryClient.invalidateQueries({ queryKey: api.ciConnections.key() });
      onDone();
    },
    onError: (error) => {
      const { field, message } = formError(error);
      if (field === "jenkinsUser" || field === "token") setErrors({ [field]: message });
      else setFailure(message);
    },
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const jenkinsUser = String(form.get("jenkinsUser") ?? "").trim();
    const token = String(form.get("token") ?? "").trim();
    setFailure(null);
    const next: typeof errors = {};
    if (!jenkinsUser) next.jenkinsUser = "Nhập user Jenkins.";
    if (token.length < 8) next.token = "Token quá ngắn.";
    setErrors(next);
    if (Object.keys(next).length === 0) save.mutate({ jenkinsUser, token });
  }

  const busy = save.isPending;
  return (
    <form noValidate onSubmit={onSubmit} className="grid gap-3.5">
      <DialogTitle>{replacing ? t.dlgReplace(item.connectionName) : t.dlgAdd(item.connectionName)}</DialogTitle>
      <DialogDescription>{t.dlgLead}</DialogDescription>
      <Field invalid={errors.jenkinsUser !== undefined}>
        <FieldLabel>{t.fUser}</FieldLabel>
        <Input
          name="jenkinsUser"
          defaultValue={item.token?.jenkinsUser}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          autoFocus
        />
        {errors.jenkinsUser ? <FieldError>{errors.jenkinsUser}</FieldError> : <FieldHint>{t.fUserHint}</FieldHint>}
      </Field>
      <Field invalid={errors.token !== undefined}>
        <FieldLabel>{t.fToken}</FieldLabel>
        {/* Không bao giờ điền sẵn: hub không trả giá trị token. */}
        <Input name="token" type="password" disabled={busy} autoComplete="new-password" spellCheck={false} />
        {errors.token ? (
          <FieldError>{errors.token}</FieldError>
        ) : (
          <FieldHint>{replacing ? t.fTokenKeep : t.fTokenHint}</FieldHint>
        )}
      </Field>
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

function RemoveToken({ item, onDone }: { item: JenkinsTokenItem; onDone: () => void }) {
  const t = useT(text);
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.ciTokens.remove.call({ connectionId: item.connectionId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: api.ciTokens.key() });
      await queryClient.invalidateQueries({ queryKey: api.ciConnections.key() });
      onDone();
    },
  });
  return (
    <>
      <DialogTitle>{t.removeTitle(item.connectionName)}</DialogTitle>
      <DialogDescription>{t.removeLead}</DialogDescription>
      {remove.isError && <Alert variant="destructive">{apiErrorMessage(remove.error)}</Alert>}
      <DialogActions>
        <Button variant="outline" onClick={onDone}>
          {t.cancel}
        </Button>
        <Button variant="destructive-solid" disabled={remove.isPending} onClick={() => remove.mutate()}>
          {remove.isPending ? t.removing : t.remove}
        </Button>
      </DialogActions>
    </>
  );
}
