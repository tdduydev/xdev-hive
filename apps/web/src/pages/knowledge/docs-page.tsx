import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type DocSummary, docKey } from "@xdev-hive/contracts";
import { docEditorText } from "@xdev-hive/doc-editor";
import { Button, buttonVariants } from "@xdev-hive/ui/button";
import { Input } from "@xdev-hive/ui/input";
import { Markdown } from "@xdev-hive/ui/markdown";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { type FormEvent, useId, useState } from "react";
import { type Column, DataTable } from "@/components/data-table/data-table.tsx";
import { useT } from "@/lib/i18n.ts";
import { authorLabel, DetailCard, KnowledgeLayout, QueryState, ScopeBadge } from "@/pages/knowledge/common.tsx";
import { knowledgeText } from "@/pages/knowledge/text.ts";
import { useOrg } from "@/shell/org-context.ts";

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
    <KnowledgeLayout title={t.docsTitle} lead={t.docsLead} actions={<NewDoc />}>
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
/** Tài liệu mới bắt đầu ở trình soạn; chỉ có dòng trong danh sách khi bản đầu tiên được duyệt. */
function NewDoc() {
  const t = useT(docEditorText);
  const navigate = useNavigate();
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const parsed = docKey.safeParse(key.trim());
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? t.newDocHint);
    void navigate({ to: "/knowledge/docs/$key/edit", params: { key: parsed.data } });
  }
  if (!open) return <Button onClick={() => setOpen(true)}>{t.newDoc}</Button>;
  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-2">
      <label htmlFor={fieldId} className="flex flex-col gap-1 text-sm">
        <span>{t.newDocKey}</span>
        <Input
          id={fieldId}
          className="w-80 font-mono"
          placeholder="project/payment-api/prd-refund"
          value={key}
          aria-invalid={!!error}
          aria-describedby={`${fieldId}-hint`}
          onChange={(e) => {
            setKey(e.currentTarget.value);
            setError(null);
          }}
        />
        <span id={`${fieldId}-hint`} className={error ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
          {error ?? t.newDocHint}
        </span>
      </label>
      <Button type="submit">{t.open}</Button>
      <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
        {t.cancel}
      </Button>
    </form>
  );
}

function DocDetail({ doc }: { doc: DocSummary }) {
  const te = useT(docEditorText);
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
        <Link to="/knowledge/docs/$key/edit" params={{ key: doc.key }} className={buttonVariants({ size: "sm" })}>
          {te.edit}
        </Link>
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
