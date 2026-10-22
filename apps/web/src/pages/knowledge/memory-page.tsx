import { Tabs } from "@base-ui/react/tabs";
import { type UseQueryResult, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { KnowledgeScope, Memory, MemoryKind, MemorySearchHit } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { Textarea } from "@xdev-hive/ui/textarea";
import { PinIcon, PlusIcon } from "lucide-react";
import { useId, useState } from "react";
import { type Column, DataTable } from "@/components/data-table/data-table.tsx";
import { PageSection } from "@/components/page/page-section.tsx";
import { SegmentedControl } from "@/components/page/segmented-control.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { Field, FieldLabel } from "@/components/ui/field.tsx";
import { EmptyState, LoadFailure, SectionsSkeleton, TableSkeleton } from "@/components/ui/query-state.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { cx } from "@/lib/cx.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { useKnowledgeAccess } from "@/lib/knowledge.ts";
import { shortId } from "@/lib/run-view.ts";
import {
  authorLabel,
  DetailFallback,
  EmptyRows,
  offsetPaging,
  PAGE_SIZE,
  ScopeBadge,
  useRowById,
  When,
} from "@/pages/knowledge/common.tsx";
import { knowledgeText } from "@/pages/knowledge/text.ts";
import { useOrg } from "@/shell/org-context.ts";
import { DetailHeader, PageBody, PageHeader, PageTab, PageTabList } from "@/shell/page-header.tsx";

const text = knowledgeText;
// Chữ của nút ghim đặt tại đây vì từ điển chung của trang kiến thức thuộc file khác.
const pinText: Dict<{ pin: string; unpin: string; pinned: string; pinColumn: string }> = {
  vi: { pin: "Ghim", unpin: "Bỏ ghim", pinned: "Đã ghim", pinColumn: "Ghim" },
  en: { pin: "Pin", unpin: "Unpin", pinned: "Pinned", pinColumn: "Pin" },
};
const kinds: MemoryKind[] = ["decision", "convention", "gotcha", "note"];
type Row = Memory | MemorySearchHit;

export function MemoryPage() {
  const { org } = useOrg();
  return <MemoryScreen key={org.id} />;
}
function MemoryScreen() {
  const t = useT(text);
  const { api } = useOrg();
  const access = useKnowledgeAccess();
  const navigate = useNavigate();
  const { tab = "da-duyet" } = useSearch({ from: "/session/app/in-org/knowledge/memory" });
  const [adding, setAdding] = useState(false);
  const pendingList = useQuery(api.memory.list.queryOptions({ input: { status: "pending", limit: 200 } }));
  return (
    <>
      <PageHeader title="Memory" description={t.memoryLead}>
        {access.scopes.length > 0 && (
          <Button onClick={() => setAdding(true)}>
            <PlusIcon aria-hidden="true" />
            {t.memoryAdd}
          </Button>
        )}
      </PageHeader>
      <Tabs.Root
        value={tab}
        onValueChange={(value) =>
          navigate({
            to: "/knowledge/memory",
            search: value === "cho-duyet" ? { tab: "cho-duyet" } : {},
            replace: true,
          })
        }
      >
        <PageTabList label={t.memoryViews}>
          <PageTab value="da-duyet">{t.approved}</PageTab>
          <PageTab value="cho-duyet" count={pendingList.data?.length} tone="warning">
            {t.pending}
          </PageTab>
        </PageTabList>
        <Tabs.Panel value="cho-duyet">
          <PageBody>
            <PendingMemories list={pendingList} />
          </PageBody>
        </Tabs.Panel>
        <Tabs.Panel value="da-duyet">
          <PageBody>
            <ApprovedMemories />
          </PageBody>
        </Tabs.Panel>
      </Tabs.Root>
      {adding && <MemoryEditor onClose={() => setAdding(false)} onSaved={() => setAdding(false)} />}
    </>
  );
}

/**
 * Một ô tìm duy nhất, của trang: gõ rồi Enter hay "Tìm" thì hub tìm theo từ và theo nghĩa trên toàn bộ memory; ô trống
 * là danh sách phân trang. Bảng không lọc chữ cục bộ, để người dùng không phải đoán ô nào tìm gì.
 */
function ApprovedMemories() {
  const t = useT(text);
  const p = useT(pinText);
  const fieldId = useId();
  const { api } = useOrg();
  const cache = useQueryClient();
  const access = useKnowledgeAccess();
  const navigate = useNavigate();
  const pin = useMutation(api.memory.pin.mutationOptions());
  const togglePin = async (row: Row) => {
    try {
      await pin.mutateAsync({ id: row.id, pinned: !row.pinned });
      await cache.invalidateQueries({ queryKey: api.memory.key() });
    } catch {
      /* Lỗi hiện phía trên bảng; mục giữ nguyên trạng thái cũ để thử lại. */
    }
  };
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [includeOld, setIncludeOld] = useState(false);
  const [kind, setKind] = useState<MemoryKind | "all">("all");
  const list = useQuery(
    api.memory.list.queryOptions({ input: { limit: PAGE_SIZE, offset, includeSuperseded: includeOld } }),
  );
  const results = useQuery({
    ...api.memory.search.queryOptions({ input: { query, limit: PAGE_SIZE } }),
    enabled: !!query,
  });
  const active = query ? results : list;
  const rows: Row[] = (active.data ?? []).filter((row) => kind === "all" || row.kind === kind);
  const searching = !!query;
  const clearSearch = () => {
    setSearch("");
    setQuery("");
  };
  const columns: Column<Row>[] = [
    {
      key: "content",
      label: t.content,
      value: (row) => row.content,
      pin: "start",
      className: "max-w-md",
      cell: (row) => (
        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            {row.pinned && (
              <span role="img" aria-label={p.pinned} title={p.pinned} className="text-primary">
                <PinIcon aria-hidden="true" className="size-3.5" />
              </span>
            )}
            <KindPill kind={row.kind} />
            {row.supersededBy && <Pill>{t.superseded}</Pill>}
          </div>
          <p className="line-clamp-3 break-words whitespace-pre-wrap">{row.content}</p>
        </div>
      ),
    },
    {
      key: "scope",
      label: t.scope,
      value: (row) => t[row.scope.level],
      cell: (row) => <ScopeBadge scope={row.scope} />,
    },
    {
      key: "author",
      label: t.author,
      value: (row) => authorLabel(row.author),
      cell: (row) => <span className="text-xs break-all text-muted-foreground">{authorLabel(row.author)}</span>,
    },
    ...(searching
      ? ([
          {
            key: "score",
            label: t.score,
            value: (row) => ("score" in row ? row.score : 0),
            sortable: true,
            align: "end",
            cell: (row) => ("score" in row ? row.score.toFixed(2) : "—"),
          },
          {
            key: "matchedBy",
            label: t.matchedBy,
            value: (row) => ("matchedBy" in row ? row.matchedBy.map((mode) => t[mode]).join(", ") : "—"),
          },
        ] satisfies Column<Row>[])
      : []),
    {
      key: "updated",
      label: t.updated,
      value: (row) => row.createdAt,
      sortable: true,
      cell: (row) => <When iso={row.createdAt} />,
    },
    {
      key: "pin",
      label: p.pinColumn,
      value: (row) => (row.pinned ? 1 : 0),
      cell: (row) =>
        row.status === "approved" && !row.supersededBy && access.allowed(row.scope, "write") ? (
          <Button
            size="sm"
            variant="outline"
            disabled={pin.isPending}
            aria-label={`${row.pinned ? p.unpin : p.pin}: ${row.content.slice(0, 60)}`}
            onClick={() => togglePin(row)}
          >
            {row.pinned ? p.unpin : p.pin}
          </Button>
        ) : null,
    },
  ];
  return (
    <>
      {pin.error && <Alert variant="destructive">{apiErrorMessage(pin.error)}</Alert>}
      {active.isPending && <TableSkeleton label={t.loading} columns={5} />}
      {active.isError && <LoadFailure error={active.error} retry={active.refetch} />}
      {active.data && (
        <DataTable
          // Đổi giữa danh sách và kết quả tìm thì bộ cột đổi; dựng lại bảng để thứ tự sắp và cột ẩn không lệch.
          key={searching ? "search" : "list"}
          columns={columns}
          rows={rows}
          minWidth={searching ? 760 : 620}
          search={{ value: search, onChange: setSearch, placeholder: t.searchMemory, onSubmit: setQuery }}
          filters={
            <>
              <SegmentedControl
                label={t.kind}
                value={kind}
                onChange={setKind}
                options={[{ value: "all", label: t.all }, ...kinds.map((value) => ({ value, label: t[value] }))]}
              />
              <label
                htmlFor={`${fieldId}-old`}
                className={cx("flex items-center gap-2 text-sm whitespace-nowrap", searching && "opacity-60")}
                title={searching ? t.includeOldSearch : undefined}
              >
                <Checkbox
                  id={`${fieldId}-old`}
                  checked={includeOld}
                  disabled={searching}
                  onCheckedChange={(checked) => {
                    setIncludeOld(checked);
                    setOffset(0);
                  }}
                />
                {t.includeOld}
              </label>
            </>
          }
          activeFilters={searching ? [{ key: "query", label: t.search, values: query, clear: clearSearch }] : []}
          rowLabel={(row) => row.content.slice(0, 60)}
          onRowClick={(row) => navigate({ to: "/knowledge/memory/$memoryId", params: { memoryId: row.id } })}
          emptyContent={
            searching || kind !== "all" ? (
              <EmptyRows title={t.noResults} description={t.noResultsHint} />
            ) : (
              <EmptyRows title={t.memoryEmptyTitle} description={t.memoryEmptyBody} />
            )
          }
          {...(searching ? {} : { serverPaging: offsetPaging(t, offset, active.data.length, setOffset) })}
        />
      )}
    </>
  );
}

export function MemoryDetailPage() {
  const { org } = useOrg();
  const { memoryId } = useParams({ from: "/session/app/in-org/knowledge/memory/$memoryId" });
  return <MemoryDetailScreen key={`${org.id}:${memoryId}`} id={memoryId} />;
}

function MemoryDetailScreen({ id }: { id: string }) {
  const t = useT(text);
  const { api } = useOrg();
  const navigate = useNavigate();
  const access = useKnowledgeAccess();
  const cache = useQueryClient();
  const [replacing, setReplacing] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const decision = useMutation({
    mutationFn: async (action: "approve" | "reject") => {
      await (action === "approve" ? api.memory.approve : api.memory.reject).call({ id });
      await cache.invalidateQueries({ queryKey: api.memory.key() });
      return action;
    },
    // Bỏ thì memory không còn: về hàng chờ. Duyệt thì ở lại, trạng thái đổi sau khi tải lại.
    onSuccess: (action) => {
      if (action === "reject") void navigate({ to: "/knowledge/memory", search: { tab: "cho-duyet" } });
    },
    onSettled: () => setDiscarding(false),
  });
  const found = useRowById<Memory>(api.memory.key(), id, [
    (page) => api.memory.list.call({ ...page, includeSuperseded: true }),
    (page) => api.memory.list.call({ ...page, status: "pending" }),
  ]);
  const memory = found.data;
  if (!memory) return <DetailFallback query={found} title="Memory" back="/knowledge/memory" />;
  const canReplace = memory.status === "approved" && !memory.supersededBy && access.allowed(memory.scope, "write");
  const canDecide = memory.status === "pending" && access.allowed(memory.scope, "write");
  return (
    <>
      <DetailHeader
        back={{ to: "/knowledge/memory", label: "Memory" }}
        title={t.memoryOf(t[memory.kind])}
        status={
          memory.supersededBy ? (
            <Pill>{t.superseded}</Pill>
          ) : memory.status === "pending" ? (
            <Pill tone="warn" dot>
              {t.pending}
            </Pill>
          ) : (
            <Pill tone="ok" dot>
              {t.current}
            </Pill>
          )
        }
        meta={
          <>
            <ScopeBadge scope={memory.scope} />
            <KindPill kind={memory.kind} />
            {memory.author.runId ? (
              <Link to="/runs/$id" params={{ id: memory.author.runId }} className="text-primary hover:text-primary/90">
                {t.byRun} <span className="font-mono">{shortId(memory.author.runId)}</span>
              </Link>
            ) : (
              <span>{authorLabel(memory.author)}</span>
            )}
            <When iso={memory.createdAt} />
          </>
        }
      >
        {canReplace && (
          <Button variant="outline" onClick={() => setReplacing(true)}>
            {t.replace}
          </Button>
        )}
        {canDecide && (
          <>
            <Button variant="outline" disabled={decision.isPending} onClick={() => setDiscarding(true)}>
              {t.memoryDiscard}
            </Button>
            <Button disabled={decision.isPending} onClick={() => decision.mutate("approve")}>
              {t.approve}
            </Button>
          </>
        )}
      </DetailHeader>
      <PageBody width="wide">
        {memory.status === "pending" && <p className="text-sm text-muted-foreground">{t.pendingHint}</p>}
        {decision.error && <Alert variant="destructive">{apiErrorMessage(decision.error)}</Alert>}
        <PageSection title={t.content}>
          <p className="whitespace-pre-wrap break-words">{memory.content}</p>
        </PageSection>
        {memory.files.length > 0 && (
          <PageSection title={t.filesTitle}>
            <ul className="grid gap-1">
              {memory.files.map((file) => (
                <li key={file}>
                  <code className="text-xs break-all">{file}</code>
                </li>
              ))}
            </ul>
          </PageSection>
        )}
        {memory.supersededBy && (
          <p className="text-sm text-muted-foreground">
            {t.supersededBy}{" "}
            <Link
              to="/knowledge/memory/$memoryId"
              params={{ memoryId: memory.supersededBy }}
              className="font-mono break-all text-primary hover:text-primary/90"
            >
              {shortId(memory.supersededBy)}
            </Link>
          </p>
        )}
      </PageBody>
      <Dialog open={discarding} onOpenChange={(open) => !open && !decision.isPending && setDiscarding(false)}>
        <DialogContent showCloseButton={false}>
          <DialogTitle>{t.discardTitle}</DialogTitle>
          <DialogDescription className="line-clamp-4 whitespace-pre-wrap">{memory.content}</DialogDescription>
          <DialogActions>
            <Button variant="outline" disabled={decision.isPending} onClick={() => setDiscarding(false)}>
              {t.keep}
            </Button>
            <Button variant="destructive-solid" disabled={decision.isPending} onClick={() => decision.mutate("reject")}>
              {t.discardConfirm}
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
      {replacing && (
        <MemoryEditor
          memory={memory}
          onClose={() => setReplacing(false)}
          onSaved={(next) => {
            setReplacing(false);
            void navigate({ to: "/knowledge/memory/$memoryId", params: { memoryId: next.id } });
          }}
        />
      )}
    </>
  );
}

function KindPill({ kind }: { kind: MemoryKind }) {
  const t = useT(text);
  return <Pill tone={kind === "gotcha" ? "warn" : kind === "convention" ? "ok" : "sel"}>{t[kind]}</Pill>;
}

function PendingMemories({ list }: { list: UseQueryResult<Memory[]> }) {
  const t = useT(text);
  const { api } = useOrg();
  const cache = useQueryClient();
  const access = useKnowledgeAccess();
  const approve = useMutation(api.memory.approve.mutationOptions());
  const reject = useMutation(api.memory.reject.mutationOptions());
  const [discarding, setDiscarding] = useState<Memory>();
  const busy = approve.isPending || reject.isPending;
  const decide = async (decision: "approve" | "reject", id: string) => {
    try {
      await (decision === "approve" ? approve : reject).mutateAsync({ id });
      await cache.invalidateQueries({ queryKey: api.memory.key() });
    } catch {
      /* Lỗi hiện ngay trên danh sách; hàng vẫn ở đó để thử lại. */
    } finally {
      setDiscarding(undefined);
    }
  };
  return (
    <>
      <p className="text-sm text-muted-foreground">{t.pendingHint}</p>
      {list.isPending && <SectionsSkeleton sections={2} label={t.loading} />}
      {list.isError && <LoadFailure error={list.error} retry={list.refetch} />}
      {(approve.error || reject.error) && (
        <Alert variant="destructive">{apiErrorMessage(approve.error ?? reject.error)}</Alert>
      )}
      {list.data?.length === 0 && <EmptyState compact title={t.pendingEmpty} description={t.pendingEmptyHint} />}
      {list.data && list.data.length > 0 && (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {list.data.map((memory) => (
            <li key={memory.id} className="grid gap-2 p-4">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <KindPill kind={memory.kind} />
                <ScopeBadge scope={memory.scope} />
                {memory.author.runId ? (
                  <Link
                    to="/runs/$id"
                    params={{ id: memory.author.runId }}
                    className="text-primary hover:text-primary/90"
                  >
                    {t.byRun} <span className="font-mono">{shortId(memory.author.runId)}</span>
                  </Link>
                ) : (
                  <span className="text-muted-foreground">{authorLabel(memory.author)}</span>
                )}
                <span className="text-muted-foreground sm:ml-auto">
                  <When iso={memory.createdAt} />
                </span>
              </div>
              <Link
                to="/knowledge/memory/$memoryId"
                params={{ memoryId: memory.id }}
                className="whitespace-pre-wrap break-words hover:text-primary"
              >
                {memory.content}
              </Link>
              {memory.files.length > 0 && <code className="break-all text-xs">{memory.files.join(", ")}</code>}
              {access.allowed(memory.scope, "write") && (
                <div className="flex gap-2">
                  <Button size="sm" disabled={busy} onClick={() => decide("approve", memory.id)}>
                    {t.approve}
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => setDiscarding(memory)}>
                    {t.memoryDiscard}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <Dialog open={!!discarding} onOpenChange={(open) => !open && !busy && setDiscarding(undefined)}>
        <DialogContent showCloseButton={false}>
          <DialogTitle>{t.discardTitle}</DialogTitle>
          <DialogDescription className="line-clamp-4 whitespace-pre-wrap">{discarding?.content}</DialogDescription>
          <DialogActions>
            <Button variant="outline" disabled={busy} onClick={() => setDiscarding(undefined)}>
              {t.keep}
            </Button>
            <Button
              variant="destructive-solid"
              disabled={busy}
              onClick={() => discarding && decide("reject", discarding.id)}
            >
              {t.discardConfirm}
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </>
  );
}
function MemoryEditor({
  memory,
  onClose,
  onSaved,
}: {
  memory?: Memory | undefined;
  onClose: () => void;
  onSaved: (memory: Memory) => void;
}) {
  const t = useT(text);
  const fieldId = useId();
  const { api } = useOrg();
  const cache = useQueryClient();
  const access = useKnowledgeAccess();
  const [scopeValue, setScopeValue] = useState(access.scopes[0]?.value ?? "");
  const [kind, setKind] = useState<MemoryKind>(memory?.kind ?? "note");
  const [content, setContent] = useState(memory?.content ?? "");
  const [files, setFiles] = useState(memory?.files.join("\n") ?? "");
  const write = useMutation(api.memory.write.mutationOptions());
  const supersede = useMutation(api.memory.supersede.mutationOptions());
  const pending = write.isPending || supersede.isPending;
  const selectedScope = access.scopes.find((item) => item.value === scopeValue)?.scope;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto overscroll-contain" showCloseButton={false}>
        <DialogTitle>{memory ? t.replace : t.memoryAdd}</DialogTitle>
        <form
          className="grid gap-3"
          onSubmit={async (event) => {
            event.preventDefault();
            const input = {
              kind,
              content: content.trim(),
              files: files
                .split("\n")
                .map((file) => file.trim())
                .filter(Boolean),
            };
            if (pending) return;
            try {
              let saved: Memory;
              if (memory) {
                if (!access.allowed(memory.scope, "write")) return;
                saved = await supersede.mutateAsync({ id: memory.id, ...input });
              } else if (selectedScope) {
                const scope: KnowledgeScope =
                  selectedScope.level === "org"
                    ? { level: "org" }
                    : selectedScope.level === "team"
                      ? { level: "team", teamId: selectedScope.teamId ?? "" }
                      : { level: "project", projectId: selectedScope.projectId ?? "" };
                saved = await write.mutateAsync({ scope, ...input });
              } else return;
              await cache.invalidateQueries({ queryKey: api.memory.key() });
              onSaved(saved);
            } catch {
              /* The mutation error remains visible next to the input. */
            }
          }}
        >
          {!memory && (
            <Field>
              <FieldLabel htmlFor={`${fieldId}-2`}>{t.scope}</FieldLabel>
              <NativeSelect
                id={`${fieldId}-2`}
                required
                value={scopeValue}
                onChange={(event) => setScopeValue(event.currentTarget.value)}
              >
                {access.scopes.map((item) => (
                  <option key={item.value} value={item.value}>
                    {t[item.scope.level]} · {item.label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          )}
          <Field>
            <FieldLabel htmlFor={`${fieldId}-3`}>{t.kind}</FieldLabel>
            <NativeSelect
              id={`${fieldId}-3`}
              value={kind}
              onChange={(event) => setKind(event.currentTarget.value as MemoryKind)}
            >
              {kinds.map((value) => (
                <option key={value} value={value}>
                  {t[value]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${fieldId}-4`}>{t.content}</FieldLabel>
            <Textarea
              id={`${fieldId}-4`}
              required
              maxLength={2000}
              rows={6}
              value={content}
              onChange={(event) => setContent(event.currentTarget.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${fieldId}-5`}>{t.files}</FieldLabel>
            <Textarea
              id={`${fieldId}-5`}
              rows={3}
              placeholder="src/money.ts"
              value={files}
              onChange={(event) => setFiles(event.currentTarget.value)}
            />
          </Field>
          {(write.error || supersede.error) && (
            <Alert variant="destructive">{apiErrorMessage(write.error ?? supersede.error)}</Alert>
          )}
          <DialogActions>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              {t.cancel}
            </Button>
            <Button type="submit" disabled={pending || !content.trim() || (!memory && !selectedScope)}>
              {pending ? t.saving : t.save}
            </Button>
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}
