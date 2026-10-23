import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type DocConflictResolveInput, type DocTreeItem, SECRET_KIND_LABELS } from "@xdev-hive/contracts";
import {
  type ConflictResolution,
  ConflictView,
  type DocEditorEnv,
  type DocSyncState,
  SyncBadge,
} from "@xdev-hive/doc-editor";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@xdev-hive/ui/dialog";
import { Input } from "@xdev-hive/ui/input";
import { SearchIcon } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { createAssetResolver } from "@/lib/doc-assets.ts";
import { hubErrorCode, hubErrorText, secretFindings } from "@/lib/hub-error.ts";
import { api } from "@/lib/hub-query.tsx";
import { hub } from "@/lib/hub-rpc.ts";
import { type Dict, type Lang, useLang, useT } from "@/lib/i18n.ts";
import { cn } from "@/lib/utils.ts";

const PAGE = 200;
// Cây tài liệu một tổ chức hiếm khi quá vài nghìn dòng; chặn trang để một hub lỗi không giữ vòng lặp mãi.
const MAX_PAGES = 25;

const text: Dict<{
  searchLabel: string;
  searchPlaceholder: string;
  searching: string;
  noHits: string;
  keywordOnly: string;
  clearSearch: string;
  conflictTitle: string;
  conflictLead: (key: string) => string;
  conflictOpen: string;
  conflictLoading: string;
  conflictNone: string;
  conflictResolved: string;
  stale: string;
  reload: string;
  secretTitle: string;
  secretLead: string;
  secretConfirm: string;
  cancel: string;
  close: string;
  line: (n: number) => string;
}> = {
  vi: {
    searchLabel: "Tìm tài liệu",
    searchPlaceholder: "Tìm theo từ hoặc theo nghĩa",
    searching: "Đang tìm…",
    noHits: "Không thấy tài liệu nào khớp.",
    keywordOnly: "Đang tìm theo từ: hub chưa bật tìm theo nghĩa.",
    clearSearch: "Xoá tìm kiếm",
    conflictTitle: "Giải quyết xung đột",
    conflictLead: (key) => `${key} đã được sửa ở cả hub và repo.`,
    conflictOpen: "Xem xung đột",
    conflictLoading: "Đang tải ba bản tài liệu…",
    conflictNone: "Không còn xung đột đang mở cho tài liệu này.",
    conflictResolved: "Đã giải quyết xung đột. Thay đổi sẽ được đồng bộ vào repo.",
    stale: "Tài liệu đã đổi. Tải bản mới nhất trước khi chọn lại; phần sửa tay hiện tại sẽ được thay thế.",
    reload: "Tải bản mới nhất",
    secretTitle: "Xác nhận dấu hiệu bí mật",
    secretLead: "Chỉ tiếp tục khi đã kiểm tra và xác nhận đây không phải bí mật.",
    secretConfirm: "Không phải bí mật, vẫn lưu",
    cancel: "Huỷ",
    close: "Đóng",
    line: (n) => `dòng ${n}`,
  },
  en: {
    searchLabel: "Search documents",
    searchPlaceholder: "Search by words or meaning",
    searching: "Searching…",
    noHits: "No matching documents.",
    keywordOnly: "Searching by words only: the hub has no semantic search enabled.",
    clearSearch: "Clear search",
    conflictTitle: "Resolve conflict",
    conflictLead: (key) => `${key} was changed on both the hub and the repository.`,
    conflictOpen: "View conflict",
    conflictLoading: "Loading the three versions…",
    conflictNone: "This document has no open conflict.",
    conflictResolved: "Conflict resolved. The change will sync to the repository.",
    stale: "The document changed. Load the latest version before choosing again; your manual edit will be replaced.",
    reload: "Load latest version",
    secretTitle: "Confirm secret findings",
    secretLead: "Continue only after checking that this is not a secret.",
    secretConfirm: "Not a secret, save anyway",
    cancel: "Cancel",
    close: "Close",
    line: (n) => `line ${n}`,
  },
};

/**
 * Trạng thái đồng bộ của mọi tài liệu mình thấy, theo key. Hub cũ chưa có cây tài liệu, hay chưa nối repo nào, thì lỗi
 * hoặc rỗng và màn không hiện nhãn: tài liệu vẫn soạn và đề xuất được như trước.
 */
export function useDocSync(enabled: boolean) {
  const tree = useQuery({
    queryKey: [...api.docTree.key(), "all"],
    queryFn: async () => {
      const out: DocTreeItem[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await hub.docTree.list({ limit: PAGE, ...(cursor ? { cursor } : {}) });
        out.push(...res.items);
        if (!res.nextCursor) break;
        cursor = res.nextCursor;
      }
      return out;
    },
    enabled,
  });
  const byKey = useMemo(() => {
    const map = new Map<string, DocTreeItem>();
    for (const item of tree.data ?? []) if (item.kind === "doc" && item.key) map.set(item.key, item);
    return map;
  }, [tree.data]);
  return { byKey, ready: tree.isSuccess, refresh: () => tree.refetch() };
}

/** Trạng thái đồng bộ của một tài liệu; tài liệu chưa có dòng nào trong cây là chưa thuộc nhà nào. */
export function syncStateOf(item: DocTreeItem | undefined): DocSyncState {
  return item?.state && item.kind === "doc" ? (item.state as DocSyncState) : "no_home";
}

/** Nhãn trạng thái đồng bộ nhỏ cho danh sách và đầu trang soạn. */
export function DocSyncBadge({ item, compact = false }: { item: DocTreeItem | undefined; compact?: boolean }) {
  const lang = useLang();
  const state = syncStateOf(item);
  // Danh sách hẹp chỉ hiện nhãn khi cần để ý; tài liệu đã đồng bộ hay chưa có nhà thì để trống cho gọn.
  if (compact && (state === "synced" || state === "no_home")) return null;
  return (
    <SyncBadge
      state={state}
      prNumber={item?.prNumber}
      lang={lang}
      className={cn(compact && "h-4 px-1.5 font-sans text-xs")}
    />
  );
}

/** Ô tìm tài liệu theo từ và theo nghĩa (hub trả `mode` cho biết có bật tìm theo nghĩa không). */
export function DocSearch({ project, onOpen }: { project: string | undefined; onOpen: (key: string) => void }) {
  const t = useT(text);
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const result = useQuery({
    ...api.docs.search.queryOptions({ input: { query, limit: 10, ...(project ? { project } : {}) } }),
    enabled: query !== "",
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setQuery(typed.trim());
  };
  const clear = () => {
    setTyped("");
    setQuery("");
  };
  return (
    <div className="flex flex-col gap-1 px-1.5 pb-1.5">
      <search className="relative">
        <form onSubmit={submit}>
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            aria-label={t.searchLabel}
            name="docs-search"
            autoComplete="off"
            placeholder={t.searchPlaceholder}
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value);
              if (!e.target.value) setQuery("");
            }}
            className="h-7 pl-6.5 text-xs md:text-xs"
          />
        </form>
      </search>
      {query !== "" && (
        <div className="flex flex-col gap-1">
          {result.isPending ? (
            <p role="status" className="px-0.5 text-xs text-muted-foreground">
              {t.searching}
            </p>
          ) : result.isError ? (
            <p role="alert" className="px-0.5 text-xs text-destructive">
              {hubErrorText(result.error)}
            </p>
          ) : (
            <>
              {result.data.mode === "keyword" && (
                <p role="status" className="px-0.5 text-xs text-muted-foreground">
                  {t.keywordOnly}
                </p>
              )}
              {result.data.hits.length === 0 ? (
                <p className="px-0.5 text-xs text-muted-foreground">{t.noHits}</p>
              ) : (
                <ul className="flex flex-col">
                  {result.data.hits.map((hit) => (
                    <li key={`${hit.key}:${hit.headingPath.join("/")}:${hit.extractId ?? ""}`}>
                      <button
                        type="button"
                        title={hit.key}
                        onClick={() => onOpen(hit.key)}
                        className="flex w-full cursor-pointer flex-col gap-0.5 rounded-[5px] px-1.5 py-1 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        <span className="truncate text-xs font-medium">{hit.title}</span>
                        {hit.headingPath.length > 0 && (
                          <span className="truncate text-xs text-muted-foreground">{hit.headingPath.join(" › ")}</span>
                        )}
                        <span className="line-clamp-2 text-xs text-muted-foreground">{hit.snippet}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <Button type="button" variant="ghost" size="xs" className="self-start" onClick={clear}>
                {t.clearSearch}
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Hộp thoại giải quyết xung đột của một tài liệu: tìm xung đột đang mở theo key rồi đưa ba bản vào `ConflictView`
 * dùng chung với web. Quyết định gọi `docConflicts.resolve`; sửa tay mà hub thấy dấu hiệu bí mật thì hỏi xác nhận.
 */
export function DocConflictDialog({
  docKey,
  open,
  onOpenChange,
  onResolved,
}: {
  docKey: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onResolved: () => void;
}) {
  const t = useT(text);
  const lang = useLang();
  const cache = useQueryClient();
  const [attempt, setAttempt] = useState<DocConflictResolveInput>();
  const [resolved, setResolved] = useState(false);
  const conflict = useQuery({
    queryKey: [...api.docConflicts.key(), "open-by-key", docKey],
    queryFn: async () => {
      const list = await hub.docConflicts.list({ state: "open", limit: PAGE });
      const found = list.items.find((c) => c.key === docKey);
      return found ? hub.docConflicts.get({ id: found.id }) : null;
    },
    enabled: open,
    // Bản đang sửa tay không được thay khi đổi cửa sổ.
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
  const resolve = useMutation({
    mutationFn: (input: DocConflictResolveInput) => hub.docConflicts.resolve(input),
    onSuccess: async () => {
      setAttempt(undefined);
      setResolved(true);
      await Promise.all([
        cache.invalidateQueries({ queryKey: api.docTree.key() }),
        cache.invalidateQueries({ queryKey: api.docConflicts.key() }),
        cache.invalidateQueries({ queryKey: api.docs.key() }),
      ]);
      onResolved();
    },
  });
  const stale = ["VERSION_CONFLICT", "DOCSYNC_CONFLICT_RESOLVED"].includes(hubErrorCode(resolve.error) ?? "");
  const findings = resolve.error ? secretFindings(resolve.error) : null;
  const detail = conflict.data;

  const submit = (choice: ConflictResolution) => {
    if (!detail) return;
    const input = { ...choice, id: detail.id, baseVersion: detail.hubVersion };
    setAttempt(input);
    resolve.mutate(input);
  };
  const reset = (next: boolean) => {
    if (!next) {
      setAttempt(undefined);
      setResolved(false);
      resolve.reset();
    }
    onOpenChange(next);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={reset}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>{t.conflictTitle}</DialogTitle>
            <DialogDescription>{t.conflictLead(docKey)}</DialogDescription>
          </DialogHeader>
          {conflict.isPending && conflict.fetchStatus !== "idle" && (
            <p role="status" className="text-sm text-muted-foreground">
              {t.conflictLoading}
            </p>
          )}
          {conflict.isError && (
            <Alert variant="destructive" aria-live="polite">
              {hubErrorText(conflict.error)}
            </Alert>
          )}
          {conflict.isSuccess && !detail && !resolved && (
            <p className="text-sm text-muted-foreground">{t.conflictNone}</p>
          )}
          {resolved && (
            <p role="status" className="text-sm text-success">
              {t.conflictResolved}
            </p>
          )}
          {stale && (
            <Alert className="grid justify-items-start gap-2">
              {t.stale}
              <Button
                variant="outline"
                onClick={() => {
                  resolve.reset();
                  void conflict.refetch();
                }}
              >
                {t.reload}
              </Button>
            </Alert>
          )}
          {detail && (
            <ConflictView
              key={`${detail.id}:${detail.updatedAt}:${detail.hubVersion}:${detail.repoCommit}`}
              conflict={resolved ? { ...detail, state: "resolved" } : detail}
              onResolve={submit}
              busy={resolve.isPending || stale}
              error={resolve.isError && !stale && !findings ? hubErrorText(resolve.error) : undefined}
              lang={lang}
              source={detail.origin === "word" ? "word" : "repo"}
            />
          )}
          <DialogActions>
            <Button variant="outline" onClick={() => reset(false)}>
              {t.close}
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!findings && attempt?.choice === "manual"}
        onOpenChange={(next) => {
          if (!next) resolve.reset();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.secretTitle}</DialogTitle>
            <DialogDescription>{t.secretLead}</DialogDescription>
          </DialogHeader>
          <ul className="text-sm">
            {findings?.map((f) => (
              <li key={`${f.kind}:${f.line}`}>
                {SECRET_KIND_LABELS[f.kind]} · {t.line(f.line)}
              </li>
            ))}
          </ul>
          <DialogActions>
            <Button variant="outline" onClick={() => resolve.reset()}>
              {t.cancel}
            </Button>
            <Button
              disabled={resolve.isPending}
              onClick={() => {
                if (attempt?.choice === "manual") resolve.mutate({ ...attempt, acknowledgeSecrets: true });
              }}
            >
              {t.secretConfirm}
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Môi trường của `packages/doc-editor` trên desktop: gọi hub qua Rust, ngôn ngữ của app, ảnh và link tương đối phân
 * giải qua hub. Chưa có `uploadAsset`: Rust chưa có lệnh tải ảnh lên nên các nút chèn ảnh và đính kèm tắt (FR-030).
 */
export function useDocEditorEnv(lang: Lang, openDoc: (key: string) => void): DocEditorEnv {
  const assets = useMemo(() => createAssetResolver((input) => hub.docAssets.resolve(input)), []);
  return useMemo(
    () => ({
      api,
      lang,
      errorMessage: hubErrorText,
      link: ({ to, className, children }) =>
        to.kind === "doc" ? (
          <button type="button" className={cn("cursor-pointer", className)} onClick={() => openDoc(to.key)}>
            {children}
          </button>
        ) : (
          <span className={className}>{children}</span>
        ),
      resolveLink: assets.resolveLink,
    }),
    [lang, openDoc, assets],
  );
}
