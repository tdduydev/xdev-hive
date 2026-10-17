import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DocSummary, DocTreeItem, ScopeView } from "@xdev-hive/contracts";
import { type DocSyncState, SyncBadge } from "@xdev-hive/doc-editor";
import { Button } from "@xdev-hive/ui/button";
import { ChevronRightIcon, FolderIcon } from "lucide-react";
import { useState } from "react";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { isOrgAdmin } from "@/lib/roles.ts";
// Chỉ import kiểu: doc-scope.ts là file thuần và không được kéo doc-tree.tsx (React) vào lúc chạy.
import type { Folder, ScopeNode } from "@/pages/knowledge/doc-scope.ts";
import { useMe } from "@/shell/me-context.ts";
import { useOrg } from "@/shell/org-context.ts";

export function useDocTree() {
  const { api } = useOrg();
  return useQuery({
    queryKey: [...api.docTree.key(), "all"],
    queryFn: async () => {
      const items: DocTreeItem[] = [];
      let cursor: string | undefined;
      do {
        const page = await api.docTree.list.call({ limit: 200, ...(cursor ? { cursor } : {}) });
        items.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return items;
    },
    refetchInterval: 30_000,
  });
}

export function useDocManage(scope: ScopeView | undefined) {
  const { api, org } = useOrg();
  const me = useMe();
  const members = useQuery({
    ...api.teamMembers.list.queryOptions({ input: { teamId: scope?.teamId ?? "" } }),
    enabled: !!scope?.teamId && !isOrgAdmin(org.role),
  });
  return (
    !!scope && (isOrgAdmin(org.role) || members.data?.some((m) => m.userId === me.id && m.role === "admin") === true)
  );
}

export function withUnhomedDocs(items: DocTreeItem[], docs: DocSummary[]): DocTreeItem[] {
  const keys = new Set(items.map((item) => item.key));
  return [
    ...items,
    ...docs
      .filter((doc) => !keys.has(doc.key))
      .map(
        (doc): DocTreeItem => ({
          homeId: null,
          path: null,
          key: doc.key,
          title: doc.title,
          kind: "doc",
          state: null,
          prNumber: null,
          prUrl: null,
          repoUrl: null,
          repoCommit: null,
          docId: doc.id,
          assetId: null,
          version: doc.version,
          error: null,
          scope: doc.scope,
        }),
      ),
  ];
}

export function badgeState(item: DocTreeItem | undefined): DocSyncState {
  if (!item?.homeId) return "no_home";
  // Hub đã ghi vào nhánh đồng bộ; nhánh chính vẫn chờ PR được merge.
  if (item.state === "synced" && item.prNumber) return "pending";
  if (item.state === "available") return "synced";
  if (item.state === "pending_push") return "pending";
  if (item.state === "missing_lfs" || item.state === "too_large") return "failed";
  return item.state ?? "no_home";
}

export function repoCommitUrl(item: DocTreeItem): string | null {
  if (!item.repoUrl || !item.repoCommit) return null;
  return item.repoUrl.replace(
    /\/(?:-\/)?blob\/.*/,
    `/${item.repoUrl.includes("/-/blob/") ? "-/" : ""}commit/${item.repoCommit}`,
  );
}

export function DocSyncDetails({ item, canManage = false }: { item?: DocTreeItem | undefined; canManage?: boolean }) {
  const { api } = useOrg();
  const cache = useQueryClient();
  const retry = useMutation({
    mutationFn: () => api.docHomes.syncNow.call({ homeId: item?.homeId ?? "" }),
    onSuccess: () => cache.invalidateQueries({ queryKey: api.docTree.key() }),
  });
  const commitUrl = item ? repoCommitUrl(item) : null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
      <SyncBadge state={badgeState(item)} prNumber={item?.prNumber} lang="vi" />
      {item?.path && <code className="break-all">{item.path}</code>}
      {item?.prUrl && (
        <a href={item.prUrl} target="_blank" rel="noreferrer" className="text-primary underline">
          PR #{item.prNumber}
        </a>
      )}
      {item?.repoUrl && (
        <a href={item.repoUrl} target="_blank" rel="noreferrer" className="text-primary underline">
          Mở file trên repo
        </a>
      )}
      {commitUrl && (
        <a href={commitUrl} target="_blank" rel="noreferrer" className="text-primary underline">
          Commit {item?.repoCommit?.slice(0, 8)}
        </a>
      )}
      {canManage && item?.homeId && item.state === "failed" && (
        <Button size="sm" variant="outline" disabled={retry.isPending} onClick={() => retry.mutate()}>
          Thử lại
        </Button>
      )}
      {item?.error && (
        <p role="alert" className="w-full break-words text-destructive">
          {item.error}
        </p>
      )}
      {retry.isError && <p role="alert">{apiErrorMessage(retry.error)}</p>}
      {retry.isSuccess && <p role="status">Đã xếp đồng bộ lại.</p>}
    </div>
  );
}

function repoLabel(item: DocTreeItem): string {
  if (item.repoUrl) {
    try {
      return decodeURIComponent(
        new URL(item.repoUrl).pathname.split(/\/(?:-\/)?blob\//)[0]?.slice(1) ?? "Kho tài liệu",
      );
    } catch {
      /* Nhà chưa có URL file hợp lệ. */
    }
  }
  return `Kho tài liệu ${item.homeId?.slice(0, 8)}`;
}

function repoLabels(folder: Folder): string[] {
  const labels = new Set<string>();
  const visit = (f: Folder) => {
    for (const file of f.files) if (file.homeId) labels.add(repoLabel(file));
    for (const child of f.folders.values()) visit(child);
  };
  visit(folder);
  return [...labels].sort();
}

const rowButton =
  "flex max-w-full items-center gap-2 rounded px-2 py-1 text-left text-sm focus-visible:ring-2 focus-visible:ring-ring";

export function DocTree({
  nodes,
  open,
  onToggle,
  selectedKey,
  onSelect,
  archived = false,
}: {
  archived?: boolean;
  nodes: ScopeNode[];
  open: ReadonlySet<string>;
  onToggle?: (id: string) => void;
  selectedKey?: string | undefined;
  onSelect: (item: DocTreeItem) => void;
}) {
  return (
    <ul aria-label="Cây tài liệu" className="min-w-0 space-y-2">
      {nodes.map((node) => (
        <NodeRow
          key={node.id}
          node={node}
          open={open}
          onToggle={onToggle}
          selectedKey={selectedKey}
          onSelect={onSelect}
          archived={archived}
        />
      ))}
      {!nodes.length && <li className="p-4 text-sm text-muted-foreground">Không có tài liệu phù hợp.</li>}
    </ul>
  );
}

function NodeRow({
  node,
  open,
  onToggle,
  selectedKey,
  onSelect,
  archived,
}: {
  archived: boolean;
  node: ScopeNode;
  open: ReadonlySet<string>;
  onToggle: ((id: string) => void) | undefined;
  selectedKey?: string | undefined;
  onSelect: (item: DocTreeItem) => void;
}) {
  const isOpen = open.has(node.id);
  const repos = node.kind === "project" && node.folder ? repoLabels(node.folder) : [];
  return (
    <li className="min-w-0">
      <button
        type="button"
        aria-expanded={isOpen}
        aria-label={`${isOpen ? "Thu" : "Mở"} nhóm ${node.name}`}
        onClick={() => onToggle?.(node.id)}
        className={rowButton}
      >
        <ChevronRightIcon aria-hidden size={14} className={isOpen ? "rotate-90" : ""} />
        <FolderIcon aria-hidden size={14} />
        <span className="min-w-0 break-words">
          <span className="font-medium">{`${node.name} (${node.count})`}</span>
          {repos.length > 0 && (
            <span className="block break-all font-mono text-xs text-muted-foreground">{repos.join(", ")}</span>
          )}
        </span>
      </button>
      {isOpen && (
        <ul className="ml-2 min-w-0 space-y-1 border-l border-border pl-2">
          {node.children.map((child) => (
            <NodeRow
              key={child.id}
              node={child}
              open={open}
              onToggle={onToggle}
              selectedKey={selectedKey}
              onSelect={onSelect}
              archived={archived}
            />
          ))}
          {node.folder && (
            <FolderContents folder={node.folder} selectedKey={selectedKey} onSelect={onSelect} archived={archived} />
          )}
        </ul>
      )}
    </li>
  );
}

function FolderContents({
  folder,
  selectedKey,
  onSelect,
  archived,
}: {
  archived: boolean;
  folder: Folder;
  selectedKey?: string | undefined;
  onSelect: (item: DocTreeItem) => void;
}) {
  return (
    <>
      {[...folder.folders.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((child) => (
          <FolderRow
            key={child.path}
            folder={child}
            selectedKey={selectedKey}
            onSelect={onSelect}
            archived={archived}
          />
        ))}
      {folder.files.map((item) => (
        <li key={item.key ?? item.assetId} className="min-w-0 py-1">
          <button
            type="button"
            aria-label={`Mở dòng ${item.title}`}
            aria-pressed={!!item.key && selectedKey === item.key}
            onClick={() => onSelect(item)}
            className="flex w-full min-w-0 flex-wrap items-center gap-2 rounded px-2 py-1 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-muted"
          >
            <span className="min-w-0 flex-1 break-words text-sm">
              <span>{item.title}</span>
              {item.path && (
                <span className="block break-all font-mono text-xs text-muted-foreground">
                  {item.path.split("/").at(-1)}
                </span>
              )}
            </span>
            {!archived && <SyncBadge state={badgeState(item)} prNumber={item.prNumber} lang="vi" />}
          </button>
        </li>
      ))}
    </>
  );
}

function FolderRow({
  folder,
  selectedKey,
  onSelect,
  archived,
}: {
  archived: boolean;
  folder: Folder;
  selectedKey?: string | undefined;
  onSelect: (item: DocTreeItem) => void;
}) {
  // Thư mục đóng sẵn: nút dự án chứa nhiều thư mục, mở hết thì người dùng lại phải lướt qua cả cây.
  const [open, setOpen] = useState(false);
  return (
    <li className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${open ? "Thu" : "Mở"} thư mục ${folder.name}`}
        onClick={() => setOpen(!open)}
        className={rowButton}
      >
        <ChevronRightIcon aria-hidden size={14} className={open ? "rotate-90" : ""} />
        <FolderIcon aria-hidden size={14} />
        <span className="break-all">{folder.name}</span>
      </button>
      {open && (
        <ul className="ml-2 min-w-0 border-l border-border pl-2">
          <FolderContents folder={folder} selectedKey={selectedKey} onSelect={onSelect} archived={archived} />
        </ul>
      )}
    </li>
  );
}
