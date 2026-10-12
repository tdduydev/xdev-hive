import { useQuery } from "@tanstack/react-query";
import type { DocSummary } from "@xdev-hive/contracts";
import { useId, useState } from "react";
import { type Column, DataTable } from "../../components/data-table/data-table.tsx";
import { Button } from "../../components/ui/button.tsx";
import { NativeSelect } from "../../components/ui/native-select.tsx";
import { useT } from "../../lib/i18n.ts";
import { useOrg } from "../../shell/org-context.ts";
import { authorLabel, DetailCard, KnowledgeLayout, QueryState, ScopeBadge } from "./common.tsx";
import { Markdown } from "./markdown.tsx";
import { knowledgeText } from "./text.ts";

const text = knowledgeText;
export function DocsPage() {
  const { org } = useOrg();
  return <DocsScreen key={org.id} />;
}
function DocsScreen() {
  const t = useT(text);
  const { api } = useOrg();
  const list = useQuery(api.docs.list.queryOptions({ input: {} }));
  const [selected, setSelected] = useState<DocSummary>();
  const columns: Column<DocSummary>[] = [
    {
      key: "title",
      label: t.docsTitle,
      value: (row) => row.title,
      sortable: true,
      cell: (row) => (
        <div>
          <strong>{row.title}</strong>
          <p className="font-mono text-xs text-muted-foreground">{row.key}</p>
        </div>
      ),
    },
    { key: "key", label: "Key", value: (row) => row.key, hidden: true },
    {
      key: "scope",
      label: t.scope,
      value: (row) => t[row.scope.level],
      cell: (row) => <ScopeBadge scope={row.scope} />,
    },
    { key: "version", label: t.version, value: (row) => row.version, sortable: true, cell: (row) => `v${row.version}` },
    { key: "author", label: t.author, value: (row) => authorLabel(row.updatedBy) },
    { key: "updated", label: t.updated, value: (row) => row.updatedAt, sortable: true },
  ];
  return (
    <KnowledgeLayout title={t.docsTitle} lead={t.docsLead}>
      <QueryState query={list} />
      {list.data && (
        <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[3fr_2fr]">
          <DataTable
            columns={columns}
            rows={list.data}
            selectable={false}
            placeholder={t.docsSearch}
            facets={[{ key: "scope", label: t.scope, value: (row) => t[row.scope.level] }]}
            activeId={selected?.id ?? ""}
            rowLabel={(row) => row.title}
            onRowClick={setSelected}
            emptyContent={t.empty}
          />
          {selected ? <DocDetail key={selected.key} doc={selected} /> : <DetailCard>{t.choose}</DetailCard>}
        </div>
      )}
    </KnowledgeLayout>
  );
}
function DocDetail({ doc }: { doc: DocSummary }) {
  const fieldId = useId();
  const t = useT(text);
  const { api } = useOrg();
  const [version, setVersion] = useState(doc.version);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const detail = useQuery(api.docs.get.queryOptions({ input: { key: doc.key, version } }));
  const history = useQuery({ ...api.docs.history.queryOptions({ input: { key: doc.key } }), enabled: historyOpen });
  const command = `doc_get(${JSON.stringify(doc.key)})`;
  return (
    <DetailCard>
      <div className="flex flex-wrap gap-2">
        <code className="break-all text-xs text-muted-foreground">{doc.key}</code>
        <ScopeBadge scope={doc.scope} />
      </div>
      <h2 className="text-lg font-semibold">{detail.data?.title ?? doc.title}</h2>
      <p className="text-xs text-muted-foreground">
        v{version} · {authorLabel(detail.data?.updatedBy ?? doc.updatedBy)}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => setHistoryOpen(!historyOpen)} aria-expanded={historyOpen}>
          {t.history}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(command);
              setCopied(true);
              setCopyFailed(false);
            } catch {
              setCopyFailed(true);
            }
          }}
        >
          {copied ? t.copied : t.copy}
        </Button>
      </div>
      {copyFailed && <p role="status">{t.copyFailed}</p>}
      {historyOpen && (
        <section className="space-y-2">
          <QueryState query={history} />
          {history.data && (
            <>
              <label htmlFor={`${fieldId}-1`} className="block space-y-1">
                <span>{t.version}</span>
                <NativeSelect
                  aria-label={t.version}
                  id={`${fieldId}-1`}
                  value={version}
                  onChange={(event) => setVersion(Number(event.currentTarget.value))}
                >
                  {history.data.map((item) => (
                    <option key={item.version} value={item.version}>
                      v{item.version} · {item.message ?? item.title}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <ol className="space-y-2 text-xs text-muted-foreground">
                {history.data.map((item) => (
                  <li key={item.version}>
                    v{item.version} · {authorLabel(item.author)} · {item.createdAt}
                    <p>{item.message}</p>
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>
      )}
      <QueryState query={detail} />
      {detail.data && <Markdown content={detail.data.content} />}
      <p className="border-t border-border pt-3 text-xs text-muted-foreground">
        {t.docsMcpNote} <code className="break-all">{command}</code>
      </p>
    </DetailCard>
  );
}
