import { QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
import {
  type DocConflict,
  type DocConflictResolveInput,
  type DocSearchHit,
  type DocSummary,
  type DocTreeItem,
  docKey as docKeySchema,
} from "@xdev-hive/contracts";
import {
  ConflictView,
  DocEditor,
  type DocEditorEnv,
  DocEditorProvider,
  type DocSyncState,
  SyncBadge,
} from "@xdev-hive/doc-editor";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Input } from "@xdev-hive/ui/input";
import { type FormEvent, type ReactNode, useId, useState, useSyncExternalStore } from "react";
import { api, queryClient, useDesktopDocEnv } from "@/lib/hub-query.tsx";
import { type Dict, useT, writeRepoText } from "@/lib/i18n.ts";
import { screenParam } from "@/lib/nav.ts";
import { errorText, invoke } from "@/lib/tauri.ts";

const text: Dict<{
  lead: string;
  empty: string;
  newDoc: string;
  key: string;
  hint: string;
  open: string;
  loading: string;
}> = {
  vi: {
    lead: "Soạn PRD, spec, ADR với cả đội: bản nháp chung, đề xuất sửa, bình luận, AI chạy trên máy của bạn.",
    empty: "Chưa có tài liệu nào bạn đọc được.",
    newDoc: "Tài liệu mới",
    key: "Key tài liệu",
    hint: "Dạng project/<dự án>/<tên>, team/<đội>/<tên> hoặc org/<tên>.",
    open: "Mở trình soạn",
    loading: "Đang tải…",
  },
  en: {
    lead: "Write PRDs, specs and ADRs with your team: shared draft, suggestions, comments, AI on your machine.",
    empty: "No docs you can read yet.",
    newDoc: "New doc",
    key: "Doc key",
    hint: "Like project/<project>/<name>, team/<team>/<name> or org/<name>.",
    open: "Open editor",
    loading: "Loading…",
  },
};

const go = (key?: string) => {
  location.hash = key ? `#/write/${encodeURIComponent(key)}` : "#/write";
};

function subscribe(listener: () => void) {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

export function useWriteDocEnv(): DocEditorEnv {
  const env = useDesktopDocEnv();
  return {
    ...env,
    resolveLink: async (docKey, href) => {
      const targets = await queryClient.fetchQuery(
        api.docAssets.resolve.queryOptions({ input: { docKey, hrefs: [href] } }),
      );
      const target = targets.find((item) => item.href === href);
      if (target?.kind === "doc" || target?.kind === "external") return target;
      // Ảnh cần cầu nối nhị phân; URL hub tương đối sẽ tải nhầm từ origin cục bộ của WebView.
      return null;
    },
  };
}

/**
 * Màn Soạn tài liệu của app (spec 008 US9): giao diện ở packages/doc-editor, dùng chung với web; app đưa vào client
 * hub qua token cá nhân (hub-rpc), câu báo lỗi và cách mở liên kết. `#/write` là danh sách, `#/write/<key>` là trình soạn.
 */
export function WriteScreen() {
  const docKey = useSyncExternalStore(subscribe, () => screenParam(location.hash));
  return (
    <QueryClientProvider client={queryClient}>
      <DocEditorProvider env={useWriteDocEnv()}>
        {docKey ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
            <RepoEditor key={docKey} docKey={docKey} />
          </div>
        ) : (
          <DocPicker />
        )}
      </DocEditorProvider>
    </QueryClientProvider>
  );
}

function useRepoFiles() {
  return useQuery({
    queryKey: api.docTree.list.key(),
    queryFn: async ({ signal }) => {
      const items: DocTreeItem[] = [];
      let cursor: string | undefined;
      // Đính kèm cũng chiếm một dòng của cây; đọc hết trang trước khi kết luận tài liệu chưa có nhà.
      do {
        const page = await api.docTree.list.call({ limit: 200, ...(cursor ? { cursor } : {}) }, { signal });
        items.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return items;
    },
    refetchInterval: 15_000,
  });
}

function RepoState({ file }: { file: DocTreeItem | undefined }) {
  const t = useT(writeRepoText);
  const commitUrl =
    file?.repoUrl && file.repoCommit ? file.repoUrl.replace(/\/(-\/)?blob\/.*$/, `/$1commit/${file.repoCommit}`) : null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <SyncBadge state={(file?.state as DocSyncState | undefined) ?? "no_home"} prNumber={file?.prNumber} />
      {file?.prUrl && (
        <a href={file.prUrl} target="_blank" rel="noreferrer" className="text-primary underline">
          PR #{file.prNumber}
        </a>
      )}
      {file?.repoUrl && (
        <a href={file.repoUrl} target="_blank" rel="noreferrer" className="text-primary underline">
          {t.repo}
        </a>
      )}
      {commitUrl && (
        <a href={commitUrl} target="_blank" rel="noreferrer" className="text-primary underline" aria-label={t.commit}>
          {file?.repoCommit?.slice(0, 7)}
        </a>
      )}
      {file?.error && <span className="text-destructive">{file.error}</span>}
    </div>
  );
}

function DocRow({
  doc,
  file,
  ready,
}: {
  doc: DocSummary | DocSearchHit;
  file?: DocTreeItem | undefined;
  ready: boolean;
}) {
  const t = useT(writeRepoText);
  return (
    <li>
      <button
        type="button"
        onClick={() => {
          if ("extractId" in doc && doc.extractId)
            void invoke("open_hub_page", { path: `/knowledge/docs/extracts?id=${doc.extractId}` });
          else go(doc.key);
        }}
        className="flex w-full cursor-pointer flex-col items-start gap-0.5 border-0 bg-transparent px-4 py-3 text-left hover:bg-muted"
      >
        <strong className="font-medium">{doc.title}</strong>
        <span className="break-all font-mono text-xs text-muted-foreground">
          {file?.path ?? doc.key}
          {"version" in doc ? ` · v${doc.version}` : ""}
        </span>
        {"snippet" in doc && (
          <span className="whitespace-pre-wrap text-sm text-muted-foreground">
            {doc.headingPath.join(" / ")}
            {doc.headingPath.length ? " · " : ""}
            {doc.snippet}
          </span>
        )}
        {"extractId" in doc && doc.extractId && <span className="text-xs">{t.extract}</span>}
      </button>
      {ready && (
        <div className="px-4 pb-3">
          <RepoState file={file} />
        </div>
      )}
    </li>
  );
}

function DocFolders({ docs, files }: { docs: DocSummary[]; files: DocTreeItem[] | undefined }) {
  const t = useT(writeRepoText);
  type Folder = { folders: Map<string, Folder>; docs: Array<{ doc: DocSummary; file: DocTreeItem | undefined }> };
  const root: Folder = { folders: new Map(), docs: [] };
  const byKey = new Map(files?.filter((file) => file.kind === "doc").map((file) => [file.key, file]));
  for (const doc of docs) {
    const file = byKey.get(doc.key);
    const repo = file?.repoUrl ? new URL(file.repoUrl).pathname.split(/\/(?:-\/)?blob\//)[0] : file?.homeId;
    const parts = file?.path ? [repo ?? "", ...file.path.split("/").slice(0, -1)] : files ? [t.noHome] : [];
    let node = root;
    for (const part of parts) {
      let child = node.folders.get(part);
      if (!child) {
        child = { folders: new Map(), docs: [] };
        node.folders.set(part, child);
      }
      node = child;
    }
    node.docs.push({ doc, file });
  }
  const renderFolder = (folder: Folder): ReactNode => (
    <ul className="m-0 flex list-none flex-col divide-y p-0">
      {[...folder.folders]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, child]) => (
          <li key={name}>
            <details open>
              <summary className="cursor-pointer break-all px-4 py-2 font-mono text-sm">{name}</summary>
              <div className="ml-3 border-l">{renderFolder(child)}</div>
            </details>
          </li>
        ))}
      {folder.docs.map(({ doc, file }) => (
        <DocRow key={doc.id} doc={doc} file={file} ready={!!files} />
      ))}
    </ul>
  );
  return (
    <section aria-label={t.folders} className="rounded-lg border">
      {renderFolder(root)}
    </section>
  );
}

function RepoEditor({ docKey }: { docKey: string }) {
  const t = useT(writeRepoText);
  const common = useT(text);
  const files = useRepoFiles();
  const file = files.data?.find((row) => row.kind === "doc" && row.key === docKey);
  const [showConflict, setShowConflict] = useState(false);
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 border-b p-3">
        {files.isPending && <span role="status">{common.loading}</span>}
        {files.error && <Alert variant="destructive">{errorText(files.error)}</Alert>}
        {files.data && <RepoState file={file} />}
        <Button size="sm" variant="outline" disabled={files.isFetching} onClick={() => void files.refetch()}>
          {t.refresh}
        </Button>
        {file?.state === "conflict" && (
          <Button size="sm" onClick={() => setShowConflict(true)}>
            {t.resolveConflict}
          </Button>
        )}
      </div>
      {showConflict ? (
        <RepoConflict docKey={docKey} homeId={file?.homeId ?? undefined} onClose={() => setShowConflict(false)} />
      ) : (
        <DocEditor docKey={docKey} />
      )}
    </>
  );
}

function RepoConflict({
  docKey,
  homeId,
  onClose,
}: {
  docKey: string;
  homeId?: string | undefined;
  onClose: () => void;
}) {
  const t = useT(writeRepoText);
  const common = useT(text);
  const list = useQuery({
    queryKey: [...api.docConflicts.list.key(), { docKey, homeId }],
    queryFn: async ({ signal }) => {
      let cursor: string | undefined;
      do {
        const page = await api.docConflicts.list.call(
          { state: "open", limit: 200, ...(homeId ? { homeId } : {}), ...(cursor ? { cursor } : {}) },
          { signal },
        );
        const found = page.items.find((row: DocConflict) => row.key === docKey);
        if (found) return found;
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return null;
    },
  });
  const detail = useQuery(
    api.docConflicts.get.queryOptions({ input: { id: list.data?.id ?? "" }, enabled: !!list.data }),
  );
  const resolve = useMutation({
    mutationFn: (input: DocConflictResolveInput) => api.docConflicts.resolve.call(input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: api.docTree.key() }),
        queryClient.invalidateQueries({ queryKey: api.docs.key() }),
        queryClient.invalidateQueries({ queryKey: api.docEditor.key() }),
        queryClient.invalidateQueries({ queryKey: api.docConflicts.key() }),
      ]);
      onClose();
    },
    onError: () => queryClient.invalidateQueries({ queryKey: api.docConflicts.key() }),
  });
  return (
    <div className="flex min-w-0 flex-col gap-3 p-3">
      <Button variant="outline" className="self-start" disabled={resolve.isPending} onClick={onClose}>
        {t.back}
      </Button>
      {(list.isPending || (!!list.data && detail.isPending)) && <p role="status">{common.loading}</p>}
      {(list.error || detail.error) && <Alert variant="destructive">{errorText(list.error ?? detail.error)}</Alert>}
      {list.data === null && <Alert>{t.conflictUnavailable}</Alert>}
      {detail.data && (
        <ConflictView
          conflict={detail.data}
          busy={resolve.isPending}
          error={resolve.error ? errorText(resolve.error) : undefined}
          onResolve={(choice) => resolve.mutate({ id: detail.data.id, baseVersion: detail.data.hubVersion, ...choice })}
        />
      )}
    </div>
  );
}

function DocPicker() {
  const t = useT(text);
  const fieldId = useId();
  const docs = useQuery(api.docs.list.queryOptions({ input: {} }));
  const repo = useT(writeRepoText);
  const files = useRepoFiles();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const results = useQuery(api.docs.search.queryOptions({ input: { query: search }, enabled: !!search }));
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const parsed = docKeySchema.safeParse(key.trim());
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? t.hint);
    go(parsed.data);
  }
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-5">
      <p className="text-muted-foreground">{t.lead}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(query.trim());
        }}
        className="flex flex-wrap items-end gap-2"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
          <label htmlFor={`${fieldId}-search`}>{repo.search}</label>
          <Input
            id={`${fieldId}-search`}
            type="search"
            maxLength={2000}
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
        </div>
        <Button type="submit" disabled={!query.trim()}>
          {repo.searchAction}
        </Button>
        {search && (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setSearch("");
              setQuery("");
            }}
          >
            {repo.clearSearch}
          </Button>
        )}
      </form>
      <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
          <label htmlFor={fieldId} className="font-medium">
            {t.newDoc}
          </label>
          <Input
            id={fieldId}
            className="font-mono"
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
            {error ?? t.hint}
          </span>
        </div>
        <Button type="submit">{t.open}</Button>
      </form>
      {(search ? results.isPending : docs.isPending) && (
        <p role="status" className="text-muted-foreground">
          {t.loading}
        </p>
      )}
      {(search ? results.error : docs.error) && (
        <Alert variant="destructive">{errorText(search ? results.error : docs.error)}</Alert>
      )}
      {files.error && <Alert variant="destructive">{errorText(files.error)}</Alert>}
      {search && results.data && (
        <p role="status" className="text-sm text-muted-foreground">
          {repo[results.data.mode]}
        </p>
      )}
      {search && results.data?.hits.length === 0 && <p>{repo.noResults}</p>}
      {!search && docs.data && !docs.data.length && <p className="text-muted-foreground">{t.empty}</p>}
      {!search && docs.data && docs.data.length > 0 && <DocFolders docs={docs.data} files={files.data} />}
      {search && results.data && (
        <ul className="m-0 flex list-none flex-col divide-y rounded-lg border p-0">
          {results.data.hits.map((doc) => (
            <DocRow
              key={JSON.stringify([doc.key, doc.extractId, doc.headingPath, doc.snippet])}
              doc={doc}
              file={files.data?.find((row) => row.kind === "doc" && row.key === doc.key)}
              ready={!!files.data}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
