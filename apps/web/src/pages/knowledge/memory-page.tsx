import { Tabs } from "@base-ui/react/tabs";
import { type UseQueryResult, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { KnowledgeScope, Memory, MemoryKind, MemorySearchHit } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { Table, TableBody, TableHeader, TableRow, Td, Th } from "@xdev-hive/ui/table";
import { Textarea } from "@xdev-hive/ui/textarea";
import { ChevronLeftIcon, ChevronRightIcon, PlusIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";
import { FilterBar, FilterSearch } from "@/components/page/filter-bar.tsx";
import { SegmentedControl } from "@/components/page/segmented-control.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { Field, FieldLabel } from "@/components/ui/field.tsx";
import { EmptyState, LoadFailure, SectionsSkeleton, TableSkeleton } from "@/components/ui/query-state.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { useT } from "@/lib/i18n.ts";
import { useKnowledgeAccess } from "@/lib/knowledge.ts";
import { shortId } from "@/lib/run-view.ts";
import {
  authorLabel,
  DetailDialog,
  EmptyRows,
  PAGE_SIZE,
  ScopeBadge,
  useTabParam,
  When,
} from "@/pages/knowledge/common.tsx";
import { knowledgeText } from "@/pages/knowledge/text.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader, PageTab, PageTabList } from "@/shell/page-header.tsx";

const text = knowledgeText;
const kinds: MemoryKind[] = ["decision", "convention", "gotcha", "note"];
const TABS = ["cho-duyet"] as const;
type Row = Memory | MemorySearchHit;

export function MemoryPage() {
  const { org } = useOrg();
  return <MemoryScreen key={org.id} />;
}
function MemoryScreen() {
  const t = useT(text);
  const { api } = useOrg();
  const access = useKnowledgeAccess();
  const [tab, setTab] = useTabParam(TABS);
  const [editing, setEditing] = useState<Memory | "new">();
  const pendingList = useQuery(api.memory.list.queryOptions({ input: { status: "pending", limit: 200 } }));
  return (
    <>
      <PageHeader title="Memory" description={t.memoryLead}>
        {access.scopes.length > 0 && (
          <Button onClick={() => setEditing("new")}>
            <PlusIcon aria-hidden="true" />
            {t.memoryAdd}
          </Button>
        )}
      </PageHeader>
      <Tabs.Root
        value={tab ?? "da-duyet"}
        onValueChange={(value) => setTab(value === "da-duyet" ? undefined : "cho-duyet")}
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
            <ApprovedMemories onReplace={setEditing} />
          </PageBody>
        </Tabs.Panel>
      </Tabs.Root>
      {editing && (
        <MemoryEditor
          key={editing === "new" ? "new" : editing.id}
          memory={editing === "new" ? undefined : editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => setEditing(undefined)}
        />
      )}
    </>
  );
}

/**
 * Một ô tìm duy nhất: gõ rồi Enter hay "Tìm" thì hub tìm theo từ và theo nghĩa trên toàn bộ memory; ô trống là danh sách
 * phân trang. DataTable có ô lọc cục bộ riêng nên không dùng ở đây, để người dùng không phải đoán ô nào tìm gì.
 */
function ApprovedMemories({ onReplace }: { onReplace: (memory: Memory) => void }) {
  const t = useT(text);
  const fieldId = useId();
  const { api } = useOrg();
  const access = useKnowledgeAccess();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [includeOld, setIncludeOld] = useState(false);
  const [kind, setKind] = useState<MemoryKind | "all">("all");
  const [selected, setSelected] = useState<Memory>();
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
  const submit = (value: string) => {
    setQuery(value.trim());
    setSelected(undefined);
  };
  return (
    <>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit(search);
        }}
      >
        <FilterBar label={t.memoryFilters}>
          <FilterSearch value={search} onChange={setSearch} placeholder={t.searchMemory} className="sm:w-80" />
          <Button type="submit" variant="outline" size="sm">
            {t.search}
          </Button>
          <SegmentedControl
            label={t.kind}
            value={kind}
            onChange={setKind}
            options={[{ value: "all", label: t.all }, ...kinds.map((value) => ({ value, label: t[value] }))]}
          />
          <label
            htmlFor={`${fieldId}-old`}
            className="flex items-center gap-2 text-sm whitespace-nowrap sm:ml-auto"
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
        </FilterBar>
      </form>
      {searching && (
        <div role="status" className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">{t.searching}</span>
          <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-accent py-0.5 pr-1 pl-2.5 text-accent-foreground">
            <span className="min-w-0 break-words">{query}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t.clearSearch}
              onClick={() => {
                setSearch("");
                submit("");
              }}
            >
              <XIcon aria-hidden="true" />
            </Button>
          </span>
        </div>
      )}
      {active.isPending && <TableSkeleton label={t.loading} columns={5} />}
      {active.isError && <LoadFailure error={active.error} retry={active.refetch} />}
      {active.data && (
        <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
          <Table style={{ minWidth: searching ? 760 : 620 }}>
            <TableHeader>
              <TableRow>
                <Th variant="plain">{t.content}</Th>
                <Th variant="plain">{t.scope}</Th>
                <Th variant="plain">{t.author}</Th>
                {searching && (
                  <>
                    <Th variant="plain" className="text-right">
                      {t.score}
                    </Th>
                    <Th variant="plain">{t.matchedBy}</Th>
                  </>
                )}
                <Th variant="plain">{t.updated}</Th>
                <Th variant="plain" className="w-10 min-w-10">
                  <span className="sr-only">{t.open}</span>
                </Th>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.id === selected?.id ? "selected" : undefined}
                  className="cursor-pointer"
                  onClick={(event) => {
                    if (!(event.target as HTMLElement).closest("a,button")) setSelected(row);
                  }}
                >
                  <Td className="max-w-md">
                    <div className="mb-1 flex flex-wrap items-center gap-1.5">
                      <KindPill kind={row.kind} />
                      {row.supersededBy && <Pill>{t.superseded}</Pill>}
                    </div>
                    <p className="line-clamp-3 break-words whitespace-pre-wrap">{row.content}</p>
                  </Td>
                  <Td>
                    <ScopeBadge scope={row.scope} />
                  </Td>
                  <Td className="max-w-40 text-xs break-all text-muted-foreground">{authorLabel(row.author)}</Td>
                  {searching && (
                    <>
                      <Td className="text-right tabular-nums">{"score" in row ? row.score.toFixed(2) : "—"}</Td>
                      <Td className="text-xs text-muted-foreground">
                        {"matchedBy" in row ? row.matchedBy.map((mode) => t[mode]).join(", ") : "—"}
                      </Td>
                    </>
                  )}
                  <Td className="text-xs whitespace-nowrap text-muted-foreground">
                    <When iso={row.createdAt} />
                  </Td>
                  <Td className="w-10 px-1.5">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${t.openRow} ${row.content.slice(0, 60)}`}
                      onClick={() => setSelected(row)}
                    >
                      <ChevronRightIcon aria-hidden="true" />
                    </Button>
                  </Td>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {rows.length === 0 && (
            <div className="grid justify-items-center gap-3 px-4 py-10 text-center text-muted-foreground">
              {searching || kind !== "all" ? (
                <EmptyRows title={t.noResults} description={t.noResultsHint} />
              ) : (
                <EmptyRows title={t.memoryEmptyTitle} description={t.memoryEmptyBody} />
              )}
            </div>
          )}
          {!searching && (
            <div className="flex flex-wrap items-center gap-3 border-t border-border px-3 py-2 text-xs">
              <span className="text-muted-foreground" aria-live="polite">
                {active.data.length === 0 ? t.noRows : t.rows(offset + 1, offset + active.data.length)}
              </span>
              <div className="flex gap-1 sm:ml-auto">
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label={t.previousPage}
                  disabled={offset === 0}
                  onClick={() => {
                    setOffset(Math.max(0, offset - PAGE_SIZE));
                    setSelected(undefined);
                  }}
                >
                  <ChevronLeftIcon aria-hidden="true" />
                </Button>
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label={t.nextPage}
                  disabled={active.data.length < PAGE_SIZE}
                  onClick={() => {
                    setOffset(offset + PAGE_SIZE);
                    setSelected(undefined);
                  }}
                >
                  <ChevronRightIcon aria-hidden="true" />
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
      {selected && (
        <DetailDialog
          title={t[selected.kind]}
          mono={false}
          onClose={() => setSelected(undefined)}
          badges={<ScopeBadge scope={selected.scope} />}
          description={`${authorLabel(selected.author)} · ${new Date(selected.createdAt).toLocaleDateString()}`}
          footer={
            !selected.supersededBy &&
            access.allowed(selected.scope, "write") && (
              <Button
                className="justify-self-end"
                variant="outline"
                onClick={() => {
                  onReplace(selected);
                  setSelected(undefined);
                }}
              >
                {t.replace}
              </Button>
            )
          }
        >
          <p className="whitespace-pre-wrap break-words">{selected.content}</p>
          {selected.files.length > 0 && (
            <ul className="grid gap-1">
              {selected.files.map((file) => (
                <li key={file}>
                  <code className="text-xs break-all">{file}</code>
                </li>
              ))}
            </ul>
          )}
          {selected.supersededBy && (
            <p className="break-all text-sm text-muted-foreground">
              {t.superseded}: {selected.supersededBy}
            </p>
          )}
        </DetailDialog>
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
              <p className="whitespace-pre-wrap break-words">{memory.content}</p>
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
  onSaved: () => void;
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
              if (memory) {
                if (!access.allowed(memory.scope, "write")) return;
                await supersede.mutateAsync({ id: memory.id, ...input });
              } else if (selectedScope) {
                const scope: KnowledgeScope =
                  selectedScope.level === "org"
                    ? { level: "org" }
                    : selectedScope.level === "team"
                      ? { level: "team", teamId: selectedScope.teamId ?? "" }
                      : { level: "project", projectId: selectedScope.projectId ?? "" };
                await write.mutateAsync({ scope, ...input });
              } else return;
              await cache.invalidateQueries({ queryKey: api.memory.key() });
              onSaved();
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
