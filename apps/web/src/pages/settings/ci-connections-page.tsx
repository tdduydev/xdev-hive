import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ConnectionTestResult,
  type InfraConnection,
  type InfraConnectionCreateInput,
  type InfraConnectionKind,
  infraConnectionCreateInput,
  type JenkinsConnection,
} from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { Input } from "@xdev-hive/ui/input";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { Table, Td, Th } from "@xdev-hive/ui/table";
import { Textarea } from "@xdev-hive/ui/textarea";
import { EllipsisIcon, PlugZapIcon, Trash2Icon } from "lucide-react";
import { type FormEvent, Fragment, type ReactNode, useId, useState } from "react";
import { Icon } from "@/components/icons.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import { Field, FieldError, FieldHint, FieldLabel } from "@/components/ui/field.tsx";
import { EmptyState, LoadFailure, TableSkeleton } from "@/components/ui/query-state.tsx";
import { apiErrorMessage, formError } from "@/lib/api-errors.ts";
import { formatDayTime } from "@/lib/format.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { usePermissions } from "@/lib/permissions.ts";
import type { OrgApi } from "@/lib/rpc.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

const text: Dict<{
  title: string;
  lead: string;
  loading: string;
  noPermission: string;
  jenkinsTitle: string;
  jenkinsLead: string;
  addJenkins: string;
  jenkinsEmptyTitle: string;
  jenkinsEmpty: string;
  infraTitle: string;
  infraLead: string;
  addInfra: string;
  infraEmptyTitle: string;
  infraEmpty: string;
  colName: string;
  colWatcher: string;
  colPoll: string;
  colKind: string;
  colCa: string;
  actions: string;
  noWatcher: string;
  watcherNoToken: string;
  neverPolled: string;
  pollError: string;
  caOwn: string;
  caPublic: string;
  kindArgo: string;
  kindKube: string;
  test: string;
  testing: string;
  testOf: (name: string) => string;
  testOk: string;
  testFail: string;
  version: (v: string) => string;
  moreFor: (name: string) => string;
  edit: string;
  changeWatcher: string;
  remove: string;
  removeConfirm: string;
  jenkinsDlgAdd: string;
  jenkinsDlgEdit: string;
  jenkinsDlgLead: string;
  infraDlgAdd: string;
  infraDlgEdit: string;
  infraDlgLead: string;
  fName: string;
  fNamePh: string;
  fUrl: string;
  fJenkinsUrlHint: string;
  fInfraUrlArgoHint: string;
  fInfraUrlKubeHint: string;
  fKind: string;
  fCa: string;
  fCaHint: string;
  fCaEditHint: string;
  fCaClear: string;
  fToken: string;
  fTokenArgoHint: string;
  fTokenKubeHint: string;
  fTokenKeepHint: string;
  watcherTitle: (name: string) => string;
  watcherLead: string;
  fWatcher: string;
  watcherPick: string;
  members: string;
  cancel: string;
  save: string;
  saving: string;
  removeTitle: (name: string) => string;
  removeJenkinsLead: string;
  removeInfraLead: string;
  removing: string;
  invalid: string;
}> = {
  vi: {
    title: "Kết nối CI",
    lead: "Jenkins, Argo CD và Kubernetes của tổ chức. Hub đọc và gọi các hệ thống này bằng token đã lưu mã hoá; web không đọc lại được token.",
    loading: "Đang tải…",
    noPermission: "Bạn xem được danh sách; chỉ người có quyền quản lý kết nối CI mới thêm, sửa, kiểm tra và xoá.",
    jenkinsTitle: "Jenkins",
    jenkinsLead:
      "Hub đọc build theo lịch bằng token của người theo dõi. Mỗi người thêm token Jenkins của mình ở mục Token Jenkins.",
    addJenkins: "Thêm Jenkins",
    jenkinsEmptyTitle: "Chưa có kết nối Jenkins",
    jenkinsEmpty: "Thêm địa chỉ Jenkins để xem build của các dự án và chạy job từ Hive.",
    infraTitle: "Argo CD và Kubernetes",
    infraLead: "Dùng cho đích triển khai kiểu Argo CD hoặc kubectl. Mỗi kết nối có một token chung của tổ chức.",
    addInfra: "Thêm Argo CD hoặc Kubernetes",
    infraEmptyTitle: "Chưa có kết nối Argo CD hay Kubernetes",
    infraEmpty: "Chỉ cần khi có đích triển khai dùng Argo CD hoặc kubectl.",
    colName: "Tên",
    colWatcher: "Người theo dõi",
    colPoll: "Lần đọc cuối",
    colKind: "Loại",
    colCa: "Chứng chỉ CA",
    actions: "Thao tác",
    noWatcher: "Chưa có",
    watcherNoToken: "Chưa có token để đọc Jenkins",
    neverPolled: "Chưa đọc lần nào",
    pollError: "Không đọc được Jenkins",
    caOwn: "CA riêng",
    caPublic: "CA công khai",
    kindArgo: "Argo CD",
    kindKube: "Kubernetes",
    test: "Kiểm",
    testing: "Đang kiểm…",
    testOf: (n) => `Kiểm ${n}`,
    testOk: "Dùng được",
    testFail: "Chưa dùng được",
    version: (v) => `Phiên bản ${v}`,
    moreFor: (n) => `Thao tác khác cho kết nối ${n}`,
    edit: "Sửa…",
    changeWatcher: "Đổi người theo dõi…",
    remove: "Xoá…",
    removeConfirm: "Xoá kết nối",
    jenkinsDlgAdd: "Thêm kết nối Jenkins",
    jenkinsDlgEdit: "Sửa kết nối Jenkins",
    jenkinsDlgLead: "Bạn sẽ là người theo dõi. Thêm token Jenkins của bạn ở mục Token Jenkins để hub đọc được build.",
    infraDlgAdd: "Thêm kết nối Argo CD hoặc Kubernetes",
    infraDlgEdit: "Sửa kết nối",
    infraDlgLead: "Token do hub mã hoá khi lưu và không hiện lại.",
    fName: "Tên kết nối",
    fNamePh: "Ví dụ: Jenkins công ty",
    fUrl: "Địa chỉ",
    fJenkinsUrlHint: "Địa chỉ https của Jenkins, ví dụ https://jenkins.example.com.",
    fInfraUrlArgoHint: "Địa chỉ https của Argo CD, ví dụ https://argocd.example.com.",
    fInfraUrlKubeHint: "Địa chỉ https của API server, ví dụ https://k8s.example.com:6443.",
    fKind: "Loại",
    fCa: "Chứng chỉ CA (PEM, không bắt buộc)",
    fCaHint: "Bỏ trống khi API server dùng chứng chỉ của CA công khai.",
    fCaEditHint: "Dán CA mới để thay. Đánh dấu bên dưới để bỏ CA riêng.",
    fCaClear: "Bỏ CA riêng",
    fToken: "Token",
    fTokenArgoHint: "Token của tài khoản Argo CD chỉ cần quyền xem và đồng bộ ứng dụng.",
    fTokenKubeHint: "Token của ServiceAccount chỉ cần quyền đã khai cho đích triển khai.",
    fTokenKeepHint: "Bỏ trống để giữ token cũ.",
    watcherTitle: (n) => `Đổi người theo dõi của ${n}`,
    watcherLead: "Hub đọc build bằng token của người này. Người đó phải đã thêm token Jenkins cho kết nối.",
    fWatcher: "Người theo dõi",
    watcherPick: "Chọn một người",
    members: "Thành viên",
    cancel: "Huỷ",
    save: "Lưu",
    saving: "Đang lưu…",
    removeTitle: (n) => `Xoá kết nối ${n}?`,
    removeJenkinsLead: "Hub xoá luôn token Jenkins mà mọi người đã lưu cho kết nối này. Không hoàn tác được.",
    removeInfraLead: "Hub xoá luôn token đã lưu. Đích triển khai đang dùng kết nối này sẽ không chạy được.",
    removing: "Đang xoá…",
    invalid: "Dữ liệu chưa hợp lệ.",
  },
  en: {
    title: "CI connections",
    lead: "The organization's Jenkins, Argo CD and Kubernetes. The hub calls these systems with tokens stored encrypted; the web cannot read a token back.",
    loading: "Loading…",
    noPermission: "You can see the list; only people allowed to manage CI connections can add, edit, test and remove.",
    jenkinsTitle: "Jenkins",
    jenkinsLead:
      "The hub reads builds on a schedule with the watcher's token. Everyone adds their own under Jenkins tokens.",
    addJenkins: "Add Jenkins",
    jenkinsEmptyTitle: "No Jenkins connection yet",
    jenkinsEmpty: "Add a Jenkins address to see project builds and run jobs from Hive.",
    infraTitle: "Argo CD and Kubernetes",
    infraLead: "Used by Argo CD or kubectl deploy targets. Each connection has one organization-wide token.",
    addInfra: "Add Argo CD or Kubernetes",
    infraEmptyTitle: "No Argo CD or Kubernetes connection yet",
    infraEmpty: "Only needed when a deploy target uses Argo CD or kubectl.",
    colName: "Name",
    colWatcher: "Watcher",
    colPoll: "Last read",
    colKind: "Type",
    colCa: "CA certificate",
    actions: "Actions",
    noWatcher: "None",
    watcherNoToken: "No token to read Jenkins",
    neverPolled: "Never read",
    pollError: "Could not read Jenkins",
    caOwn: "Own CA",
    caPublic: "Public CA",
    kindArgo: "Argo CD",
    kindKube: "Kubernetes",
    test: "Test",
    testing: "Testing…",
    testOf: (n) => `Test ${n}`,
    testOk: "Works",
    testFail: "Not usable yet",
    version: (v) => `Version ${v}`,
    moreFor: (n) => `More actions for connection ${n}`,
    edit: "Edit…",
    changeWatcher: "Change watcher…",
    remove: "Remove…",
    removeConfirm: "Remove connection",
    jenkinsDlgAdd: "Add Jenkins connection",
    jenkinsDlgEdit: "Edit Jenkins connection",
    jenkinsDlgLead: "You become the watcher. Add your Jenkins token under Jenkins tokens so the hub can read builds.",
    infraDlgAdd: "Add Argo CD or Kubernetes connection",
    infraDlgEdit: "Edit connection",
    infraDlgLead: "The hub encrypts the token at rest and never shows it again.",
    fName: "Connection name",
    fNamePh: "e.g. Company Jenkins",
    fUrl: "Address",
    fJenkinsUrlHint: "The https address of Jenkins, e.g. https://jenkins.example.com.",
    fInfraUrlArgoHint: "The https address of Argo CD, e.g. https://argocd.example.com.",
    fInfraUrlKubeHint: "The https address of the API server, e.g. https://k8s.example.com:6443.",
    fKind: "Type",
    fCa: "CA certificate (PEM, optional)",
    fCaHint: "Leave empty when the API server uses a public CA.",
    fCaEditHint: "Paste a new CA to replace it. Tick below to drop the own CA.",
    fCaClear: "Drop own CA",
    fToken: "Token",
    fTokenArgoHint: "An Argo CD account token that only needs to view and sync applications.",
    fTokenKubeHint: "A ServiceAccount token that only needs the permissions declared for the deploy target.",
    fTokenKeepHint: "Leave empty to keep the current token.",
    watcherTitle: (n) => `Change watcher of ${n}`,
    watcherLead: "The hub reads builds with this person's token. They must already have added a Jenkins token for it.",
    fWatcher: "Watcher",
    watcherPick: "Pick a person",
    members: "Members",
    cancel: "Cancel",
    save: "Save",
    saving: "Saving…",
    removeTitle: (n) => `Remove connection ${n}?`,
    removeJenkinsLead:
      "The hub also deletes every Jenkins token people stored for this connection. This cannot be undone.",
    removeInfraLead:
      "The hub also deletes the stored token. Deploy targets that use this connection will stop working.",
    removing: "Removing…",
    invalid: "Some fields are not valid.",
  },
};

type InfraConnectionUpdate = Parameters<OrgApi["infraConnections"]["update"]["call"]>[0];

type Removal = { kind: "jenkins"; item: JenkinsConnection } | { kind: "infra"; item: InfraConnection };

/** /admin/ci-connections: Jenkins, Argo CD và Kubernetes của tổ chức (FR-001, FR-006). */
export function CiConnectionsPage() {
  const { api } = useOrg();
  const t = useT(text);
  const can = usePermissions();
  const manage = can("ci.connections.manage");
  const jenkins = useQuery(api.ciConnections.list.queryOptions());
  const infra = useQuery(api.infraConnections.list.queryOptions());
  const [jenkinsForm, setJenkinsForm] = useState<JenkinsConnection | "new" | null>(null);
  const [infraForm, setInfraForm] = useState<InfraConnection | "new" | null>(null);
  const [watcherOf, setWatcherOf] = useState<JenkinsConnection | null>(null);
  const [removal, setRemoval] = useState<Removal | null>(null);

  return (
    <>
      <PageHeader title={t.title} description={t.lead} />
      <PageBody>
        {!manage && (
          <p role="note" className="rounded-lg border border-border bg-muted px-3.5 py-2.5 text-xs text-foreground">
            {t.noPermission}
          </p>
        )}
        <Section
          title={t.jenkinsTitle}
          lead={t.jenkinsLead}
          action={
            manage &&
            jenkins.data &&
            jenkins.data.length > 0 && (
              <Button variant="default" size="sm" onClick={() => setJenkinsForm("new")}>
                <Icon name="plus" />
                {t.addJenkins}
              </Button>
            )
          }
        >
          {jenkins.isPending ? (
            <TableSkeleton label={t.loading} rows={2} columns={4} />
          ) : jenkins.isError ? (
            <LoadFailure error={jenkins.error} retry={jenkins.refetch} />
          ) : jenkins.data.length === 0 ? (
            <EmptyState
              compact
              icon={PlugZapIcon}
              title={t.jenkinsEmptyTitle}
              description={t.jenkinsEmpty}
              action={
                manage && (
                  <Button variant="default" onClick={() => setJenkinsForm("new")}>
                    <Icon name="plus" />
                    {t.addJenkins}
                  </Button>
                )
              }
            />
          ) : (
            <JenkinsTable
              items={jenkins.data}
              manage={manage}
              onEdit={setJenkinsForm}
              onWatcher={setWatcherOf}
              onRemove={(item) => setRemoval({ kind: "jenkins", item })}
            />
          )}
        </Section>
        <Section
          title={t.infraTitle}
          lead={t.infraLead}
          action={
            manage &&
            infra.data &&
            infra.data.length > 0 && (
              <Button variant="default" size="sm" onClick={() => setInfraForm("new")}>
                <Icon name="plus" />
                {t.addInfra}
              </Button>
            )
          }
        >
          {infra.isPending ? (
            <TableSkeleton label={t.loading} rows={2} columns={4} />
          ) : infra.isError ? (
            <LoadFailure error={infra.error} retry={infra.refetch} />
          ) : infra.data.length === 0 ? (
            <EmptyState
              compact
              icon={PlugZapIcon}
              title={t.infraEmptyTitle}
              description={t.infraEmpty}
              action={
                manage && (
                  <Button variant="outline" onClick={() => setInfraForm("new")}>
                    <Icon name="plus" />
                    {t.addInfra}
                  </Button>
                )
              }
            />
          ) : (
            <InfraTable
              items={infra.data}
              manage={manage}
              onEdit={setInfraForm}
              onRemove={(item) => setRemoval({ kind: "infra", item })}
            />
          )}
        </Section>
      </PageBody>
      <Dialog open={jenkinsForm !== null} onOpenChange={(open) => !open && setJenkinsForm(null)}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain">
          {jenkinsForm && (
            <JenkinsForm connection={jenkinsForm === "new" ? null : jenkinsForm} onDone={() => setJenkinsForm(null)} />
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={infraForm !== null} onOpenChange={(open) => !open && setInfraForm(null)}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain">
          {infraForm && (
            <InfraForm connection={infraForm === "new" ? null : infraForm} onDone={() => setInfraForm(null)} />
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={watcherOf !== null} onOpenChange={(open) => !open && setWatcherOf(null)}>
        <DialogContent>
          {watcherOf && <WatcherForm connection={watcherOf} onDone={() => setWatcherOf(null)} />}
        </DialogContent>
      </Dialog>
      <Dialog open={removal !== null} onOpenChange={(open) => !open && setRemoval(null)}>
        <DialogContent>
          {removal && <RemoveConnection removal={removal} onDone={() => setRemoval(null)} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

function Section({
  title,
  lead,
  action,
  children,
}: {
  title: string;
  lead: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <div className="grid min-w-0 flex-1 basis-72 gap-0.5">
          <h2 className="font-heading text-base font-semibold text-foreground">{title}</h2>
          <p className="max-w-3xl text-sm text-pretty text-muted-foreground">{lead}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

type TestState = ConnectionTestResult | string;

/** Kết quả nút Kiểm theo từng dòng; lỗi gọi hub hiện bằng câu tiếng Việt thay vì làm mất dòng. */
function useConnectionTest(call: (id: string) => Promise<ConnectionTestResult>) {
  const [results, setResults] = useState<Record<string, TestState>>({});
  const test = useMutation({
    mutationFn: call,
    onSuccess: (result, id) => setResults((r) => ({ ...r, [id]: result })),
    onError: (error, id) => setResults((r) => ({ ...r, [id]: apiErrorMessage(error) })),
  });
  return { results, test };
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
      {result.version && <span>{t.version(result.version)}</span>}
    </div>
  );
}

function RowActions({
  name,
  testing,
  busy,
  onTest,
  children,
}: {
  name: string;
  testing: boolean;
  busy: boolean;
  onTest: () => void;
  children: ReactNode;
}) {
  const t = useT(text);
  return (
    <span className="inline-flex items-center gap-1">
      <Button variant="ghost" size="sm" aria-label={t.testOf(name)} disabled={busy} onClick={onTest}>
        {testing ? t.testing : t.test}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t.moreFor(name)} />}>
          <EllipsisIcon aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

function JenkinsTable({
  items,
  manage,
  onEdit,
  onWatcher,
  onRemove,
}: {
  items: JenkinsConnection[];
  manage: boolean;
  onEdit: (c: JenkinsConnection) => void;
  onWatcher: (c: JenkinsConnection) => void;
  onRemove: (c: JenkinsConnection) => void;
}) {
  const t = useT(text);
  const { api } = useOrg();
  const { results, test } = useConnectionTest((id) => api.ciConnections.test.call({ id }));
  const columns = manage ? 4 : 3;
  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
      <Table className="[&_td]:align-top" style={{ minWidth: 640 }}>
        <caption className="sr-only">{t.jenkinsTitle}</caption>
        <thead>
          <tr>
            <Th variant="plain">{t.colName}</Th>
            <Th variant="plain">{t.colWatcher}</Th>
            <Th variant="plain">{t.colPoll}</Th>
            {manage && (
              <Th variant="plain" className="text-right">
                {t.actions}
              </Th>
            )}
          </tr>
        </thead>
        <tbody>
          {items.map((c) => {
            const result = results[c.id];
            return (
              <Fragment key={c.id}>
                <tr className={result !== undefined ? "[&>td]:border-b-0" : undefined}>
                  <Td>
                    <span className="grid gap-0.5">
                      <span className="font-medium text-foreground">{c.name}</span>
                      <span className="font-mono text-xs break-all text-muted-foreground">{c.url}</span>
                    </span>
                  </Td>
                  <Td>
                    <span className="grid justify-items-start gap-1">
                      <span>{c.watcher?.name ?? t.noWatcher}</span>
                      {/* Không có token thì hub không đọc được build; nói ngay ở đây thay vì để người dùng đoán. */}
                      {!c.watcherHasToken && (
                        <Pill tone="warn" small>
                          {t.watcherNoToken}
                        </Pill>
                      )}
                    </span>
                  </Td>
                  <Td>
                    <span className="grid justify-items-start gap-1">
                      <span className="tabular-nums">{c.lastPollAt ? formatDayTime(c.lastPollAt) : t.neverPolled}</span>
                      {c.lastError && (
                        <span className="grid gap-0.5">
                          <Pill tone="bad" small>
                            {t.pollError}
                          </Pill>
                          <span className="max-w-72 text-xs text-muted-foreground">{c.lastError}</span>
                        </span>
                      )}
                    </span>
                  </Td>
                  {manage && (
                    <Td className="py-1.5 text-right whitespace-nowrap">
                      <RowActions
                        name={c.name}
                        busy={test.isPending}
                        testing={test.isPending && test.variables === c.id}
                        onTest={() => test.mutate(c.id)}
                      >
                        <DropdownMenuItem onClick={() => onEdit(c)}>{t.edit}</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onWatcher(c)}>{t.changeWatcher}</DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onClick={() => onRemove(c)}>
                          <Trash2Icon aria-hidden="true" />
                          {t.remove}
                        </DropdownMenuItem>
                      </RowActions>
                    </Td>
                  )}
                </tr>
                {result !== undefined && (
                  <tr className="bg-muted/30">
                    <Td colSpan={columns} className="pt-0 whitespace-normal">
                      <TestResult name={c.name} result={result} />
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

function InfraTable({
  items,
  manage,
  onEdit,
  onRemove,
}: {
  items: InfraConnection[];
  manage: boolean;
  onEdit: (c: InfraConnection) => void;
  onRemove: (c: InfraConnection) => void;
}) {
  const t = useT(text);
  const { api } = useOrg();
  const { results, test } = useConnectionTest((id) => api.infraConnections.test.call({ id }));
  const columns = manage ? 4 : 3;
  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
      <Table className="[&_td]:align-top" style={{ minWidth: 640 }}>
        <caption className="sr-only">{t.infraTitle}</caption>
        <thead>
          <tr>
            <Th variant="plain">{t.colName}</Th>
            <Th variant="plain">{t.colKind}</Th>
            <Th variant="plain">{t.colCa}</Th>
            {manage && (
              <Th variant="plain" className="text-right">
                {t.actions}
              </Th>
            )}
          </tr>
        </thead>
        <tbody>
          {items.map((c) => {
            const result = results[c.id];
            return (
              <Fragment key={c.id}>
                <tr className={result !== undefined ? "[&>td]:border-b-0" : undefined}>
                  <Td>
                    <span className="grid gap-0.5">
                      <span className="font-medium text-foreground">{c.name}</span>
                      <span className="font-mono text-xs break-all text-muted-foreground">{c.url}</span>
                    </span>
                  </Td>
                  <Td className="whitespace-nowrap">{c.kind === "argocd" ? t.kindArgo : t.kindKube}</Td>
                  <Td className="whitespace-nowrap">
                    {c.kind === "kubernetes" ? (c.caPem ? t.caOwn : t.caPublic) : "—"}
                  </Td>
                  {manage && (
                    <Td className="py-1.5 text-right whitespace-nowrap">
                      <RowActions
                        name={c.name}
                        busy={test.isPending}
                        testing={test.isPending && test.variables === c.id}
                        onTest={() => test.mutate(c.id)}
                      >
                        <DropdownMenuItem onClick={() => onEdit(c)}>{t.edit}</DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onClick={() => onRemove(c)}>
                          <Trash2Icon aria-hidden="true" />
                          {t.remove}
                        </DropdownMenuItem>
                      </RowActions>
                    </Td>
                  )}
                </tr>
                {result !== undefined && (
                  <tr className="bg-muted/30">
                    <Td colSpan={columns} className="pt-0 whitespace-normal">
                      <TestResult name={c.name} result={result} />
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

type FieldErrors = Partial<Record<"name" | "url" | "token" | "caPem", string>>;

/** Gom lỗi kiểm đầu vào của zod theo tên ô; lỗi không gắn được ô nào thì trả về để hiện chung. */
function issuesByField(issues: { path: PropertyKey[]; message: string }[]): FieldErrors {
  const byField: FieldErrors = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? "") as keyof FieldErrors;
    byField[key] ??= issue.message;
  }
  return byField;
}

function JenkinsForm({ connection, onDone }: { connection: JenkinsConnection | null; onDone: () => void }) {
  const t = useT(text);
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (input: { name: string; url: string }) =>
      connection
        ? api.ciConnections.update.call({ id: connection.id, ...input })
        : api.ciConnections.create.call(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: api.ciConnections.key() });
      onDone();
    },
    onError: (error) => {
      const { field, message } = formError(error);
      if (field === "name" || field === "url") setErrors({ [field]: message });
      else setFailure(message);
    },
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setFailure(null);
    setErrors({});
    // Hub kiểm lại từng ô; ở đây chỉ chặn ô trống và địa chỉ không phải https để người dùng khỏi chờ một vòng.
    const name = String(form.get("name") ?? "").trim();
    const url = String(form.get("url") ?? "").trim();
    const next: FieldErrors = {};
    if (!name) next.name = "Tên không được để trống.";
    if (!url.startsWith("https://")) next.url = "Chỉ nhận địa chỉ https.";
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }
    save.mutate({ name, url });
  }

  const busy = save.isPending;
  return (
    <form noValidate onSubmit={onSubmit} className="grid gap-3.5">
      <DialogTitle>{connection ? t.jenkinsDlgEdit : t.jenkinsDlgAdd}</DialogTitle>
      <DialogDescription>{t.jenkinsDlgLead}</DialogDescription>
      <Field invalid={errors.name !== undefined}>
        <FieldLabel>{t.fName}</FieldLabel>
        <Input
          name="name"
          defaultValue={connection?.name}
          placeholder={t.fNamePh}
          disabled={busy}
          autoComplete="off"
          autoFocus
        />
        {errors.name && <FieldError>{errors.name}</FieldError>}
      </Field>
      <Field invalid={errors.url !== undefined}>
        <FieldLabel>{t.fUrl}</FieldLabel>
        <Input
          name="url"
          type="url"
          defaultValue={connection?.url}
          placeholder="https://jenkins.example.com"
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
        />
        {errors.url ? <FieldError>{errors.url}</FieldError> : <FieldHint>{t.fJenkinsUrlHint}</FieldHint>}
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

function InfraForm({ connection, onDone }: { connection: InfraConnection | null; onDone: () => void }) {
  const t = useT(text);
  const kindId = useId();
  const caId = useId();
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<InfraConnectionKind>(connection?.kind ?? "argocd");
  const [clearCa, setClearCa] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const editing = connection !== null;

  const save = useMutation({
    mutationFn: (request: { create: InfraConnectionCreateInput } | { update: InfraConnectionUpdate }) =>
      "create" in request
        ? api.infraConnections.create.call(request.create)
        : api.infraConnections.update.call(request.update),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: api.infraConnections.key() });
      onDone();
    },
    onError: (error) => {
      const { field, message } = formError(error);
      if (field === "name" || field === "url" || field === "token" || field === "caPem")
        setErrors({ [field]: message });
      else setFailure(message);
    },
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const read = (k: string) => String(form.get(k) ?? "").trim();
    setFailure(null);
    const name = read("name");
    const url = read("url");
    const token = read("token");
    const ca = read("caPem");
    setErrors({});
    if (connection) {
      // Sửa: token trống là giữ cũ; CA trống là giữ cũ, chỉ bỏ khi người dùng đánh dấu (`null`).
      save.mutate({
        update: {
          id: connection.id,
          name,
          url,
          ...(token ? { token } : {}),
          ...(kind === "kubernetes" && (clearCa || ca) ? { caPem: clearCa ? null : ca } : {}),
        },
      });
      return;
    }
    const parsed = infraConnectionCreateInput.safeParse(
      kind === "kubernetes" ? { kind, name, url, token, ...(ca ? { caPem: ca } : {}) } : { kind, name, url, token },
    );
    if (!parsed.success) {
      const byField = issuesByField(parsed.error.issues);
      setErrors(byField);
      if (Object.keys(byField).length === 0) setFailure(t.invalid);
      return;
    }
    save.mutate({ create: parsed.data });
  }

  const busy = save.isPending;
  const urlHint = kind === "argocd" ? t.fInfraUrlArgoHint : t.fInfraUrlKubeHint;
  return (
    <form noValidate onSubmit={onSubmit} className="grid gap-3.5">
      <DialogTitle>{editing ? t.infraDlgEdit : t.infraDlgAdd}</DialogTitle>
      <DialogDescription>{t.infraDlgLead}</DialogDescription>
      {!editing && (
        <Field>
          {/* NativeSelect không phải Field.Control của Base UI nên nhãn phải nối bằng id. */}
          <FieldLabel htmlFor={kindId}>{t.fKind}</FieldLabel>
          <NativeSelect
            id={kindId}
            value={kind}
            disabled={busy}
            onChange={(e) => setKind(e.target.value === "kubernetes" ? "kubernetes" : "argocd")}
          >
            <NativeSelectOption value="argocd">{t.kindArgo}</NativeSelectOption>
            <NativeSelectOption value="kubernetes">{t.kindKube}</NativeSelectOption>
          </NativeSelect>
        </Field>
      )}
      <Field invalid={errors.name !== undefined}>
        <FieldLabel>{t.fName}</FieldLabel>
        <Input name="name" defaultValue={connection?.name} disabled={busy} autoComplete="off" autoFocus />
        {errors.name && <FieldError>{errors.name}</FieldError>}
      </Field>
      <Field invalid={errors.url !== undefined}>
        <FieldLabel>{t.fUrl}</FieldLabel>
        <Input
          name="url"
          type="url"
          defaultValue={connection?.url}
          placeholder="https://"
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
        />
        {errors.url ? <FieldError>{errors.url}</FieldError> : <FieldHint>{urlHint}</FieldHint>}
      </Field>
      {kind === "kubernetes" && (
        <Field invalid={errors.caPem !== undefined}>
          <FieldLabel htmlFor={caId}>{t.fCa}</FieldLabel>
          <Textarea
            id={caId}
            name="caPem"
            rows={4}
            disabled={busy || clearCa}
            spellCheck={false}
            className="font-mono text-xs"
            placeholder="-----BEGIN CERTIFICATE-----"
          />
          {errors.caPem ? (
            <FieldError>{errors.caPem}</FieldError>
          ) : (
            <FieldHint>{connection?.caPem ? t.fCaEditHint : t.fCaHint}</FieldHint>
          )}
          {connection?.caPem && (
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={clearCa}
                disabled={busy}
                onChange={(e) => setClearCa(e.target.checked)}
                className="size-4 accent-accent"
              />
              {t.fCaClear}
            </label>
          )}
        </Field>
      )}
      <Field invalid={errors.token !== undefined}>
        <FieldLabel>{t.fToken}</FieldLabel>
        <Input name="token" type="password" disabled={busy} autoComplete="new-password" spellCheck={false} />
        {errors.token ? (
          <FieldError>{errors.token}</FieldError>
        ) : (
          <FieldHint>
            {kind === "argocd" ? t.fTokenArgoHint : t.fTokenKubeHint}
            {editing && ` ${t.fTokenKeepHint}`}
          </FieldHint>
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

function WatcherForm({ connection, onDone }: { connection: JenkinsConnection; onDone: () => void }) {
  const t = useT(text);
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const watcherId = useId();
  const members = useQuery(api.orgMembers.list.queryOptions());
  const [userId, setUserId] = useState(connection.watcher?.userId ?? "");
  const save = useMutation({
    mutationFn: () => api.ciConnections.setWatcher.call({ id: connection.id, userId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: api.ciConnections.key() });
      onDone();
    },
  });
  return (
    <form
      noValidate
      className="grid gap-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (userId) save.mutate();
      }}
    >
      <DialogTitle>{t.watcherTitle(connection.name)}</DialogTitle>
      <DialogDescription>{t.watcherLead}</DialogDescription>
      <Field>
        <FieldLabel htmlFor={watcherId}>{t.fWatcher}</FieldLabel>
        <NativeSelect
          id={watcherId}
          value={userId}
          disabled={save.isPending || !members.data}
          onChange={(e) => setUserId(e.target.value)}
        >
          <NativeSelectOption value="" disabled>
            {t.watcherPick}
          </NativeSelectOption>
          {members.data
            ?.filter((m) => m.status === "active")
            .map((m) => (
              <NativeSelectOption key={m.userId} value={m.userId}>
                {m.name} ({m.email})
              </NativeSelectOption>
            ))}
        </NativeSelect>
      </Field>
      {members.isError && <Alert variant="destructive">{apiErrorMessage(members.error)}</Alert>}
      {save.isError && <Alert variant="destructive">{apiErrorMessage(save.error)}</Alert>}
      <DialogActions>
        <Button variant="outline" onClick={onDone}>
          {t.cancel}
        </Button>
        <Button type="submit" variant="default" disabled={save.isPending || !userId}>
          {save.isPending ? t.saving : t.save}
        </Button>
      </DialogActions>
    </form>
  );
}

function RemoveConnection({ removal, onDone }: { removal: Removal; onDone: () => void }) {
  const t = useT(text);
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () =>
      removal.kind === "jenkins"
        ? api.ciConnections.remove.call({ id: removal.item.id })
        : api.infraConnections.remove.call({ id: removal.item.id }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: removal.kind === "jenkins" ? api.ciConnections.key() : api.infraConnections.key(),
      });
      onDone();
    },
  });
  return (
    <>
      <DialogTitle>{t.removeTitle(removal.item.name)}</DialogTitle>
      <DialogDescription>{removal.kind === "jenkins" ? t.removeJenkinsLead : t.removeInfraLead}</DialogDescription>
      {remove.isError && <Alert variant="destructive">{apiErrorMessage(remove.error)}</Alert>}
      <DialogActions>
        <Button variant="outline" onClick={onDone}>
          {t.cancel}
        </Button>
        <Button variant="destructive-solid" disabled={remove.isPending} onClick={() => remove.mutate()}>
          {remove.isPending ? t.removing : t.removeConfirm}
        </Button>
      </DialogActions>
    </>
  );
}
