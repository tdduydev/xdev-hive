import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type DocSummary, type DocTreeItem, docKey, docRepoPath, docSyncState } from "@xdev-hive/contracts";
import { docEditorText, syncStateLabel } from "@xdev-hive/doc-editor";
import { Alert } from "@xdev-hive/ui/alert";
import { Button, buttonVariants } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { Input } from "@xdev-hive/ui/input";
import { Markdown } from "@xdev-hive/ui/markdown";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { type FormEvent, useId, useMemo, useState } from "react";
import { SegmentedControl } from "@/components/page/segmented-control.tsx";
import { EmptyState, LoadFailure, TableSkeleton } from "@/components/ui/query-state.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { docScopeStore } from "@/lib/doc-scope-store.ts";
import { useT } from "@/lib/i18n.ts";
import { authorLabel, DetailCard, KnowledgeLayout, QueryState, ScopeBadge, When } from "@/pages/knowledge/common.tsx";
import {
  buildScopeTree,
  type DocScopeFilter,
  defaultFilter,
  inFilter,
  type MyMembership,
  openByDefault,
  type ScopeNames,
} from "@/pages/knowledge/doc-scope.ts";
import {
  badgeState,
  DocSyncDetails,
  DocTree,
  useDocManage,
  useDocTree,
  withUnhomedDocs,
} from "@/pages/knowledge/doc-tree.tsx";
import { knowledgeText } from "@/pages/knowledge/text.ts";
import { useOrg } from "@/shell/org-context.ts";

const text = knowledgeText;
const SCOPE_OPTIONS = [
  { value: "mine", label: "Dự án của tôi" },
  { value: "all", label: "Tất cả" },
] as const;
export function DocsPage() {
  const { org } = useOrg();
  return <DocsScreen key={org.id} />;
}
function DocsScreen() {
  const t = useT(text);
  const { api, org } = useOrg();
  const fieldId = useId();
  const [archived, setArchived] = useState(false);
  const list = useQuery(api.docs.list.queryOptions({ input: { archived } }));
  const tree = useDocTree();
  const mine = useQuery(api.projectMembers.mine.queryOptions({ input: {} }));
  const teams = useQuery(api.teams.list.queryOptions());
  const systems = useQuery(api.systems.list.queryOptions({ input: {} }));
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const [pickedFilter, setPickedFilter] = useState<DocScopeFilter | null>(null);
  // Người dùng bấm nút thì ghi đè mặc định của lần mở trang; chưa bấm thì nhìn vào bộ lọc đã nhớ cho tổ chức này.
  const [toggled, setToggled] = useState<ReadonlySet<string> | null>(null);
  const [selectedKey, setSelectedKey] = useState<string>();
  const [state, setState] = useState("");
  const [query, setQuery] = useState("");
  const [searchText, setSearchText] = useState("");
  const search = useQuery({ ...api.docs.search.queryOptions({ input: { query: searchText } }), enabled: !!searchText });
  const selected = list.data?.find((doc) => doc.key === selectedKey);
  const items = useMemo(
    () => (archived ? withUnhomedDocs([], list.data ?? []) : withUnhomedDocs(tree.data ?? [], list.data ?? [])),
    [archived, list.data, tree.data],
  );
  const membership = useMemo<MyMembership>(
    () => ({ projectIds: new Set(mine.data?.projectIds), teamIds: new Set(mine.data?.teamIds) }),
    [mine.data],
  );
  const names = useMemo<ScopeNames>(
    () => ({
      teams: new Map((teams.data ?? []).map((team) => [team.id, team.name])),
      systems: new Map((systems.data ?? []).map((system) => [system.id, { name: system.name, teamId: system.teamId }])),
      projects: new Map(
        (projects.data ?? []).map((p) => [p.id, { name: p.name, systemId: p.systemId, teamId: p.teamId }]),
      ),
    }),
    [teams.data, systems.data, projects.data],
  );
  // Chưa biết mình thuộc dự án nào thì hiện "Tất cả" để trang không trống.
  const filter = pickedFilter ?? (mine.data ? defaultFilter(docScopeStore.get(org.id), membership) : "all");
  // Bộ lọc trạng thái chạy trước, bộ lọc phạm vi chạy sau, rồi mới gom cây.
  const nodes = useMemo(() => {
    const byState = state ? items.filter((item) => badgeState(item) === state) : items;
    return buildScopeTree(
      byState.filter((item) => inFilter(item, filter, membership)),
      names,
    );
  }, [items, state, filter, membership, names]);
  const defaultOpen = useMemo(() => openByDefault(nodes, membership), [nodes, membership]);
  const open = toggled ?? defaultOpen;
  return (
    <KnowledgeLayout title={t.docsTitle} lead={t.docsLead} actions={<NewDoc />}>
      <form
        className="flex min-w-0 flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setSearchText(query.trim());
        }}
      >
        <label htmlFor={`${fieldId}-search`} className="min-w-0 flex-1 space-y-1 text-sm">
          Tìm theo nghĩa
          <Input
            id={`${fieldId}-search`}
            aria-label="Tìm theo nghĩa"
            maxLength={2000}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (!e.target.value.trim()) setSearchText("");
            }}
            placeholder="Nhập câu hỏi về tài liệu…"
          />
        </label>
        <Button type="submit" disabled={!query.trim() || search.isFetching}>
          Tìm tài liệu
        </Button>
        {searchText && (
          <Button
            variant="ghost"
            type="button"
            onClick={() => {
              setQuery("");
              setSearchText("");
            }}
          >
            Xoá tìm kiếm
          </Button>
        )}
      </form>
      {searchText && (
        <section aria-label="Kết quả tìm tài liệu" className="space-y-3 rounded-lg border border-border p-3">
          {search.isFetching && <p role="status">Đang tìm tài liệu…</p>}
          {search.isError && <LoadFailure error={search.error} retry={search.refetch} />}
          {search.data && (
            <>
              <p role="status">
                {search.data.mode === "keyword" ? "Đang tìm theo từ" : "Kết quả theo từ và theo nghĩa"}
              </p>
              {!search.data.hits.length && <p>Không tìm thấy tài liệu phù hợp.</p>}
              {search.data.hits.map((hit) => (
                <article
                  key={JSON.stringify([hit.key, hit.headingPath, hit.snippet])}
                  className="min-w-0 space-y-1 border-t border-border pt-2"
                >
                  {hit.extractId ? (
                    <Link
                      to="/knowledge/docs/extracts"
                      hash={hit.extractId}
                      className="break-words text-primary underline"
                    >
                      {hit.title} · Bản trích
                    </Link>
                  ) : (
                    <Link
                      to="/knowledge/docs/$key/edit"
                      params={{ key: hit.key }}
                      className="break-words text-primary underline"
                    >
                      {hit.title}
                    </Link>
                  )}
                  <p className="break-all text-xs text-muted-foreground">
                    {hit.repoPath ?? hit.key} · {hit.headingPath.join(" › ")}
                  </p>
                  <p className="whitespace-pre-wrap break-words text-sm">{hit.snippet}</p>
                </article>
              ))}
            </>
          )}
        </section>
      )}
      <div className="flex flex-wrap gap-3">
        <label htmlFor={`${fieldId}-state`} className="space-y-1 text-sm">
          Trạng thái đồng bộ
          <NativeSelect
            id={`${fieldId}-state`}
            aria-label="Trạng thái đồng bộ"
            value={state}
            onChange={(e) => setState(e.target.value)}
          >
            <option value="">Tất cả trạng thái</option>
            {[...docSyncState.options, "no_home" as const].map((value) => (
              <option key={value} value={value}>
                {syncStateLabel(value, "vi")}
              </option>
            ))}
          </NativeSelect>
        </label>
        <div className="space-y-1 text-sm">
          <span>Phạm vi</span>
          <div>
            <SegmentedControl
              label="Phạm vi tài liệu"
              value={filter}
              options={SCOPE_OPTIONS}
              onChange={(value) => {
                setPickedFilter(value);
                docScopeStore.set(org.id, value);
              }}
            />
          </div>
        </div>
        <label htmlFor={`${fieldId}-list`} className="space-y-1 text-sm">
          Danh sách
          <NativeSelect
            id={`${fieldId}-list`}
            aria-label="Danh sách tài liệu"
            value={archived ? "archived" : "active"}
            onChange={(e) => {
              setArchived(e.target.value === "archived");
              setSelectedKey(undefined);
              setState("");
            }}
          >
            <option value="active">Đang dùng</option>
            <option value="archived">Đã lưu trữ</option>
          </NativeSelect>
        </label>
      </div>
      {(list.isPending ||
        (!archived && tree.isPending) ||
        mine.isPending ||
        teams.isPending ||
        systems.isPending ||
        projects.isPending) && <TableSkeleton label={t.loading} columns={4} />}
      {list.isError && <LoadFailure error={list.error} retry={list.refetch} />}
      {!archived && tree.isError && <LoadFailure error={tree.error} retry={tree.refetch} />}
      {list.data &&
        (archived || tree.data) &&
        !mine.isPending &&
        !teams.isPending &&
        !systems.isPending &&
        !projects.isPending &&
        (!items.length ? (
          <EmptyState
            title={archived ? "Chưa có tài liệu lưu trữ" : t.docsEmptyTitle}
            description={archived ? "Tài liệu được lưu trữ sẽ hiện ở đây để khôi phục." : t.docsEmptyBody}
          />
        ) : (
          <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[3fr_2fr]">
            <DocTree
              archived={archived}
              nodes={nodes}
              open={open}
              onToggle={(id) => {
                const next = new Set(open);
                if (!next.delete(id)) next.add(id);
                setToggled(next);
              }}
              selectedKey={selectedKey}
              onSelect={(item) => {
                if (item.key) setSelectedKey(item.key);
                else if (item.assetId)
                  window.open(`/api/v1/docs/assets/${item.assetId}?org=${org.id}`, "_blank", "noopener,noreferrer");
              }}
            />
            {selected ? (
              <DocDetail
                key={`${selected.key}:${archived}`}
                doc={selected}
                item={items.find((item) => item.key === selected.key)}
                archived={archived}
              />
            ) : (
              <DetailCard>{t.choose}</DetailCard>
            )}
          </div>
        ))}
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
      <label htmlFor={fieldId} className="flex min-w-0 flex-col gap-1 text-sm">
        <span>{t.newDocKey}</span>
        <Input
          id={fieldId}
          className="w-full max-w-80 font-mono sm:w-80"
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

function DocDetail({ doc, item, archived }: { doc: DocSummary; item?: DocTreeItem | undefined; archived: boolean }) {
  const canManage = useDocManage(doc.scope);
  const te = useT(docEditorText);
  const fieldId = useId();
  const t = useT(text);
  const { api } = useOrg();
  const [version, setVersion] = useState(doc.version);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const detail = useQuery(api.docs.get.queryOptions({ input: { key: doc.key, version } }));
  const history = useQuery({
    ...api.docs.history.queryOptions({ input: { key: doc.key } }),
    enabled: historyOpen || archived,
  });
  const command = `doc_get(${JSON.stringify(doc.key)})`;
  return (
    <DetailCard>
      <div className="flex flex-wrap gap-2">
        <code className="break-all text-xs text-muted-foreground">{doc.key}</code>
        <ScopeBadge scope={doc.scope} />
      </div>
      {!archived && <DocSyncDetails item={item} canManage={canManage} />}
      {canManage && <DocActions doc={doc} item={item} archived={archived} />}
      <h2 className="text-lg font-semibold">{detail.data?.title ?? doc.title}</h2>
      <p className="text-xs text-muted-foreground">
        v{version} · {authorLabel(detail.data?.updatedBy ?? doc.updatedBy)}
      </p>
      <div className="flex flex-wrap gap-2">
        {!archived && (
          <Link to="/knowledge/docs/$key/edit" params={{ key: doc.key }} className={buttonVariants({ size: "sm" })}>
            {te.edit}
          </Link>
        )}
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
                    v{item.version} · {authorLabel(item.author)} · <When iso={item.createdAt} />
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

function DocActions({ doc, item, archived }: { doc: DocSummary; item?: DocTreeItem | undefined; archived: boolean }) {
  const { api } = useOrg();
  const cache = useQueryClient();
  const fieldId = useId();
  const [action, setAction] = useState<"move" | "archive" | "restore" | null>(null);
  const [path, setPath] = useState(item?.path ?? "");
  const parsed = docRepoPath.safeParse(path);
  const change = useMutation({
    mutationFn: async () => {
      if (action === "move") return api.docTree.move.call({ key: doc.key, repoPath: path, baseVersion: doc.version });
      if (action === "restore") return api.docs.restore.call({ key: doc.key, baseVersion: doc.version });
      return api.docs.archive.call({ key: doc.key, baseVersion: doc.version });
    },
    onSuccess: async () => {
      setAction(null);
      await Promise.all([
        cache.invalidateQueries({ queryKey: api.docs.key() }),
        cache.invalidateQueries({ queryKey: api.docTree.key() }),
      ]);
    },
  });
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {!archived && item?.homeId && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              change.reset();
              setPath(item.path ?? "");
              setAction("move");
            }}
          >
            Di chuyển
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            change.reset();
            setAction(archived ? "restore" : "archive");
          }}
        >
          {archived ? "Khôi phục" : "Lưu trữ"}
        </Button>
      </div>
      <Dialog
        open={!!action}
        onOpenChange={(open) => {
          if (!open && !change.isPending) setAction(null);
        }}
      >
        <DialogContent>
          <DialogTitle>
            {action === "move"
              ? "Di chuyển tài liệu"
              : action === "restore"
                ? "Khôi phục tài liệu"
                : "Lưu trữ tài liệu"}
          </DialogTitle>
          <DialogDescription>
            {action === "move"
              ? "Đổi đường dẫn trong repo, giữ nguyên key và lịch sử tài liệu."
              : action === "restore"
                ? "Tài liệu sẽ trở lại danh sách đang dùng và được đồng bộ vào repo."
                : "Tài liệu vẫn giữ lịch sử trên hub. File trong repo sẽ được xoá khi đồng bộ."}
          </DialogDescription>
          {action === "move" && (
            <label htmlFor={fieldId} className="space-y-1 text-sm">
              Đường dẫn mới
              <Input id={fieldId} aria-label="Đường dẫn mới" value={path} onChange={(e) => setPath(e.target.value)} />
              <span className="text-xs text-muted-foreground">Ví dụ: docs/huong-dan/cai-dat.md</span>
            </label>
          )}
          {change.isError && <Alert variant="destructive">{apiErrorMessage(change.error)}</Alert>}
          <DialogActions>
            <Button variant="outline" disabled={change.isPending} onClick={() => setAction(null)}>
              Huỷ
            </Button>
            <Button
              disabled={
                change.isPending ||
                (action === "move" && (!parsed.success || path.endsWith("/") || path === item?.path))
              }
              onClick={() => change.mutate()}
            >
              Xác nhận
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </>
  );
}
