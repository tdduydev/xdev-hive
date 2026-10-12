import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { useId, useState } from "react";
import { type Column, DataTable } from "@/components/data-table/data-table.tsx";
import { Pill } from "@/components/ui/pill.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { usePermissions } from "@/lib/permissions.ts";
import { isOrgAdmin } from "@/lib/roles.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

const text: Dict<{
  title: string;
  crumb: string;
  lead: (retentionDays: number | undefined) => string;
  range: string;
  search: string;
  pageSearch: string;
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
  all: string;
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
  retry: string;
  forbidden: string;
  previous: string;
  next: string;
  csv: string;
  json: string;
  exportLimit: string;
  empty: string;
  ranges: readonly string[];
  page: (n: number) => string;
  retention: string;
  days: (n: number) => string;
  save: string;
  saving: string;
  saved: string;
  retentionHint: string;
  shrinkWarning: (n: number) => string;
}> = {
  vi: {
    title: "Nhật ký",
    crumb: "Theo dõi",
    lead: (days) => `Mọi thao tác của người, agent và hub. Chỉ đọc${days ? `, giữ ${days} ngày` : ""}.`,
    range: "Khoảng thời gian",
    search: "Tìm đối tượng, người làm, IP…",
    pageSearch: "Tìm trong trang…",
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
    all: "Tất cả",
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
    loading: "Đang tải…",
    retry: "Thử lại",
    forbidden: "Chỉ chủ sở hữu và quản trị tổ chức được xem nhật ký.",
    previous: "Trang trước của nhật ký",
    next: "Trang sau của nhật ký",
    csv: "Xuất CSV",
    json: "Xuất JSON",
    exportLimit: "Xuất theo bộ lọc, tối đa 20.000 dòng. Tên file có “limit-20000” khi còn dữ liệu.",
    empty: "Không có dòng nào khớp bộ lọc.",
    ranges: ["24 giờ", "7 ngày", "30 ngày", "365 ngày"],
    page: (n) => `Trang nhật ký ${n}`,
    retention: "Thời hạn lưu",
    days: (n) => `${n} ngày`,
    save: "Lưu thời hạn",
    saving: "Đang lưu…",
    saved: "Đã lưu thời hạn lưu.",
    retentionHint: `Hub tự xoá nhật ký quá hạn mỗi ngày. Tối thiểu ${AUDIT_RETENTION_MIN_DAYS} ngày; mỗi lần đổi đều được ghi vào nhật ký.`,
    shrinkWarning: (n) => `Nhật ký cũ hơn ${n} ngày sẽ bị xoá vĩnh viễn ở lần dọn tiếp theo, không khôi phục được.`,
  },
  en: {
    title: "Audit log",
    crumb: "Monitoring",
    lead: (days) => `Every action by people, agents and the hub. Read-only${days ? `, kept for ${days} days` : ""}.`,
    range: "Time range",
    search: "Search target, actor, IP…",
    pageSearch: "Search this page…",
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
    all: "All",
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
    loading: "Loading…",
    retry: "Retry",
    forbidden: "Only organization owners and administrators can view the audit log.",
    previous: "Previous audit page",
    next: "Next audit page",
    csv: "Export CSV",
    json: "Export JSON",
    exportLimit: "Export matching filters, up to 20,000 rows. Filenames include “limit-20000” when more data exists.",
    empty: "No rows match these filters.",
    ranges: ["24 h", "7 days", "30 days", "365 days"],
    page: (n) => `Audit page ${n}`,
    retention: "Retention",
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
  return (
    <>
      <PageHeader crumb={t.crumb} title={t.title} />
      <PageBody>
        {isOrgAdmin(org.role) || can("audit.read") ? <AuditViewer key={org.id} /> : <Alert>{t.forbidden}</Alert>}
      </PageBody>
    </>
  );
}

function AuditViewer() {
  const { api, org } = useOrg();
  const can = usePermissions();
  const canExport = isOrgAdmin(org.role) || can("audit.export");
  const t = useT(text);
  const lang = useLang();
  const fieldId = useId();
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<AuditFilters>({ range: 7 });
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
  function update<K extends keyof AuditFilters>(key: K, value: AuditFilters[K]) {
    setFilters((prev) => {
      const next = { ...prev };
      if (value === undefined || value === "") delete next[key];
      else next[key] = value;
      return next;
    });
    setPage(0);
    setCursors([undefined]);
  }
  const labels = { actorType: t.actorType, area: t.area, source: t.source, result: t.result };
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
  const columns: Column<AuditLogItem>[] = [
    {
      key: "time",
      label: t.time,
      value: (r) => r.createdAt,
      cell: (r) => (
        <time dateTime={r.createdAt} className="font-mono text-xs">
          {new Date(r.createdAt).toLocaleString(lang === "vi" ? "vi-VN" : "en-US")}
        </time>
      ),
    },
    {
      key: "actor",
      label: t.actor,
      value: (r) => r.actor,
      cell: (r) => (
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="grid size-7 shrink-0 place-items-center rounded-full bg-accent text-xs text-accent-foreground"
          >
            {r.actorType === "run" ? "AI" : r.actor.slice(0, 2)}
          </span>
          <div>
            <div>{r.actor}</div>
            <span className="text-xs text-muted-foreground">{t[r.actorType]}</span>
          </div>
        </div>
      ),
    },
    {
      key: "action",
      label: t.action,
      value: (r) => r.action,
      cell: (r) => <Pill tone={/cancel|role|sso|polic/.test(r.action) ? "warn" : "neutral"}>{r.action}</Pill>,
    },
    { key: "area", label: t.area, hidden: true, value: (r) => t[r.area] },
    {
      key: "target",
      label: t.target,
      value: (r) => [r.targetType, r.targetId].filter(Boolean).join(": "),
      className: "max-w-80 whitespace-normal break-words",
    },
    {
      key: "result",
      label: t.result,
      value: (r) => r.result,
      cell: (r) => <Pill tone={r.result === "denied" ? "bad" : "ok"}>{r.result === "denied" ? t.denied : t.ok}</Pill>,
    },
    {
      key: "source",
      label: t.source,
      value: (r) => [r.source, r.ip].filter(Boolean).join(" · "),
      className: "font-mono text-xs",
    },
  ];
  const activeFilters = Object.entries(filters)
    .filter(([key]) => key !== "range")
    .map(([key, value]) => ({
      key,
      label:
        key === "q"
          ? t.search
          : key === "actorId"
            ? t.actor
            : key === "action"
              ? t.action
              : labels[key as keyof typeof labels],
      values:
        key in options
          ? (options[key as keyof typeof options].find(([id]) => id === value)?.[1] ?? String(value))
          : String(value),
      clear: () => update(key as keyof AuditFilters, undefined),
    }));
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t.lead(retention.data?.retentionDays)}</p>
        <fieldset aria-label={t.range} className="flex flex-wrap gap-1 rounded-lg bg-muted p-1">
          {([1, 7, 30, 365] as const).map((range, i) => (
            <Button
              key={range}
              size="sm"
              variant={range === filters.range ? "secondary" : "ghost"}
              aria-pressed={range === filters.range}
              onClick={() => update("range", range)}
            >
              {t.ranges[i]}
            </Button>
          ))}
        </fieldset>
      </div>
      {isOrgAdmin(org.role) && retention.data && <RetentionForm current={retention.data} />}
      <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label htmlFor={`${fieldId}-search`} className="grid gap-1 text-xs sm:col-span-2">
          {t.search}
          <Input
            id={`${fieldId}-search`}
            type="search"
            maxLength={200}
            value={filters.q ?? ""}
            onChange={(e) => update("q", e.currentTarget.value)}
          />
        </label>
        {(["actorType", "area", "source", "result"] as const).map((key) => (
          <label key={key} htmlFor={`${fieldId}-${key}`} className="grid min-w-0 gap-1 text-xs">
            {labels[key]}
            <NativeSelect
              id={`${fieldId}-${key}`}
              aria-label={labels[key]}
              value={filters[key] ?? ""}
              onChange={(e) => update(key, e.currentTarget.value as AuditFilters[typeof key])}
            >
              <option value="">{t.all}</option>
              {options[key].map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </NativeSelect>
          </label>
        ))}
        <label htmlFor={`${fieldId}-actor`} className="grid gap-1 text-xs">
          {t.actor}
          <Input
            id={`${fieldId}-actor`}
            maxLength={200}
            value={filters.actorId ?? ""}
            onChange={(e) => update("actorId", e.currentTarget.value)}
          />
        </label>
        <label htmlFor={`${fieldId}-action`} className="grid gap-1 text-xs">
          {t.action}
          <Input
            id={`${fieldId}-action`}
            maxLength={200}
            value={filters.action ?? ""}
            onChange={(e) => update("action", e.currentTarget.value)}
          />
        </label>
      </div>
      {canExport && (
        <fieldset className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            disabled={download.isPending}
            onClick={() => download.mutate({ ...filters, format: "csv" })}
          >
            {t.csv}
          </Button>
          <Button
            variant="outline"
            disabled={download.isPending}
            onClick={() => download.mutate({ ...filters, format: "json" })}
          >
            {t.json}
          </Button>
          <p className="text-xs text-muted-foreground">{t.exportLimit}</p>
        </fieldset>
      )}
      {download.isError && <Alert variant="destructive">{apiErrorMessage(download.error)}</Alert>}
      {list.isPending ? (
        <p role="status" aria-busy="true">
          {t.loading}
        </p>
      ) : list.isError ? (
        <Alert variant="destructive">
          {apiErrorMessage(list.error)}
          <Button variant="outline" onClick={() => list.refetch()}>
            {t.retry}
          </Button>
        </Alert>
      ) : (
        <div aria-busy={list.isFetching}>
          <DataTable
            key={JSON.stringify([filters, cursor, lang])}
            columns={columns}
            rows={list.data.items}
            caption={t.title}
            selectable={false}
            pageSize={20}
            placeholder={t.pageSearch}
            activeFilters={activeFilters}
            emptyContent={t.empty}
          />
          <fieldset className="mt-3 flex flex-wrap items-center gap-2" aria-label={t.title}>
            <span className="mr-auto text-xs text-muted-foreground" aria-live="polite">
              {t.page(page + 1)}
            </span>
            <Button variant="outline" disabled={!page || list.isFetching} onClick={() => setPage(page - 1)}>
              {t.previous}
            </Button>
            <Button
              variant="outline"
              disabled={!list.data.nextCursor || list.isFetching}
              onClick={() => {
                setCursors((prev) => [...prev.slice(0, page + 1), list.data.nextCursor ?? undefined]);
                setPage(page + 1);
              }}
            >
              {t.next}
            </Button>
          </fieldset>
        </div>
      )}
    </>
  );
}

const RETENTION_CHOICES = [90, 180, 365, 730, 1095, 1825, 3650];

/** Chỉ chủ sở hữu và quản trị tổ chức đổi được (hub cũng chặn); hạ thời hạn thì báo trước dữ liệu sẽ mất. */
function RetentionForm({ current }: { current: AuditRetention }) {
  const { api } = useOrg();
  const t = useT(text);
  const fieldId = useId();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(current.retentionDays);
  const save = useMutation(
    api.audit.setRetention.mutationOptions({
      onSuccess: (next) => {
        queryClient.setQueryData(api.audit.retention.queryKey({ input: {} }), next);
        // Lần đổi vừa ghi một dòng audit.retention.update.
        void queryClient.invalidateQueries({ queryKey: api.audit.list.key() });
      },
    }),
  );
  // Hub nhận mọi số ngày trong khoảng cho phép; giá trị đặt qua API ngoài danh sách vẫn phải hiện đúng.
  const choices = [...new Set([...RETENTION_CHOICES, current.retentionDays])]
    .filter((n) => n >= AUDIT_RETENTION_MIN_DAYS && n <= AUDIT_RETENTION_MAX_DAYS)
    .sort((a, b) => a - b);
  return (
    <form
      className="grid gap-2 rounded-lg border border-border bg-card p-3 sm:flex sm:flex-wrap sm:items-end sm:gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({ retentionDays: draft });
      }}
    >
      <label htmlFor={`${fieldId}-retention`} className="grid gap-1 text-xs sm:w-40">
        {t.retention}
        <NativeSelect
          id={`${fieldId}-retention`}
          aria-label={t.retention}
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
      </label>
      <Button type="submit" variant="outline" disabled={draft === current.retentionDays || save.isPending}>
        {save.isPending ? t.saving : t.save}
      </Button>
      <p className="text-xs text-muted-foreground sm:min-w-60 sm:flex-1">{t.retentionHint}</p>
      {draft < current.retentionDays && (
        <p className="rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning sm:basis-full">
          {t.shrinkWarning(draft)}
        </p>
      )}
      {save.isSuccess && (
        <p role="status" className="rounded-lg bg-success-soft px-3 py-2 text-xs text-success sm:basis-full">
          {t.saved}
        </p>
      )}
      {save.isError && (
        <Alert variant="destructive" className="sm:basis-full">
          {apiErrorMessage(save.error)}
        </Alert>
      )}
    </form>
  );
}
