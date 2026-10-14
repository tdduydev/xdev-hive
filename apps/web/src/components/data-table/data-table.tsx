import { Button } from "@xdev-hive/ui/button";
import { Input } from "@xdev-hive/ui/input";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Table, TableBody, TableHead, TableHeader, TableRow, Td } from "@xdev-hive/ui/table";
import { cn } from "cn";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Columns3, PlusCircle, X } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import {
  type Facet,
  type Filters,
  facetOptions,
  filterRows,
  paginateRows,
  type SearchColumn,
  type Sort,
  sortRows,
} from "@/components/data-table/model.ts";
import { FilterBar, FilterSearch } from "@/components/page/filter-bar.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover.tsx";
import { type Dict, useT } from "@/lib/i18n.ts";

export interface Column<Row> extends SearchColumn<Row> {
  label: string;
  cell?: (row: Row) => ReactNode;
  sortable?: boolean;
  hideable?: boolean;
  hidden?: boolean;
  className?: string;
  /** `end` cho cột số (tiền, token, thời lượng) và cột thao tác: canh phải, chữ số đều cột. */
  align?: "start" | "end";
  /**
   * Ghim cột khi bảng cuộn ngang: `start` cho cột tên (chỉ cột hiện đầu tiên), `end` cho cột thao tác (chỉ cột cuối),
   * để người dùng không mất ngữ cảnh của dòng khi kéo sang phải. Chỉ ghim từ 640 px: ở 360 px cột tên có thể che hết
   * chỗ cho thao tác khi cuộn tới cuối bảng.
   */
  pin?: "start" | "end";
}
export interface BulkAction<Row> {
  key: string;
  label: string;
  onClick: (rows: Row[]) => void;
  disabled?: (rows: Row[]) => boolean;
}
export interface ActiveFilter {
  key: string;
  label: string;
  values: string;
  clear: () => void;
}
export interface DataTableProps<Row extends { id: string }> {
  columns: readonly Column<Row>[];
  rows: readonly Row[];
  facets?: readonly Facet<Row>[];
  bulk?: readonly BulkAction<Row>[];
  pageSize?: number;
  onRowClick?: (row: Row) => void;
  activeId?: string;
  rowLabel?: (row: Row) => string;
  placeholder?: string;
  caption?: string;
  /** Cột chọn và thanh thao tác hàng loạt. Mặc định chỉ bật khi có `bulk` (admin-layout.md § Bảng: Chọn nhiều). */
  selectable?: boolean;
  /** Server-side scopes remain visible and clearable alongside local filters. */
  activeFilters?: readonly ActiveFilter[];
  emptyContent?: ReactNode;
  /** Bề rộng tối thiểu của bảng (px) trước khi cuộn ngang. Bảng ít cột nên đặt nhỏ hơn mặc định để khỏi cuộn. */
  minWidth?: number;
  /** Nút của bảng đặt cạnh nút Cột, ví dụ Xuất CSV. */
  toolbar?: ReactNode;
  /**
   * Hub trả theo trang (offset, con trỏ): bảng hiện mọi dòng của trang đó và chân bảng dùng nút trang của hub thay cho
   * phân trang cục bộ, để không có hai bộ phân trang chồng nhau.
   */
  serverPaging?: ServerPaging;
  /**
   * Ô tìm do trang giữ, khi hub tìm thay cho lọc cục bộ (memory, nhật ký): bảng không lọc dòng theo chữ nữa, để không có
   * hai ô tìm cho cùng một bảng. `false` bỏ hẳn ô tìm.
   */
  search?: TableSearch | false;
  /** Bộ lọc riêng của trang (công tắc, nhóm nút) đứng sau các facet, trước nút của bảng. */
  filters?: ReactNode;
}
export interface TableSearch {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /**
   * Có thì chỉ tìm khi bấm Enter hay nút Tìm (hub tìm theo nghĩa, gọi mỗi phím là tốn); không có thì trang tự quyết
   * khi nào gọi hub theo `value`.
   */
  onSubmit?: (value: string) => void;
}
export interface ServerPaging {
  /** Vị trí hiện tại, ví dụ "Trang 2 của nhật ký" hay "Dòng 51–100". */
  label: string;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  previousLabel?: string;
  nextLabel?: string;
}

const text: Dict<{
  columns: string;
  showColumns: string;
  clearOne: string;
  filtering: string;
  clearAll: string;
  bulk: string;
  clearSelection: string;
  selectPage: string;
  noMatch: string;
  perPage: string;
  previous: string;
  next: string;
  search: string;
  keyword: string;
  submit: string;
  clear: string;
  select: string;
  selected: (n: number) => string;
  range: (from: number, to: number, total: number) => string;
  page: (n: number, total: number) => string;
  matches: (n: number, total: number) => string;
  find: (label: string) => string;
  open: (label: string) => string;
}> = {
  vi: {
    columns: "Cột",
    showColumns: "Hiện cột",
    clearOne: "Bỏ lọc này",
    filtering: "Đang lọc",
    clearAll: "Xoá hết bộ lọc",
    bulk: "Thao tác hàng loạt",
    clearSelection: "Bỏ chọn",
    selectPage: "Chọn cả trang",
    noMatch: "Không có dòng nào khớp bộ lọc.",
    perPage: "Số dòng",
    previous: "Trang trước",
    next: "Trang sau",
    search: "Tìm…",
    keyword: "Từ khoá",
    submit: "Tìm",
    clear: "Bỏ lọc",
    select: "Chọn",
    selected: (n) => `Đã chọn ${n} dòng`,
    range: (from, to, total) => `${from}–${to} trên ${total}`,
    page: (n, total) => `Trang ${n} / ${total}`,
    matches: (n, total) => `${n} / ${total} dòng khớp`,
    find: (label) => `Tìm ${label.toLocaleLowerCase()}…`,
    open: (label) => `Mở dòng ${label}`,
  },
  en: {
    columns: "Columns",
    showColumns: "Show columns",
    clearOne: "Clear filter",
    filtering: "Filtering",
    clearAll: "Clear all filters",
    bulk: "Bulk actions",
    clearSelection: "Clear selection",
    selectPage: "Select page",
    noMatch: "No rows match these filters.",
    perPage: "Rows",
    previous: "Previous page",
    next: "Next page",
    search: "Search…",
    keyword: "Keyword",
    submit: "Search",
    clear: "Clear",
    select: "Select",
    selected: (n) => `${n} selected`,
    range: (from, to, total) => `${from}–${to} of ${total}`,
    page: (n, total) => `Page ${n} of ${total}`,
    matches: (n, total) => `${n} / ${total} rows match`,
    find: (label) => `Find ${label.toLocaleLowerCase()}…`,
    open: (label) => `Open row ${label}`,
  },
};

export function DataTable<Row extends { id: string }>({
  columns,
  rows,
  facets = [],
  bulk = [],
  pageSize = 10,
  onRowClick,
  activeId,
  rowLabel = (row) => row.id,
  placeholder,
  caption,
  selectable = bulk.length > 0,
  activeFilters = [],
  emptyContent,
  minWidth = 1060,
  toolbar,
  serverPaging,
  search,
  filters: pageFilters,
}: DataTableProps<Row>) {
  const t = useT(text);
  const sizeId = useId();
  const [localQuery, setQuery] = useState("");
  // Ô tìm của trang (hay không có ô tìm) thì hub đã lọc: chữ trong ô không lọc thêm ở đây.
  const query = search === undefined ? localQuery : "";
  const [filters, setFilters] = useState<Filters>({});
  const [sort, setSort] = useState<Sort | null>(null);
  const [hidden, setHidden] = useState(
    () => new Set(columns.filter((column) => column.hidden).map((column) => column.key)),
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(pageSize);
  const state = { query, filters };
  const filtered = filterRows(rows, columns, facets, state);
  const sorted = sortRows(filtered, columns, sort);
  const result = paginateRows(sorted, serverPaging ? 0 : page, serverPaging ? Math.max(1, sorted.length) : size);
  const visible = columns.filter((column) => !hidden.has(column.key));
  const pinStart = visible[0]?.pin === "start" ? visible[0].key : undefined;
  const pinEnd = visible.at(-1)?.pin === "end" ? visible.at(-1)?.key : undefined;
  // Ô ghim cần nền đặc, không thì chữ của cột cuộn bên dưới lộ ra; hover của dòng tô lại nền đó.
  const pinCell = (key: string, head = false) =>
    key === pinStart
      ? cn(
          "z-10 bg-card sm:sticky sm:shadow-[inset_-1px_0_0_var(--border)]",
          selectable ? "left-10" : "left-0",
          !head && "[tr:hover>&]:bg-(--pin-hover) [tr[data-state=selected]>&]:bg-muted",
        )
      : key === pinEnd
        ? cn(
            "z-10 bg-card sm:sticky sm:shadow-[inset_1px_0_0_var(--border)]",
            onRowClick ? "right-10" : "right-0",
            !head && "[tr:hover>&]:bg-(--pin-hover) [tr[data-state=selected]>&]:bg-muted",
          )
        : undefined;
  // Filtering and refreshes must not leave hidden rows in a bulk operation.
  const selectedRows = filtered.filter((row) => selected.has(row.id));
  const allPage = result.rows.length > 0 && result.rows.every((row) => selected.has(row.id));
  const somePage = result.rows.some((row) => selected.has(row.id));
  const updateFilter = (key: string, values: readonly string[]) => {
    setFilters((prev) => ({ ...prev, [key]: values }));
    setPage(0);
    setSelected(new Set());
  };
  const active: ActiveFilter[] = [
    ...activeFilters,
    ...facets
      .filter((facet) => filters[facet.key]?.length)
      .map((facet) => ({
        key: `local-${facet.key}`,
        label: facet.label,
        values: (filters[facet.key] ?? [])
          .map((value) => facet.options?.find((option) => option.value === value)?.label ?? value)
          .join(", "),
        clear: () => updateFilter(facet.key, []),
      })),
  ];
  if (query.trim())
    active.unshift({
      key: "query",
      label: t.keyword,
      values: query,
      clear: () => {
        setQuery("");
        setPage(0);
        setSelected(new Set());
      },
    });
  const clearAll = () => {
    setQuery("");
    setFilters({});
    setPage(0);
    setSelected(new Set());
    for (const filter of activeFilters) filter.clear();
  };
  return (
    <div className="grid min-w-0 gap-2.5 [&_button:not(:disabled)]:cursor-pointer">
      <FilterBar
        actions={
          <>
            {toolbar}
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
                <Columns3 aria-hidden="true" />
                {t.columns}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-48">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{t.showColumns}</DropdownMenuLabel>
                  {columns
                    .filter((column) => column.hideable !== false)
                    .map((column) => (
                      <DropdownMenuCheckboxItem
                        key={column.key}
                        className="cursor-pointer"
                        checked={!hidden.has(column.key)}
                        disabled={visible.length === 1 && !hidden.has(column.key)}
                        closeOnClick={false}
                        onCheckedChange={(checked) =>
                          setHidden((prev) => {
                            const next = new Set(prev);
                            if (checked) next.delete(column.key);
                            else next.add(column.key);
                            return next;
                          })
                        }
                      >
                        {column.label}
                      </DropdownMenuCheckboxItem>
                    ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      >
        {search === undefined ? (
          <FilterSearch
            placeholder={placeholder ?? t.search}
            value={localQuery}
            onChange={(value) => {
              setQuery(value);
              setPage(0);
              setSelected(new Set());
            }}
          />
        ) : search && search.onSubmit ? (
          <form
            className="contents"
            onSubmit={(event) => {
              event.preventDefault();
              search.onSubmit?.(search.value.trim());
            }}
          >
            <FilterSearch
              placeholder={search.placeholder ?? placeholder ?? t.search}
              value={search.value}
              onChange={search.onChange}
              className="sm:w-80"
            />
            <Button type="submit" variant="outline" size="sm">
              {t.submit}
            </Button>
          </form>
        ) : (
          search && (
            <FilterSearch
              placeholder={search.placeholder ?? placeholder ?? t.search}
              value={search.value}
              onChange={search.onChange}
            />
          )
        )}
        {facets.map((facet) => (
          <FacetFilter
            key={facet.key}
            facet={facet}
            options={facetOptions(rows, columns, facets, state, facet)}
            chosen={filters[facet.key] ?? []}
            onChange={(values) => updateFilter(facet.key, values)}
          />
        ))}
        {pageFilters}
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
                <strong>{filter.label}:</strong> {filter.values}
              </span>
              <Button variant="ghost" size="icon-xs" aria-label={`${t.clear} ${filter.label}`} onClick={filter.clear}>
                <X aria-hidden="true" />
              </Button>
            </span>
          ))}
          <Button variant="ghost" size="xs" onClick={clearAll}>
            {t.clearAll}
          </Button>
          <span className="text-muted-foreground sm:ml-auto">{t.matches(filtered.length, rows.length)}</span>
        </div>
      )}
      {selectable && selectedRows.length > 0 && (
        <div
          role="toolbar"
          aria-label={t.bulk}
          className="flex flex-wrap items-center gap-2 rounded-lg bg-foreground px-3 py-2 text-background"
        >
          <span className="text-sm font-medium">{t.selected(selectedRows.length)}</span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {bulk.map((action) => (
              <Button
                key={action.key}
                className="border-background/30 bg-transparent text-background hover:bg-background/10 hover:text-background dark:border-background/30 dark:bg-transparent dark:hover:bg-background/10"
                variant="outline"
                size="sm"
                disabled={action.disabled?.(selectedRows)}
                onClick={() => action.onClick(selectedRows)}
              >
                {action.label}
              </Button>
            ))}
            <Button
              className="text-background hover:bg-background/10 hover:text-background"
              variant="ghost"
              size="icon-sm"
              aria-label={t.clearSelection}
              onClick={() => setSelected(new Set())}
            >
              <X aria-hidden="true" />
            </Button>
          </div>
        </div>
      )}
      {/* Nền hover của ô ghim: trộn sẵn muted/50 lên card cho giống dòng thường (dòng dùng màu trong suốt). */}
      <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-card [--pin-hover:color-mix(in_oklab,var(--muted)_50%,var(--card))]">
        <Table style={{ minWidth }}>
          {caption && <caption className="sr-only">{caption}</caption>}
          <TableHeader>
            <TableRow>
              {selectable && (
                <TableHead className={cn("w-10 pl-3", pinStart && "sm:sticky left-0 z-10 bg-card")}>
                  <Checkbox
                    aria-label={t.selectPage}
                    checked={allPage}
                    indeterminate={!allPage && somePage}
                    disabled={!result.rows.length}
                    onCheckedChange={(checked) =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        for (const row of result.rows) {
                          if (checked) next.add(row.id);
                          else next.delete(row.id);
                        }
                        return next;
                      })
                    }
                  />
                </TableHead>
              )}
              {visible.map((column) => (
                <TableHead
                  key={column.key}
                  className={cn(
                    "text-xs text-muted-foreground",
                    column.align === "end" && "text-right",
                    pinCell(column.key, true),
                    column.className,
                  )}
                  aria-sort={
                    column.sortable
                      ? sort?.key === column.key
                        ? sort.direction === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                      : undefined
                  }
                >
                  {column.sortable ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className={column.align === "end" ? "-mr-2 text-inherit" : "-ml-2 text-inherit"}
                      onClick={() => {
                        setSort({
                          key: column.key,
                          direction: sort?.key === column.key && sort.direction === "asc" ? "desc" : "asc",
                        });
                        setPage(0);
                      }}
                    >
                      {column.label}
                      {sort?.key === column.key ? (
                        sort.direction === "asc" ? (
                          <ArrowUp aria-hidden="true" />
                        ) : (
                          <ArrowDown aria-hidden="true" />
                        )
                      ) : (
                        <ArrowUpDown aria-hidden="true" />
                      )}
                    </Button>
                  ) : (
                    column.label
                  )}
                </TableHead>
              ))}
              {onRowClick && (
                <TableHead className={pinEnd ? "w-10 min-w-10 bg-card sm:sticky sm:right-0 sm:z-10" : undefined}>
                  <span className="sr-only">{t.open("")}</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.rows.map((row) => (
              <TableRow
                key={row.id}
                data-state={selected.has(row.id) || row.id === activeId ? "selected" : undefined}
                className={onRowClick ? "cursor-pointer" : undefined}
                onClick={
                  onRowClick
                    ? (event) => {
                        const target = event.target as HTMLElement;
                        // Sự kiện React đi qua portal: bấm mục của menu ⋯ (nằm ngoài dòng trong DOM) cũng tới đây.
                        if (!event.currentTarget.contains(target)) return;
                        if (!target.closest("a,button,input,select,textarea,label,[role=checkbox]")) onRowClick(row);
                      }
                    : undefined
                }
              >
                {selectable && (
                  <Td
                    className={cn(
                      "w-10",
                      pinStart &&
                        "sm:sticky left-0 z-10 bg-card [tr:hover>&]:bg-(--pin-hover) [tr[data-state=selected]>&]:bg-muted",
                    )}
                  >
                    <Checkbox
                      aria-label={`${t.select} ${rowLabel(row)}`}
                      checked={selected.has(row.id)}
                      onCheckedChange={(checked) =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (checked) next.add(row.id);
                          else next.delete(row.id);
                          return next;
                        })
                      }
                    />
                  </Td>
                )}
                {visible.map((column) => (
                  <Td
                    key={column.key}
                    className={cn(
                      column.align === "end" && "text-right tabular-nums",
                      pinCell(column.key),
                      column.className,
                    )}
                  >
                    {column.cell ? column.cell(row) : (column.value(row) ?? "—")}
                  </Td>
                ))}
                {onRowClick && (
                  <Td
                    className={
                      pinEnd
                        ? "w-10 min-w-10 px-1.5 bg-card sm:sticky sm:right-0 sm:z-10 [tr:hover>&]:bg-(--pin-hover) [tr[data-state=selected]>&]:bg-muted"
                        : undefined
                    }
                  >
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t.open(rowLabel(row))}
                      onClick={() => onRowClick(row)}
                    >
                      <ChevronRight aria-hidden="true" />
                    </Button>
                  </Td>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {!result.rows.length && (
          <div className="grid justify-items-center gap-3 px-4 py-10 text-center text-muted-foreground">
            {active.length ? (
              <>
                <p>{t.noMatch}</p>
                <Button variant="outline" size="sm" onClick={clearAll}>
                  {t.clearAll}
                </Button>
              </>
            ) : (
              (emptyContent ?? t.noMatch)
            )}
          </div>
        )}
        {serverPaging ? (
          <div className="flex flex-wrap items-center gap-3 border-t border-border px-3 py-2 text-xs">
            <span className="text-muted-foreground" aria-live="polite">
              {serverPaging.label}
            </span>
            <div className="flex gap-1 sm:ml-auto">
              <Button
                variant="outline"
                size="icon-sm"
                aria-label={serverPaging.previousLabel ?? t.previous}
                disabled={!serverPaging.hasPrevious}
                onClick={serverPaging.onPrevious}
              >
                <ChevronLeft aria-hidden="true" />
              </Button>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label={serverPaging.nextLabel ?? t.next}
                disabled={!serverPaging.hasNext}
                onClick={serverPaging.onNext}
              >
                <ChevronRight aria-hidden="true" />
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3 border-t border-border px-3 py-2 text-xs">
            <span className="text-muted-foreground" aria-live="polite">
              {t.range(result.from, result.to, result.total)}
            </span>
            <label htmlFor={sizeId} className="flex items-center gap-2 sm:ml-auto">
              {t.perPage}
              <NativeSelect
                id={sizeId}
                className="w-18"
                size="sm"
                value={size}
                onChange={(event) => {
                  setSize(Number(event.currentTarget.value));
                  setPage(0);
                }}
              >
                {[...new Set([10, 20, 50, 100, pageSize])]
                  .sort((a, b) => a - b)
                  .map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
              </NativeSelect>
            </label>
            <span>{t.page(result.page + 1, result.pages)}</span>
            <div className="flex gap-1">
              <Button
                variant="outline"
                size="icon-sm"
                aria-label={t.previous}
                disabled={result.page === 0}
                onClick={() => setPage(result.page - 1)}
              >
                <ChevronLeft aria-hidden="true" />
              </Button>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label={t.next}
                disabled={result.page === result.pages - 1}
                onClick={() => setPage(result.page + 1)}
              >
                <ChevronRight aria-hidden="true" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function FacetFilter<Row>({
  facet,
  options,
  chosen,
  onChange,
}: {
  facet: Facet<Row>;
  options: { value: string; label: string; count: number }[];
  chosen: readonly string[];
  onChange: (values: string[]) => void;
}) {
  const t = useT(text);
  const [find, setFind] = useState("");
  const optionId = useId();
  return (
    <Popover onOpenChange={() => setFind("")}>
      <PopoverTrigger render={<Button variant="outline" size="sm" className="max-w-full border-dashed" />}>
        <PlusCircle aria-hidden="true" />
        {facet.label}
        {chosen.length > 0 && (
          <span className="rounded bg-secondary px-1.5 text-xs text-secondary-foreground">{chosen.length}</span>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="max-w-[calc(100vw-2rem)] gap-1">
        <PopoverTitle>{facet.label}</PopoverTitle>
        {options.length > 8 && (
          <Input
            aria-label={t.find(facet.label)}
            placeholder={t.find(facet.label)}
            value={find}
            onChange={(event) => setFind(event.currentTarget.value)}
          />
        )}
        <div className="max-h-64 overflow-y-auto p-1">
          {options
            .filter((option) => option.label.toLocaleLowerCase().includes(find.toLocaleLowerCase()))
            .map((option) => (
              <label
                key={option.value}
                htmlFor={`${optionId}-${option.value}`}
                className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-muted"
              >
                <Checkbox
                  id={`${optionId}-${option.value}`}
                  aria-label={option.label}
                  checked={chosen.includes(option.value)}
                  onCheckedChange={(checked) =>
                    onChange(checked ? [...chosen, option.value] : chosen.filter((value) => value !== option.value))
                  }
                />
                <span className="min-w-0 flex-1 break-words">{option.label}</span>
                <span className="font-mono text-xs text-muted-foreground">{option.count}</span>
              </label>
            ))}
        </div>
        {chosen.length > 0 && (
          <Button className="cursor-pointer" variant="ghost" size="sm" onClick={() => onChange([])}>
            {t.clearOne}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
