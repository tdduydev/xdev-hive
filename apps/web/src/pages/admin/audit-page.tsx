import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  AUDIT_RETENTION_MAX_DAYS,
  AUDIT_RETENTION_MIN_DAYS,
  type AuditFilters,
  type AuditLogItem,
  type AuditRetention,
} from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Input } from "@xdev-hive/ui/input";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { Table, TableBody, TableHeader, TableRow, Td, Th } from "@xdev-hive/ui/table";
import {
  BotIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  type LucideIcon,
  ServerIcon,
  UserIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { FilterBar, FilterSearch } from "@/components/page/filter-bar.tsx";
import { SegmentedControl } from "@/components/page/segmented-control.tsx";
import { FormRow, SettingsSection } from "@/components/page/settings.tsx";
import { UnsavedChangesGuard } from "@/components/page/unsaved-guard.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import { LoadFailure, TableSkeleton } from "@/components/ui/query-state.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { cx } from "@/lib/cx.ts";
import { formatClock, formatDay } from "@/lib/format.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { usePermissions } from "@/lib/permissions.ts";
import { isOrgAdmin } from "@/lib/roles.ts";
import { validateAuditSearch } from "@/lib/route-search.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

const text: Dict<{
  title: string;
  lead: (retentionDays: number | undefined) => string;
  range: string;
  filters: string;
  search: string;
  anyOf: (label: string) => string;
  optionOf: (label: string, value: string) => string;
  filtering: string;
  clearOne: (label: string) => string;
  actorType: string;
  actor: string;
  action: string;
  area: string;
  result: string;
  source: string;
  time: string;
  target: string;
  ok: string;
  denied: string;
  clear: string;
  user: string;
  run: string;
  system: string;
  work: string;
  know: string;
  proj: string;
  people: string;
  agent: string;
  other: string;
  loading: string;
  forbidden: string;
  previous: string;
  next: string;
  export: string;
  exporting: string;
  csv: string;
  json: string;
  exportLimit: string;
  empty: string;
  ranges: readonly string[];
  page: (n: number) => string;
  retention: string;
  retentionTitle: string;
  days: (n: number) => string;
  save: string;
  saving: string;
  saved: string;
  retentionHint: string;
  shrinkWarning: (n: number) => string;
}> = {
  vi: {
    title: "Nhật ký",
    lead: (days) => `Mọi thao tác của người, agent và hub. Chỉ đọc${days ? `, giữ ${days} ngày` : ""}.`,
    range: "Khoảng thời gian",
    filters: "Lọc nhật ký",
    search: "Tìm đối tượng, người làm, IP…",
    anyOf: (label) => `${label}: tất cả`,
    optionOf: (label, value) => `${label}: ${value}`,
    filtering: "Đang lọc",
    clearOne: (label) => `Bỏ lọc ${label}`,
    actorType: "Loại người làm",
    actor: "Người làm",
    action: "Hành động",
    area: "Nhóm",
    result: "Kết quả",
    source: "Nguồn",
    time: "Thời điểm",
    target: "Đối tượng",
    ok: "Thành công",
    denied: "Bị từ chối",
    clear: "Xoá hết bộ lọc",
    user: "Người",
    run: "Agent",
    system: "Hệ thống",
    work: "Công việc",
    know: "Kiến thức",
    proj: "Dự án và hạ tầng",
    people: "Người và quyền",
    agent: "Quản trị agent",
    other: "Khác",
    loading: "Đang tải nhật ký…",
    forbidden: "Chỉ chủ sở hữu và quản trị tổ chức được xem nhật ký.",
    previous: "Trang trước của nhật ký",
    next: "Trang sau của nhật ký",
    export: "Xuất",
    exporting: "Đang xuất…",
    csv: "Xuất CSV",
    json: "Xuất JSON",
    exportLimit: "Xuất theo bộ lọc, tối đa 20.000 dòng. Tên file có “limit-20000” khi còn dữ liệu.",
    empty: "Không có dòng nào khớp bộ lọc.",
    ranges: ["24 giờ", "7 ngày", "30 ngày", "365 ngày"],
    page: (n) => `Trang nhật ký ${n}`,
    retention: "Thời hạn lưu",
    retentionTitle: "Lưu giữ nhật ký",
    days: (n) => `${n} ngày`,
    save: "Lưu thời hạn",
    saving: "Đang lưu…",
    saved: "Đã lưu thời hạn lưu.",
    retentionHint: `Hub tự xoá nhật ký quá hạn mỗi ngày. Tối thiểu ${AUDIT_RETENTION_MIN_DAYS} ngày; mỗi lần đổi đều được ghi vào nhật ký.`,
    shrinkWarning: (n) => `Nhật ký cũ hơn ${n} ngày sẽ bị xoá vĩnh viễn ở lần dọn tiếp theo, không khôi phục được.`,
  },
  en: {
    title: "Audit log",
    lead: (days) => `Every action by people, agents and the hub. Read-only${days ? `, kept for ${days} days` : ""}.`,
    range: "Time range",
    filters: "Filter audit log",
    search: "Search target, actor, IP…",
    anyOf: (label) => `${label}: all`,
    optionOf: (label, value) => `${label}: ${value}`,
    filtering: "Filtering",
    clearOne: (label) => `Clear ${label}`,
    actorType: "Actor type",
    actor: "Actor",
    action: "Action",
    area: "Area",
    result: "Result",
    source: "Source",
    time: "Time",
    target: "Target",
    ok: "Success",
    denied: "Denied",
    clear: "Clear all filters",
    user: "Person",
    run: "Agent",
    system: "System",
    work: "Work",
    know: "Knowledge",
    proj: "Projects & infra",
    people: "People & access",
    agent: "Agent governance",
    other: "Other",
    loading: "Loading audit log…",
    forbidden: "Only organization owners and administrators can view the audit log.",
    previous: "Previous audit page",
    next: "Next audit page",
    export: "Export",
    exporting: "Exporting…",
    csv: "Export CSV",
    json: "Export JSON",
    exportLimit: "Export matching filters, up to 20,000 rows. Filenames include “limit-20000” when more data exists.",
    empty: "No rows match these filters.",
    ranges: ["24 h", "7 days", "30 days", "365 days"],
    page: (n) => `Audit page ${n}`,
    retention: "Retention",
    retentionTitle: "Log retention",
    days: (n) => `${n} days`,
    save: "Save retention",
    saving: "Saving…",
    saved: "Retention saved.",
    retentionHint: `The hub deletes expired entries daily. Minimum ${AUDIT_RETENTION_MIN_DAYS} days; every change is recorded in the audit log.`,
    shrinkWarning: (n) =>
      `Entries older than ${n} days will be permanently deleted at the next cleanup and cannot be recovered.`,
  },
};

export function AuditPage() {
  const { org } = useOrg();
  const t = useT(text);
  const can = usePermissions();
  if (!(isOrgAdmin(org.role) || can("audit.read")))
    return (
      <>
        <PageHeader title={t.title} description={t.lead(undefined)} />
        <PageBody>
          <Alert>{t.forbidden}</Alert>
        </PageBody>
      </>
    );
  return <AuditViewer key={org.id} />;
}

type FilterKey = Exclude<keyof AuditFilters, "range">;
type Range = AuditFilters["range"];
const RANGES = [1, 7, 30, 365] as const satisfies readonly Range[];

/**
 * Hub lọc và phân trang (con trỏ), nên trang chỉ có một ô tìm và một bộ phân trang, đều của hub. Bảng tự dựng thay vì
 * DataTable: bảng chỉ đọc, không sắp xếp hay ẩn cột, và cả hàng lọc là ô chọn của hub.
 */
function AuditViewer() {
  const { api, org } = useOrg();
  const can = usePermissions();
  const admin = isOrgAdmin(org.role);
  const canExport = admin || can("audit.export");
  const t = useT(text);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const search = useSearch({ from: "/session/app/in-org/admin/audit" });
  // Kiểm lại vì router giữ cả khoá thô không hợp lệ (lib/route-search.ts).
  const valid = validateAuditSearch(search);
  const filters: AuditFilters = { ...valid, range: valid.range ?? 7 };
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [page, setPage] = useState(0);
  const cursor = cursors[page];
  const retention = useQuery(api.audit.retention.queryOptions({ input: {} }));
  const list = useQuery(
    api.audit.list.queryOptions({
      input: { ...filters, limit: 20, ...(cursor ? { cursor } : {}) },
      placeholderData: keepPreviousData,
    }),
  );
  const download = useMutation(
    api.audit.export.mutationOptions({
      onSuccess: (file) => {
        const url = URL.createObjectURL(file);
        const link = document.createElement("a");
        link.href = url;
        link.download = file.name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        void queryClient.invalidateQueries({ queryKey: api.audit.list.key() });
      },
    }),
  );
  // Bộ lọc nằm trong URL để gửi được link nhật ký đã lọc; 7 ngày là mặc định nên không ghi.
  function setFilters(next: AuditFilters) {
    const { range, ...rest } = next;
    void navigate({
      to: "/admin/audit",
      search: validateAuditSearch({ ...rest, ...(range === 7 ? {} : { range }) }),
      replace: true,
    });
    setPage(0);
    setCursors([undefined]);
  }
  function update<K extends keyof AuditFilters>(key: K, value: AuditFilters[K] | undefined) {
    const next = { ...filters };
    if (value === undefined || value === "") delete next[key];
    else next[key] = value as AuditFilters[K];
    setFilters(next);
  }
  const labels: Record<FilterKey, string> = {
    q: t.search,
    actorType: t.actorType,
    area: t.area,
    source: t.source,
    result: t.result,
    actorId: t.actor,
    action: t.action,
  };
  const options = {
    actorType: [
      ["user", t.user],
      ["run", t.run],
      ["system", t.system],
    ],
    area: [
      ["work", t.work],
      ["know", t.know],
      ["proj", t.proj],
      ["people", t.people],
      ["agent", t.agent],
      ["other", t.other],
    ],
    source: [
      ["web", "Web"],
      ["mcp", "MCP"],
      ["hub", "Hub"],
    ],
    result: [
      ["ok", t.ok],
      ["denied", t.denied],
    ],
  } as const;
  const active = (Object.entries(filters) as [keyof AuditFilters, unknown][])
    .filter((entry): entry is [FilterKey, string] => entry[0] !== "range")
    .map(([key, value]) => ({
      key,
      label: labels[key],
      value: key in options ? (options[key as keyof typeof options].find(([id]) => id === value)?.[1] ?? value) : value,
    }));
  const clearAll = () => setFilters({ range: filters.range });
  const busy = list.isFetching;

  let table: ReactNode;
  if (list.isPending) table = <TableSkeleton label={t.loading} rows={8} columns={6} />;
  else if (list.isError) table = <LoadFailure error={list.error} retry={list.refetch} />;
  else
    table = (
      <div aria-busy={busy} className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
        <Table style={{ minWidth: 760 }}>
          <caption className="sr-only">{t.title}</caption>
          <TableHeader>
            <TableRow>
              <Th variant="plain">{t.time}</Th>
              <Th variant="plain">{t.actor}</Th>
              <Th variant="plain">{t.action}</Th>
              <Th variant="plain">{t.target}</Th>
              <Th variant="plain">{t.result}</Th>
              <Th variant="plain">{t.source}</Th>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.data.items.map((row) => (
              <TableRow key={row.id}>
                <Td className="whitespace-nowrap tabular-nums">
                  <AuditTime iso={row.createdAt} />
                </Td>
                <Td>
                  <span className="flex max-w-56 min-w-0 items-center gap-1.5">
                    <span className="truncate" title={row.actor}>
                      {row.actor}
                    </span>
                    <ActorTypeIcon type={row.actorType} label={t[row.actorType]} />
                  </span>
                </Td>
                <Td>
                  <Pill tone={/cancel|role|sso|polic/.test(row.action) ? "warn" : "neutral"} className="font-mono">
                    {row.action}
                  </Pill>
                </Td>
                {/* Cột duy nhất được xuống dòng: tối thiểu 128px để bảng vẫn vừa 1100px với Be Vietnam Pro (rộng hơn IBM Plex). */}
                <Td className="max-w-72 min-w-32 text-xs break-words">
                  {row.targetType || row.targetId ? (
                    <>
                      {row.targetType && <span className="text-muted-foreground">{row.targetType}: </span>}
                      <span className="font-mono">{row.targetId}</span>
                    </>
                  ) : (
                    "—"
                  )}
                </Td>
                <Td>
                  <Pill tone={row.result === "denied" ? "bad" : "ok"}>{row.result === "denied" ? t.denied : t.ok}</Pill>
                </Td>
                <Td className="whitespace-nowrap">
                  <span className="text-xs">{SOURCE_LABEL[row.source]}</span>
                  {row.ip && <span className="ml-1.5 font-mono text-xs text-muted-foreground">{row.ip}</span>}
                </Td>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {list.data.items.length === 0 && (
          <div className="grid justify-items-center gap-3 px-4 py-10 text-center text-muted-foreground">
            <p>{t.empty}</p>
            {active.length > 0 && (
              <Button variant="outline" size="sm" onClick={clearAll}>
                {t.clear}
              </Button>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3 border-t border-border px-3 py-2 text-xs">
          <span className="text-muted-foreground" aria-live="polite">
            {t.page(page + 1)}
          </span>
          <div className="flex gap-1 sm:ml-auto">
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={t.previous}
              disabled={!page || busy}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeftIcon aria-hidden="true" />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={t.next}
              disabled={!list.data.nextCursor || busy}
              onClick={() => {
                setCursors((prev) => [...prev.slice(0, page + 1), list.data.nextCursor ?? undefined]);
                setPage(page + 1);
              }}
            >
              <ChevronRightIcon aria-hidden="true" />
            </Button>
          </div>
        </div>
      </div>
    );

  return (
    <>
      <PageHeader title={t.title} description={t.lead(retention.data?.retentionDays)}>
        <SegmentedControl
          label={t.range}
          value={String(filters.range)}
          onChange={(value) => update("range", Number(value) as Range)}
          options={RANGES.map((range, i) => ({ value: String(range), label: t.ranges[i] ?? String(range) }))}
        />
      </PageHeader>
      <PageBody>
        <div className="grid min-w-0 gap-2.5">
          <FilterBar
            label={t.filters}
            actions={
              canExport && (
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={download.isPending} />}>
                    <DownloadIcon aria-hidden="true" />
                    {download.isPending ? t.exporting : t.export}
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-64">
                    <DropdownMenuGroup>
                      <DropdownMenuLabel className="text-xs font-normal whitespace-normal text-muted-foreground">
                        {t.exportLimit}
                      </DropdownMenuLabel>
                      <DropdownMenuItem onClick={() => download.mutate({ ...filters, format: "csv" })}>
                        {t.csv}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => download.mutate({ ...filters, format: "json" })}>
                        {t.json}
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              )
            }
          >
            <FilterSearch
              placeholder={t.search}
              value={filters.q ?? ""}
              onChange={(value) => update("q", value.slice(0, 200))}
            />
            {(["actorType", "area", "source", "result"] as const).map((key) => (
              <NativeSelect
                key={key}
                aria-label={labels[key]}
                className={cx("w-[calc(50%-0.25rem)] sm:w-auto", filters[key] && "[&>select]:border-primary")}
                value={filters[key] ?? ""}
                onChange={(e) => update(key, (e.currentTarget.value || undefined) as AuditFilters[typeof key])}
              >
                {/* Nhãn lọc đứng trước giá trị để ô đã chọn vẫn tự nói nó lọc gì (ô không có nhãn rời). */}
                <option value="">{t.anyOf(labels[key])}</option>
                {options[key].map(([value, label]) => (
                  <option key={value} value={value}>
                    {t.optionOf(labels[key], label)}
                  </option>
                ))}
              </NativeSelect>
            ))}
            {(["actorId", "action"] as const).map((key) => (
              <Input
                key={key}
                aria-label={labels[key]}
                placeholder={`${labels[key]}…`}
                maxLength={200}
                spellCheck={false}
                className="h-8 w-[calc(50%-0.25rem)] sm:w-36"
                value={filters[key] ?? ""}
                onChange={(e) => update(key, e.currentTarget.value)}
              />
            ))}
          </FilterBar>
          {active.length > 0 && (
            <div role="status" className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
              <span className="text-muted-foreground">{t.filtering}</span>
              {active.map((filter) => (
                <span
                  key={filter.key}
                  className="inline-flex max-w-full items-center gap-1 rounded-full bg-accent py-0.5 pr-1 pl-2.5 text-accent-foreground"
                >
                  <span className="min-w-0 break-words">
                    <strong>{filter.label}:</strong> {filter.value}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t.clearOne(filter.label)}
                    onClick={() => update(filter.key, undefined)}
                  >
                    <XIcon aria-hidden="true" />
                  </Button>
                </span>
              ))}
              <Button variant="ghost" size="xs" onClick={clearAll}>
                {t.clear}
              </Button>
            </div>
          )}
          {download.isError && <Alert variant="destructive">{apiErrorMessage(download.error)}</Alert>}
          {table}
        </div>
        {admin && retention.data && <RetentionSection current={retention.data} />}
      </PageBody>
    </>
  );
}

const ACTOR_ICON: Record<AuditLogItem["actorType"], LucideIcon> = { user: UserIcon, run: BotIcon, system: ServerIcon };

/** Loại người làm là biểu tượng có tên (title + chữ ẩn) để cột Người làm đủ hẹp cho bảng vừa màn 1100 px. */
function ActorTypeIcon({ type, label }: { type: AuditLogItem["actorType"]; label: string }) {
  const IconComponent = ACTOR_ICON[type];
  return (
    <span title={label} className="order-first shrink-0 self-center text-muted-foreground">
      <IconComponent aria-hidden="true" className="size-3.5" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

const SOURCE_LABEL: Record<AuditLogItem["source"], string> = { web: "Web", mcp: "MCP", hub: "Hub" };

/** Nhật ký cần tới giây để đối chiếu; ngày giờ đầy đủ theo ngôn ngữ đang chọn nằm trong `title`. */
function AuditTime({ iso }: { iso: string }) {
  const lang = useLang();
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString(lang === "vi" ? "vi-VN" : "en-US")}>
      {formatDay(iso)} <span className="text-muted-foreground">{formatClock(iso)}</span>
    </time>
  );
}

const RETENTION_CHOICES = [90, 180, 365, 730, 1095, 1825, 3650];

/** Chỉ chủ sở hữu và quản trị tổ chức đổi được (hub cũng chặn); hạ thời hạn thì báo trước dữ liệu sẽ mất. */
function RetentionSection({ current }: { current: AuditRetention }) {
  const { api } = useOrg();
  const t = useT(text);
  const fieldId = useId();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(current.retentionDays);
  const save = useMutation(
    api.audit.setRetention.mutationOptions({
      onSuccess: (next) => {
        queryClient.setQueryData(api.audit.retention.queryKey({ input: {} }), next);
        setDraft(next.retentionDays);
        // Lần đổi vừa ghi một dòng audit.retention.update.
        void queryClient.invalidateQueries({ queryKey: api.audit.list.key() });
      },
    }),
  );
  const dirty = draft !== current.retentionDays;
  // Hub nhận mọi số ngày trong khoảng cho phép; giá trị đặt qua API ngoài danh sách vẫn phải hiện đúng.
  const choices = [...new Set([...RETENTION_CHOICES, current.retentionDays])]
    .filter((n) => n >= AUDIT_RETENTION_MIN_DAYS && n <= AUDIT_RETENTION_MAX_DAYS)
    .sort((a, b) => a - b);
  return (
    <>
      <UnsavedChangesGuard when={dirty} />
      <SettingsSection
        id="thoi-han-luu"
        title={t.retentionTitle}
        description={t.retentionHint}
        save={{
          dirty,
          saving: save.isPending,
          saved: save.isSuccess,
          error: save.isError ? apiErrorMessage(save.error) : undefined,
          onSave: () => save.mutate({ retentionDays: draft }),
          onDiscard: () => {
            save.reset();
            setDraft(current.retentionDays);
          },
          saveLabel: t.save,
          savedLabel: t.saved,
        }}
      >
        <FormRow label={t.retention} htmlFor={`${fieldId}-retention`}>
          <NativeSelect
            id={`${fieldId}-retention`}
            className="w-full sm:w-48"
            value={draft}
            onChange={(e) => {
              setDraft(Number(e.currentTarget.value));
              save.reset();
            }}
          >
            {choices.map((n) => (
              <option key={n} value={n}>
                {t.days(n)}
              </option>
            ))}
          </NativeSelect>
          {draft < current.retentionDays && (
            <p className="rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning">{t.shrinkWarning(draft)}</p>
          )}
        </FormRow>
      </SettingsSection>
    </>
  );
}
