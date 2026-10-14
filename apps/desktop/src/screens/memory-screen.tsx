import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Textarea } from "@xdev-hive/ui/textarea";
import { RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import {
  applyMemory,
  canMergeMemory,
  type MemoryConflict,
  type MemoryFile,
  type MemoryInventory,
  type MemoryOperation,
  type MemoryProject,
  memoryTree,
  readMemory,
  scanMemory,
} from "@/lib/memory-store.ts";
import { errorText } from "@/lib/tauri.ts";

interface Text {
  title: string;
  lead: string;
  refresh: string;
  loading: string;
  empty: string;
  session: string;
  global: string;
  files: string;
  tokens: string;
  modified: string;
  flags: Record<string, string>;
  limit: (n: number) => string;
  select: string;
  content: string;
  save: string;
  saved: string;
  backup: string;
  database: string;
  delete: string;
  deleteTitle: string;
  deleteHint: string;
  confirm: string;
  cancel: string;
  merge: string;
  preview: string;
  target: string;
  mergeHint: string;
  apply: string;
  share: string;
  unshare: string;
  shared: string;
  shareHint: string;
  conflicts: string;
  keep: string;
  view: string;
  history: string;
  historyHint: string;
  restore: string;
  trash: string;
  backups: string;
  noHistory: string;
  operations: Record<string, string>;
}

const text: Dict<Text> = {
  vi: {
    title: "Memory",
    lead: "Memory và hướng dẫn trên máy, dùng được khi chưa đăng nhập. Token là số ước tính.",
    refresh: "Đọc lại",
    loading: "Đang đọc…",
    empty: "Chưa tìm thấy memory hoặc hướng dẫn trên máy.",
    session: "Token nạp mỗi phiên theo dự án và gói",
    global: "Hướng dẫn cấp người dùng",
    files: "file",
    tokens: "token",
    modified: "Sửa",
    flags: { duplicate: "Trùng", stale: "Cũ", "broken-link": "Link chết", orphan: "Mồ côi", "over-limit": "Vượt trần" },
    limit: (n) => `Vượt ${n.toLocaleString("vi-VN")} token`,
    select: "Chọn file để xem hoặc sửa. Đánh dấu các file cùng dự án để gộp.",
    content: "Nội dung",
    save: "Lưu và sao lưu",
    saved: "Đã áp dụng và cập nhật danh sách.",
    backup: "Mỗi thao tác được sao lưu trước khi ghi. Có thể khôi phục ở mục bên dưới.",
    database: "Cơ sở dữ liệu Codex: chỉ hiển thị dung lượng, không sửa.",
    delete: "Xoá",
    deleteTitle: "Chuyển file vào thùng rác?",
    deleteHint: "File và dòng chỉ mục liên quan sẽ được cập nhật. Có thể khôi phục trong 30 ngày.",
    confirm: "Chuyển vào thùng rác",
    cancel: "Huỷ",
    merge: "Gộp file đã chọn",
    preview: "Xem trước bản gộp",
    target: "File đích",
    mergeHint:
      "Sửa bản gộp trước khi áp dụng. File nguồn khác file đích sẽ vào thùng rác; link và chỉ mục được cập nhật.",
    apply: "Áp dụng bản gộp",
    share: "Dùng chung memory",
    unshare: "Tắt dùng chung",
    shared: "Đang dùng chung memory",
    shareHint: "Gom memory Claude theo dự án. Nếu khác nội dung, chọn bản cần giữ; tắt sẽ trả mỗi gói một bản sao.",
    conflicts: "Chọn bản memory cần giữ",
    keep: "Áp dụng lựa chọn",
    view: "Xem bản này",
    history: "Thùng rác và sao lưu",
    historyHint: "Giữ trong 30 ngày. Khôi phục trả lại file và chỉ mục của lần thao tác đã chọn.",
    restore: "Khôi phục",
    trash: "Thùng rác",
    backups: "Sao lưu",
    noHistory: "Chưa có bản sao lưu.",
    operations: {
      edit: "Sửa",
      delete: "Xoá",
      merge: "Gộp",
      share: "Dùng chung",
      unshare: "Tắt dùng chung",
      restore: "Khôi phục",
    },
  },
  en: {
    title: "Memory",
    lead: "Local memory and instructions, available without signing in. Token counts are estimates.",
    refresh: "Reload",
    loading: "Reading…",
    empty: "No local memory or instructions found.",
    session: "Tokens loaded per session by project and profile",
    global: "User instructions",
    files: "files",
    tokens: "tokens",
    modified: "Modified",
    flags: {
      duplicate: "Duplicate",
      stale: "Stale",
      "broken-link": "Broken link",
      orphan: "Orphan",
      "over-limit": "Over limit",
    },
    limit: (n) => `${n.toLocaleString("en-US")} tokens over limit`,
    select: "Select a file to view or edit. Check files from the same project to merge.",
    content: "Content",
    save: "Save with backup",
    saved: "Applied and refreshed the inventory.",
    backup: "Every write is backed up first. Restore it from the history below.",
    database: "Codex database: size only, editing unavailable.",
    delete: "Delete",
    deleteTitle: "Move file to trash?",
    deleteHint: "The file and related index entries will be updated. Restore within 30 days.",
    confirm: "Move to trash",
    cancel: "Cancel",
    merge: "Merge selected files",
    preview: "Merge preview",
    target: "Target file",
    mergeHint:
      "Review the merged content before applying. Other source files go to trash; links and indexes are updated.",
    apply: "Apply merge",
    share: "Share memory",
    unshare: "Stop sharing",
    shared: "Sharing memory",
    shareHint:
      "Combine Claude memory by project. Choose a version when content differs; stopping returns a copy to each profile.",
    conflicts: "Choose memory versions to keep",
    keep: "Apply choices",
    view: "View this version",
    history: "Trash and backups",
    historyHint: "Kept for 30 days. Restore the files and index from the selected operation.",
    restore: "Restore",
    trash: "Trash",
    backups: "Backup",
    noHistory: "No backups yet.",
    operations: {
      edit: "Edit",
      delete: "Delete",
      merge: "Merge",
      share: "Share",
      unshare: "Stop sharing",
      restore: "Restore",
    },
  },
};

interface MergePreview {
  sources: string[];
  target: string;
  content: string;
}

interface ShareReview {
  project: string;
  folder?: string;
  conflicts: MemoryConflict[];
  picks: Record<string, string>;
}

export function MemoryScreen() {
  const t = useT(text);
  const lang = useLang();
  const [inventory, setInventory] = useState<MemoryInventory | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<string[]>([]);
  const [opened, setOpened] = useState<MemoryFile | null>(null);
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [reading, setReading] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<MemoryFile | null>(null);
  const [merge, setMerge] = useState<MergePreview | null>(null);
  const [share, setShare] = useState<ShareReview | null>(null);
  // File đọc chậm không được ghi đè nội dung của file người dùng chọn sau đó.
  const readGeneration = useRef(0);
  const date = (at: string) => new Date(at).toLocaleString(lang === "vi" ? "vi-VN" : "en-US");

  const reload = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      setInventory(await scanMemory());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    return () => {
      readGeneration.current++;
    };
  }, [reload]);

  const resetEditor = () => {
    readGeneration.current++;
    setReading(false);
    setOpened(null);
    setContent("");
    setOriginal("");
    setSelected([]);
    setDeleting(null);
    setMerge(null);
  };

  const open = async (file: MemoryFile) => {
    const generation = ++readGeneration.current;
    setOpened(file);
    setContent("");
    setOriginal("");
    setError("");
    setReading(true);
    try {
      const value = await readMemory(file.path);
      if (generation === readGeneration.current) {
        setContent(value);
        setOriginal(value);
      }
    } catch (e) {
      if (generation === readGeneration.current) {
        setError(errorText(e));
        setOpened(null);
      }
    } finally {
      if (generation === readGeneration.current) setReading(false);
    }
  };

  const apply = async (operation: MemoryOperation) => {
    setBusy(true);
    setError("");
    setNotice([]);
    try {
      const result = await applyMemory(operation);
      if (!result.applied) {
        if (operation.action === "share" && result.conflicts?.length) {
          setShare({
            project: operation.project,
            ...(operation.folder ? { folder: operation.folder } : {}),
            conflicts: result.conflicts,
            picks: operation.picks ?? {},
          });
        }
        setNotice(result.warnings ?? []);
        return;
      }
      resetEditor();
      setShare(null);
      setNotice([t.saved, ...(result.warnings ?? [])]);
      setInventory(await scanMemory());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const picked = inventory?.files.filter((f) => selected.includes(f.path)) ?? [];
  const prepareMerge = async () => {
    const first = picked[0];
    if (!first || picked.length < 2) return;
    setBusy(true);
    setError("");
    try {
      const parts = await Promise.all(
        picked.map(async (f) => `<!-- ${f.name} · ${f.profile} -->\n${await readMemory(f.path)}`),
      );
      setMerge({ sources: picked.map((f) => f.path), target: first.path, content: parts.join("\n\n") });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const sharing = (project: MemoryProject) => {
    const active = inventory?.shared.some((s) => s.key === project.key);
    const folder = project.path ?? inventory?.shared.find((s) => s.key === project.key)?.projectPath;
    return (
      <div className="my-2 flex flex-wrap items-center gap-2">
        {active && <span className="text-sm text-primary">{t.shared}</span>}
        <Button
          size="sm"
          variant="outline"
          disabled={busy || share !== null}
          onClick={() =>
            void apply(
              active
                ? { action: "unshare", project: project.key }
                : { action: "share", project: project.key, ...(folder ? { folder } : {}) },
            )
          }
        >
          {active ? t.unshare : t.share}
        </Button>
        <span className="text-xs text-muted-foreground">{t.shareHint}</span>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">{t.title}</h1>
          <p className="text-sm text-muted-foreground">{t.lead}</p>
        </div>
        <Button
          variant="outline"
          disabled={busy || reading}
          onClick={() => {
            resetEditor();
            setShare(null);
            setNotice([]);
            void reload();
          }}
        >
          <RefreshCwIcon />
          {t.refresh}
        </Button>
      </header>
      {error && (
        <Alert variant="destructive" role="alert">
          {error}
        </Alert>
      )}
      {notice.length > 0 && (
        <div role="status" className="text-sm text-muted-foreground">
          {[...new Set(notice)].map((n) => (
            <p key={n}>{n}</p>
          ))}
        </div>
      )}
      {[...new Set(inventory?.warnings ?? [])].map((warning) => (
        <Alert key={warning}>{warning}</Alert>
      ))}
      {busy && (
        <p role="status" className="text-sm text-muted-foreground">
          {t.loading}
        </p>
      )}
      {inventory && (
        <>
          <section aria-label={t.session} className="rounded-lg border p-4">
            <h2 className="mb-2 text-sm font-semibold">{t.session}</h2>
            <ul className="space-y-1 text-sm">
              {inventory.sessions.map((s) => (
                <li key={`${s.cli}-${s.projectKey}-${s.profile}`} className="flex flex-wrap justify-between gap-2">
                  <span>
                    {s.cli} · {s.projectPath || s.projectKey} · {s.profile}
                  </span>
                  <strong>
                    {s.sessionTokens.toLocaleString(lang)} {t.tokens}
                  </strong>
                </li>
              ))}
            </ul>
          </section>
          {inventory.files.length === 0 && <p className="text-sm text-muted-foreground">{t.empty}</p>}
          <div className="grid gap-6 lg:grid-cols-2">
            <section aria-label={t.title} className="min-w-0 rounded-lg border p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">{t.select}</p>
                <Button size="sm" disabled={busy || picked.length < 2} onClick={() => void prepareMerge()}>
                  {t.merge}
                </Button>
              </div>
              {memoryTree(inventory.files).map((cli) => (
                <details open key={cli.cli} className="mb-3">
                  <summary className="cursor-pointer font-semibold">{cli.cli}</summary>
                  {cli.projects.map((project) => (
                    <details open key={project.key} className="ml-3 mt-2">
                      <summary className="cursor-pointer break-all text-sm font-medium">
                        {project.path || project.key || t.global}
                      </summary>
                      {cli.cli === "claude" &&
                        project.key &&
                        project.profiles.some((p) => p.files.some((f) => f.kind === "memory")) &&
                        sharing(project)}
                      {project.profiles.map((profile) => (
                        <details open key={profile.id} className="ml-3 mt-2">
                          <summary className="cursor-pointer text-sm">
                            {profile.id} · {profile.files.length} {t.files} ·{" "}
                            {profile.files.reduce((sum, f) => sum + f.tokens, 0).toLocaleString(lang)} {t.tokens}
                          </summary>
                          <ul className="ml-3 divide-y">
                            {profile.files.map((file) => (
                              <li key={file.path} className="py-2">
                                <div className="flex items-center gap-2">
                                  {canMergeMemory(file) && (
                                    <input
                                      type="checkbox"
                                      aria-label={`${t.merge}: ${file.path}`}
                                      checked={selected.includes(file.path)}
                                      disabled={
                                        busy ||
                                        (picked.length > 0 &&
                                          (picked[0]?.cli !== file.cli || picked[0]?.projectKey !== file.projectKey))
                                      }
                                      onChange={(e) =>
                                        setSelected((values) =>
                                          e.target.checked
                                            ? [...values, file.path]
                                            : values.filter((v) => v !== file.path),
                                        )
                                      }
                                    />
                                  )}
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={busy || file.kind === "database"}
                                    aria-pressed={opened?.path === file.path}
                                    onClick={() => void open(file)}
                                  >
                                    {file.name}
                                  </Button>
                                  <span className="text-xs text-muted-foreground">
                                    {file.kind === "database"
                                      ? `${file.size.toLocaleString(lang)} B`
                                      : `${file.tokens.toLocaleString(lang)} ${t.tokens}`}
                                  </span>
                                </div>
                                <p className="break-all text-xs text-muted-foreground">{file.path}</p>
                                <p className="text-xs text-muted-foreground">
                                  {t.modified}: {date(file.modifiedAt)}
                                </p>
                                {file.kind === "database" && (
                                  <p className="text-xs text-muted-foreground">{t.database}</p>
                                )}
                                <div className="flex flex-wrap gap-1">
                                  {file.flags?.map((flag) => (
                                    <span
                                      key={flag.code}
                                      title={[flag.message, ...(flag.related ?? [])].join("\n")}
                                      className="rounded bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-400"
                                    >
                                      {t.flags[flag.code] ?? flag.message}
                                      {flag.code === "over-limit" && (
                                        <span>
                                          {" "}
                                          ·{" "}
                                          {t.limit(
                                            Math.max(0, file.tokens - (file.name === "MEMORY.md" ? 1500 : 2000)),
                                          )}
                                        </span>
                                      )}
                                    </span>
                                  ))}
                                </div>
                              </li>
                            ))}
                          </ul>
                        </details>
                      ))}
                    </details>
                  ))}
                </details>
              ))}
            </section>
            <section aria-label={t.content} className="min-w-0 space-y-3 rounded-lg border p-4">
              {opened ? (
                <>
                  <h2 className="break-all text-sm font-semibold">{opened.path}</h2>
                  <p className="text-xs text-muted-foreground">{t.backup}</p>
                  {reading ? (
                    <p role="status">{t.loading}</p>
                  ) : (
                    <>
                      <Textarea
                        aria-label={t.content}
                        className="min-h-72 font-mono"
                        value={content}
                        disabled={busy}
                        onChange={(e) => setContent(e.target.value)}
                      />
                      <div className="flex gap-2">
                        <Button
                          disabled={busy || content === original}
                          onClick={() => void apply({ action: "edit", path: opened.path, content })}
                        >
                          {t.save}
                        </Button>
                        <Button
                          variant="destructive"
                          disabled={busy || opened.name === "MEMORY.md"}
                          onClick={() => setDeleting(opened)}
                        >
                          {t.delete}
                        </Button>
                      </div>
                    </>
                  )}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">{t.select}</p>
              )}
            </section>
          </div>
          {deleting && (
            <section aria-label={t.deleteTitle} className="space-y-3 rounded-lg border p-4">
              <h2 className="font-semibold">{t.deleteTitle}</h2>
              <p className="break-all text-sm">{deleting.path}</p>
              <p className="text-sm text-muted-foreground">{t.deleteHint}</p>
              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={() => void apply({ action: "delete", path: deleting.path })}
                >
                  {t.confirm}
                </Button>
                <Button variant="outline" disabled={busy} onClick={() => setDeleting(null)}>
                  {t.cancel}
                </Button>
              </div>
            </section>
          )}
          {merge && (
            <section aria-label={t.preview} className="space-y-3 rounded-lg border p-4">
              <h2 className="font-semibold">{t.preview}</h2>
              <p className="text-sm text-muted-foreground">{t.mergeHint}</p>
              <ul className="text-xs">
                {merge.sources.map((path) => (
                  <li key={path} className="break-all">
                    {path}
                  </li>
                ))}
              </ul>
              <label className="flex flex-col gap-1 text-sm">
                {t.target}
                <select
                  className="rounded border p-2"
                  disabled={busy}
                  value={merge.target}
                  onChange={(e) => setMerge({ ...merge, target: e.target.value })}
                >
                  {merge.sources.map((path) => (
                    <option key={path} value={path}>
                      {path}
                    </option>
                  ))}
                </select>
              </label>
              <Textarea
                aria-label={t.preview}
                className="min-h-60 font-mono"
                value={merge.content}
                disabled={busy}
                onChange={(e) => setMerge({ ...merge, content: e.target.value })}
              />
              <div className="flex gap-2">
                <Button disabled={busy} onClick={() => void apply({ action: "merge", ...merge })}>
                  {t.apply}
                </Button>
                <Button variant="outline" disabled={busy} onClick={() => setMerge(null)}>
                  {t.cancel}
                </Button>
              </div>
            </section>
          )}
          {share && (
            <section aria-label={t.conflicts} className="space-y-3 rounded-lg border p-4">
              <h2 className="font-semibold">{t.conflicts}</h2>
              {share.conflicts.map((conflict) => (
                <fieldset key={conflict.name} className="space-y-2 rounded border p-3">
                  <legend className="px-1 text-sm font-medium">{conflict.name}</legend>
                  {conflict.candidates.map((candidate) => (
                    <div key={candidate.profile} className="flex flex-wrap items-center gap-2 text-sm">
                      <label className="flex items-center gap-2">
                        <input
                          type="radio"
                          name={`keep-${conflict.name}`}
                          disabled={busy}
                          checked={share.picks[conflict.name] === candidate.profile}
                          onChange={() =>
                            setShare({ ...share, picks: { ...share.picks, [conflict.name]: candidate.profile } })
                          }
                        />
                        {candidate.profile} · {candidate.tokens} {t.tokens} · {date(candidate.modifiedAt)}
                      </label>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => {
                          const file = inventory.files.find((f) => f.path === candidate.path);
                          if (file) void open(file);
                        }}
                      >
                        {t.view}
                      </Button>
                    </div>
                  ))}
                </fieldset>
              ))}
              <div className="flex gap-2">
                <Button
                  disabled={busy || share.conflicts.some((c) => !share.picks[c.name])}
                  onClick={() =>
                    void apply({
                      action: "share",
                      project: share.project,
                      ...(share.folder ? { folder: share.folder } : {}),
                      picks: share.picks,
                    })
                  }
                >
                  {t.keep}
                </Button>
                <Button variant="outline" disabled={busy} onClick={() => setShare(null)}>
                  {t.cancel}
                </Button>
              </div>
            </section>
          )}
          <section aria-label={t.history} className="space-y-3 rounded-lg border p-4">
            <h2 className="text-sm font-semibold">{t.history}</h2>
            <p className="text-xs text-muted-foreground">{t.historyHint}</p>
            {inventory.entries.length === 0 && <p className="text-sm text-muted-foreground">{t.noHistory}</p>}
            <ul className="divide-y">
              {inventory.entries.map((entry) => (
                <li key={entry.id} className="flex items-start justify-between gap-3 py-2 text-sm">
                  <div>
                    <p>
                      {entry.trash ? t.trash : t.backups} · {t.operations[entry.op] ?? entry.op} ·{" "}
                      {date(entry.createdAt)}
                    </p>
                    {entry.paths.map((path) => (
                      <p key={path} className="break-all text-xs text-muted-foreground">
                        {path}
                      </p>
                    ))}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void apply({ action: "restore", id: entry.id })}
                  >
                    {t.restore}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
