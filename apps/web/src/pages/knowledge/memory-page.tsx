import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { KnowledgeScope, Memory, MemoryKind, MemorySearchHit } from "@xdev-hive/contracts";
import { useId, useState } from "react";
import { type Column, DataTable } from "../../components/data-table/data-table.tsx";
import { Alert } from "../../components/ui/alert.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Checkbox } from "../../components/ui/checkbox.tsx";
import { Dialog, DialogContent, DialogTitle } from "../../components/ui/dialog.tsx";
import { Input } from "../../components/ui/input.tsx";
import { NativeSelect } from "../../components/ui/native-select.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { apiErrorMessage } from "../../lib/api-errors.ts";
import { useT } from "../../lib/i18n.ts";
import { useKnowledgeAccess } from "../../lib/knowledge.ts";
import { useOrg } from "../../shell/org-context.ts";
import { authorLabel, DataPages, DetailCard, KnowledgeLayout, QueryState, ScopeBadge } from "./common.tsx";
import { knowledgeText } from "./text.ts";

const text = knowledgeText;
const kinds: MemoryKind[] = ["decision", "convention", "gotcha", "note"];
export function MemoryPage() {
  const { org } = useOrg();
  return <MemoryScreen key={org.id} />;
}
function MemoryScreen() {
  const t = useT(text);
  const fieldId = useId();
  const { api } = useOrg();
  const access = useKnowledgeAccess();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [includeOld, setIncludeOld] = useState(false);
  const [selected, setSelected] = useState<Memory>();
  const [editing, setEditing] = useState<Memory | "new">();
  const list = useQuery(api.memory.list.queryOptions({ input: { limit: 50, offset, includeSuperseded: includeOld } }));
  const results = useQuery({ ...api.memory.search.queryOptions({ input: { query, limit: 50 } }), enabled: !!query });
  const active = query ? results : list;
  const rows = active.data ?? [];
  const columns: Column<Memory | MemorySearchHit>[] = [
    {
      key: "kind",
      label: t.kind,
      value: (row) => t[row.kind],
      cell: (row) => (
        <span
          className={`rounded-full px-2 py-1 text-xs ${row.kind === "gotcha" ? "bg-warning-soft text-warning" : row.kind === "convention" ? "bg-success-soft text-success" : "bg-accent text-accent-foreground"}`}
        >
          {t[row.kind]}
        </span>
      ),
    },
    {
      key: "content",
      label: t.content,
      value: (row) => row.content,
      cell: (row) => <p className="max-w-md whitespace-pre-wrap break-words">{row.content}</p>,
    },
    {
      key: "files",
      label: "Files",
      value: (row) => row.files.join(" "),
      cell: (row) => <code className="text-xs">{row.files.join(", ") || "—"}</code>,
    },
    {
      key: "scope",
      label: t.scope,
      value: (row) => t[row.scope.level],
      cell: (row) => <ScopeBadge scope={row.scope} />,
    },
    { key: "author", label: t.author, value: (row) => authorLabel(row.author) },
    { key: "status", label: t.status, value: (row) => (row.supersededBy ? t.superseded : t.current) },
    {
      key: "score",
      label: t.score,
      value: (row) => ("score" in row ? row.score : null),
      sortable: true,
      hidden: !query,
    },
    {
      key: "matchedBy",
      label: t.matchedBy,
      value: (row) => ("matchedBy" in row ? row.matchedBy.map((mode) => t[mode]).join(", ") : null),
      hidden: !query,
    },
    { key: "created", label: t.updated, value: (row) => row.createdAt, sortable: true },
  ];
  return (
    <KnowledgeLayout
      title="Memory"
      lead={t.memoryLead}
      actions={access.scopes.length > 0 && <Button onClick={() => setEditing("new")}>{t.memoryAdd}</Button>}
    >
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(search.trim());
          setSelected(undefined);
        }}
      >
        <Input
          aria-label={t.searchMemory}
          placeholder={t.searchMemory}
          className="min-w-0 flex-1"
          maxLength={500}
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
        />
        <Button type="submit">{t.search}</Button>
      </form>
      <label htmlFor={`${fieldId}-1`} className="flex items-center gap-2 text-sm">
        <Checkbox
          id={`${fieldId}-1`}
          checked={includeOld}
          disabled={!!query}
          onCheckedChange={(checked) => {
            setIncludeOld(checked);
            setOffset(0);
          }}
        />
        {t.includeOld}
      </label>
      <section aria-label={t.pageNote} className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {kinds.map((kind) => (
          <DetailCard key={kind}>
            <span className="text-muted-foreground">{t[kind]}</span>
            <strong className="font-mono text-2xl">{rows.filter((row) => row.kind === kind).length}</strong>
          </DetailCard>
        ))}
      </section>
      <QueryState query={active} />
      {active.data && (
        <DataTable
          key={query ? "search" : "list"}
          columns={columns}
          rows={rows}
          selectable={false}
          placeholder={t.content}
          facets={[
            { key: "kind", label: t.kind, value: (row) => t[row.kind] },
            { key: "scope", label: t.scope, value: (row) => t[row.scope.level] },
          ]}
          onRowClick={setSelected}
          rowLabel={(row) => row.content.slice(0, 60)}
          activeId={selected?.id ?? ""}
          emptyContent={t.empty}
        />
      )}
      {!query && (
        <DataPages
          offset={offset}
          count={rows.length}
          onChange={(value) => {
            setOffset(value);
            setSelected(undefined);
          }}
        />
      )}
      {selected && (
        <DetailCard>
          <ScopeBadge scope={selected.scope} />
          <p className="whitespace-pre-wrap break-words">{selected.content}</p>
          {selected.files.map((file) => (
            <code key={file} className="break-all text-xs">
              {file}
            </code>
          ))}
          {selected.supersededBy ? (
            <p className="break-all text-muted-foreground">
              {t.superseded}: {selected.supersededBy}
            </p>
          ) : (
            access.allowed(selected.scope, "write") && (
              <Button className="self-start" variant="outline" onClick={() => setEditing(selected)}>
                {t.replace}
              </Button>
            )
          )}
        </DetailCard>
      )}
      {editing && (
        <MemoryEditor
          key={editing === "new" ? "new" : editing.id}
          memory={editing === "new" ? undefined : editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            setSelected(undefined);
          }}
        />
      )}
    </KnowledgeLayout>
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
      <DialogContent className="max-h-[90dvh] overflow-y-auto" showCloseButton={false}>
        <DialogTitle>{memory ? t.replace : t.memoryAdd}</DialogTitle>
        <form
          className="space-y-3"
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
            <label htmlFor={`${fieldId}-2`} className="block space-y-1">
              <span>{t.scope}</span>
              <NativeSelect
                aria-label={t.scope}
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
            </label>
          )}
          <label htmlFor={`${fieldId}-3`} className="block space-y-1">
            <span>{t.kind}</span>
            <NativeSelect
              aria-label={t.kind}
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
          </label>
          <label htmlFor={`${fieldId}-4`} className="block space-y-1">
            <span>{t.content}</span>
            <Textarea
              id={`${fieldId}-4`}
              required
              maxLength={2000}
              rows={6}
              value={content}
              onChange={(event) => setContent(event.currentTarget.value)}
            />
          </label>
          <label htmlFor={`${fieldId}-5`} className="block space-y-1">
            <span>{t.files}</span>
            <Textarea
              id={`${fieldId}-5`}
              rows={3}
              value={files}
              onChange={(event) => setFiles(event.currentTarget.value)}
            />
          </label>
          {(write.error || supersede.error) && (
            <Alert variant="destructive">{apiErrorMessage(write.error ?? supersede.error)}</Alert>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              {t.cancel}
            </Button>
            <Button type="submit" disabled={pending || !content.trim() || (!memory && !selectedScope)}>
              {pending ? t.loading : t.save}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
