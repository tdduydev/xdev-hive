import { QueryClientProvider, useMutation, useQueries, useQuery } from "@tanstack/react-query";
import type { WordImportFile, WordImportFileState, WordImportGetOutput, WordImportState } from "@xdev-hive/contracts";
import { SECRET_KIND_LABELS } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@xdev-hive/ui/empty";
import { Input } from "@xdev-hive/ui/input";
import { Markdown } from "@xdev-hive/ui/markdown";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Pill, type PillProps } from "@xdev-hive/ui/pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@xdev-hive/ui/table";
import { FileTextIcon, FolderOpenIcon, UploadIcon } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import { useLinkedAccount } from "@/lib/account.ts";
import { hubFetchImage } from "@/lib/hub-bytes.ts";
import { api, queryClient } from "@/lib/hub-query.tsx";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import {
  dropLockFiles,
  formatBytes,
  importErrorText,
  isCommittable,
  normalizeTargetDir,
  onUploadProgress,
  type PickedWordFile,
  pickWordFiles,
  previewMarkdown,
  referencedImages,
  selectionIssues,
  stillWorking,
  targetDirIssue,
  type UploadProgress,
  uploadErrorText,
  uploadWordFiles,
  type WordPick,
  warningText,
} from "@/lib/word-import.ts";

const POLL_MS = 2000;
/** Bảng chọn chỉ liệt kê chừng này dòng; tổng số file và dung lượng vẫn tính trên cả lượt chọn. */
const MAX_ROWS = 50;

const text: Dict<{
  lead: string;
  home: string;
  homeNone: string;
  homeLoading: string;
  targetDir: string;
  targetDirHint: string;
  confidential: string;
  pickFiles: string;
  pickFolder: string;
  picked: (files: number, bytes: string) => string;
  pickedEmpty: string;
  moreRows: (n: number) => string;
  lockSkipped: (n: number) => string;
  truncated: string;
  upload: string;
  uploading: string;
  uploadProgress: (sent: string, total: string) => string;
  fileProgress: (name: string) => string;
  openImport: string;
  recent: string;
  recentEmpty: string;
  createOnlyDesktop: string;
  colFile: string;
  colSize: string;
  orgHome: (name?: string) => string;
  projectHome: (name: string) => string;
  findingLine: (line: number, kind: string) => string;
  importStates: Record<WordImportState, string>;
  colPath: string;
  colVersion: string;
  colState: string;
  colWarnings: string;
  captionFiles: string;
  states: Record<WordImportFileState, string>;
  waiting: string;
  commit: (n: number) => string;
  propose: (n: number) => string;
  cancel: string;
  another: string;
  detail: string;
  preview: string;
  previewLoading: string;
  noContent: string;
  images: string;
  imageAlt: (name: string) => string;
  warnings: string;
  secrets: string;
  acknowledge: string;
  acknowledgeOnlyManage: string;
  keepFront: string;
  keepFrontHint: string;
  loadFailed: string;
  retry: string;
  existsNote: string;
  done: (n: number) => string;
  proposed: (n: number) => string;
  needsWeb: string;
}> = {
  vi: {
    lead: "Chọn file Word (.docx, .odt, .doc) hoặc cả thư mục trên máy này, tải lên hub để chuyển thành Markdown rồi tạo tài liệu.",
    home: "Nhà tài liệu",
    homeNone: "Chưa có nhà tài liệu nào gắn repo. Bật tài liệu gắn repo cho tổ chức hoặc dự án trên web trước.",
    homeLoading: "Đang tải nhà tài liệu…",
    targetDir: "Thư mục đích",
    targetDirHint: "Dạng docs/srs/. Thư mục con trong thư mục đã chọn được giữ nguyên.",
    confidential: "Đánh dấu tài liệu bí mật",
    pickFiles: "Chọn file…",
    pickFolder: "Chọn thư mục…",
    picked: (files, bytes) => `${files} file, ${bytes}`,
    pickedEmpty: "Chưa chọn file nào.",
    moreRows: (n) => `Và ${n} file khác.`,
    lockSkipped: (n) => `Bỏ qua ${n} file tạm của Word (tên bắt đầu bằng ~$).`,
    truncated: "Thư mục có quá nhiều file nên app chỉ liệt kê một phần. Chọn thư mục con nhỏ hơn.",
    upload: "Tải lên",
    uploading: "Đang tải lên…",
    uploadProgress: (sent, total) => `Đã gửi ${sent} / ${total}`,
    fileProgress: (name) => `Tiến độ gửi ${name}`,
    openImport: "Mở",
    recent: "Các lượt nhập gần đây",
    recentEmpty: "Chưa có lượt nhập nào trong nhà này.",
    createOnlyDesktop: "Lượt này cập nhật hoặc gắn tài liệu có sẵn. Xử lý trên web của hub; app chỉ tạo tài liệu mới.",
    colFile: "File",
    colSize: "Dung lượng",
    orgHome: (name) => (name ? `Tổ chức ${name}` : "Tổ chức"),
    projectHome: (name) => `Dự án ${name}`,
    findingLine: (line, kind) => `dòng ${line} (${kind})`,
    importStates: {
      uploading: "Đang tải lên",
      converting: "Đang chuyển",
      ready: "Sẵn sàng",
      committing: "Đang tạo",
      done: "Xong",
      failed: "Lỗi",
      cancelled: "Đã huỷ",
    },
    colPath: "Đường dẫn tài liệu",
    colVersion: "Phiên bản",
    colState: "Trạng thái",
    colWarnings: "Cảnh báo",
    captionFiles: "Các file trong lượt nhập",
    states: {
      queued: "Chờ chuyển",
      converting: "Đang chuyển",
      ready: "Sẵn sàng",
      skipped: "Bỏ qua",
      blocked_secret: "Có bí mật",
      failed: "Lỗi",
      proposed: "Đã gửi duyệt",
      cancelled: "Đã huỷ",
      done: "Đã tạo",
    },
    waiting: "Hub đang chuyển file Word…",
    commit: (n) => `Tạo ${n} tài liệu`,
    propose: (n) => `Gửi duyệt ${n} tài liệu`,
    cancel: "Huỷ lượt này",
    another: "Nhập lượt khác",
    detail: "Chi tiết file",
    preview: "Xem trước (chỉ đọc)",
    previewLoading: "Đang tải nội dung…",
    noContent: "File này chưa có nội dung chuyển.",
    images: "Ảnh trong file",
    imageAlt: (name) => `Ảnh ${name}`,
    warnings: "Cảnh báo",
    secrets: "Hub thấy dấu hiệu bí mật",
    acknowledge: "Không phải bí mật, vẫn nhập",
    acknowledgeOnlyManage: "Chỉ người có quyền quản lý tài liệu mới nhập tiếp được file có dấu hiệu bí mật.",
    keepFront: "Giữ phần trước tiêu đề đầu tiên",
    keepFrontHint: "Mặc định bỏ trang bìa và mục lục. Bật để giữ lại; hub chuyển lại file này.",
    loadFailed: "Không tải được lượt nhập.",
    retry: "Thử lại",
    existsNote: "Đã có tài liệu ở đường dẫn này",
    done: (n) => `Đã tạo ${n} tài liệu.`,
    proposed: (n) => `Đã gửi duyệt ${n} tài liệu.`,
    needsWeb: "Mở web của hub để duyệt các đề xuất.",
  },
  en: {
    lead: "Pick Word files (.docx, .odt, .doc) or a whole folder on this machine, upload them to the hub to convert to Markdown, then create the docs.",
    home: "Docs home",
    homeNone:
      "No repo-backed docs home yet. Turn on repo-backed docs for the organization or a project on the web first.",
    homeLoading: "Loading docs homes…",
    targetDir: "Target folder",
    targetDirHint: "Like docs/srs/. Subfolders of the picked folder are kept.",
    confidential: "Mark docs as confidential",
    pickFiles: "Choose files…",
    pickFolder: "Choose folder…",
    picked: (files, bytes) => `${files} files, ${bytes}`,
    pickedEmpty: "No files chosen yet.",
    moreRows: (n) => `And ${n} more files.`,
    lockSkipped: (n) => `Skipped ${n} Word temp files (names starting with ~$).`,
    truncated: "The folder has too many files so only part is listed. Pick a smaller subfolder.",
    upload: "Upload",
    uploading: "Uploading…",
    uploadProgress: (sent, total) => `Sent ${sent} of ${total}`,
    fileProgress: (name) => `Upload progress of ${name}`,
    openImport: "Open",
    recent: "Recent imports",
    recentEmpty: "No imports in this home yet.",
    createOnlyDesktop:
      "This import updates or links existing docs. Handle it on the hub's web; the app only creates new docs.",
    colFile: "File",
    colSize: "Size",
    orgHome: (name) => (name ? `Organization ${name}` : "Organization"),
    projectHome: (name) => `Project ${name}`,
    findingLine: (line, kind) => `line ${line} (${kind})`,
    importStates: {
      uploading: "Uploading",
      converting: "Converting",
      ready: "Ready",
      committing: "Creating",
      done: "Done",
      failed: "Failed",
      cancelled: "Cancelled",
    },
    colPath: "Doc path",
    colVersion: "Version",
    colState: "State",
    colWarnings: "Warnings",
    captionFiles: "Files in the import",
    states: {
      queued: "Queued",
      converting: "Converting",
      ready: "Ready",
      skipped: "Skipped",
      blocked_secret: "Has secrets",
      failed: "Failed",
      proposed: "Sent for review",
      cancelled: "Cancelled",
      done: "Created",
    },
    waiting: "The hub is converting the Word files…",
    commit: (n) => `Create ${n} docs`,
    propose: (n) => `Send ${n} docs for review`,
    cancel: "Cancel this import",
    another: "Import another batch",
    detail: "File details",
    preview: "Preview (read only)",
    previewLoading: "Loading content…",
    noContent: "This file has no converted content yet.",
    images: "Images in the file",
    imageAlt: (name) => `Image ${name}`,
    warnings: "Warnings",
    secrets: "The hub found signs of secrets",
    acknowledge: "Not a secret, import anyway",
    acknowledgeOnlyManage: "Only people who manage docs can continue with files that show signs of secrets.",
    keepFront: "Keep content before the first heading",
    keepFrontHint:
      "By default the cover page and table of contents are dropped. Turn on to keep them; the hub converts the file again.",
    loadFailed: "Could not load the import.",
    retry: "Retry",
    existsNote: "A doc already exists at this path",
    done: (n) => `Created ${n} docs.`,
    proposed: (n) => `Sent ${n} docs for review.`,
    needsWeb: "Open the hub on the web to review the proposals.",
  },
};

const STATE_TONE: Record<WordImportFileState, NonNullable<PillProps["tone"]>> = {
  queued: "neutral",
  converting: "neutral",
  ready: "ok",
  skipped: "neutral",
  blocked_secret: "bad",
  failed: "bad",
  proposed: "sel",
  cancelled: "neutral",
  done: "ok",
};

export function WordImportScreen() {
  return (
    <QueryClientProvider client={queryClient}>
      <WordImportView />
    </QueryClientProvider>
  );
}

function WordImportView() {
  const t = useT(text);
  const [importId, setImportId] = useState<string | null>(null);
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <p className="text-sm text-muted-foreground">{t.lead}</p>
      {importId ? (
        <ImportDetail importId={importId} onLeave={() => setImportId(null)} />
      ) : (
        <PickStep onUploaded={setImportId} onOpen={setImportId} />
      )}
    </div>
  );
}

interface HomeOption {
  id: string;
  label: string;
  root: string;
  confidential: boolean;
}

/** Nhà tài liệu nhập vào được: kho của tổ chức và của từng dự án bật tài liệu gắn repo (như web). */
function useImportHomes(enabled: boolean) {
  const t = useT(text);
  const account = useLinkedAccount();
  const projects = useQuery({ ...api.projects.list.queryOptions({ input: {} }), enabled });
  const orgHome = useQuery({ ...api.docHomes.get.queryOptions({ input: {} }), enabled });
  const docProjects = (projects.data ?? []).filter((project) => project.settings.docs.enabled);
  const projectHomes = useQueries({
    queries: docProjects.map((project) => ({
      ...api.docHomes.get.queryOptions({ input: { project: project.key } }),
      enabled,
    })),
  });
  const homes: HomeOption[] = [];
  if (orgHome.data)
    homes.push({
      id: orgHome.data.id,
      label: t.orgHome(account?.orgName),
      root: orgHome.data.root,
      confidential: orgHome.data.wordImportConfidential,
    });
  docProjects.forEach((project, i) => {
    const home = projectHomes[i]?.data;
    if (home)
      homes.push({
        id: home.id,
        label: t.projectHome(project.name),
        root: home.root,
        confidential: home.wordImportConfidential,
      });
  });
  const queries = [projects, orgHome, ...projectHomes];
  return {
    homes,
    pending: queries.some((query) => query.isPending && query.fetchStatus !== "idle"),
    error: queries.find((query) => query.isError)?.error,
  };
}

function PickStep({
  onUploaded,
  onOpen,
}: {
  onUploaded: (importId: string) => void;
  onOpen: (importId: string) => void;
}) {
  const t = useT(text);
  const account = useLinkedAccount();
  const { homes, pending, error: homesError } = useImportHomes(!!account);
  const [pickedHome, setPickedHome] = useState("");
  const homeId = pickedHome || homes[0]?.id || "";
  const home = homes.find((item) => item.id === homeId);
  const [dir, setDir] = useState<string | null>(null);
  const [confidential, setConfidential] = useState<boolean | null>(null);
  const [pick, setPick] = useState<WordPick | null>(null);
  const [lockSkipped, setLockSkipped] = useState(0);
  const [progress, setProgress] = useState<Record<number, UploadProgress> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const uploadId = useRef("");
  const dirId = useId();
  const homeSelectId = useId();
  const dirHintId = useId();

  const targetDir = normalizeTargetDir(dir ?? home?.root ?? "");
  const files = useMemo(() => dropLockFiles(pick?.files ?? []).files, [pick]);
  const issues = selectionIssues(files);
  const dirIssue = home ? targetDirIssue(targetDir, home.root) : null;
  const uploading = progress !== null;
  const total = files.reduce((sum, file) => sum + file.size, 0);
  const canUpload = !!home && !dirIssue && files.length > 0 && issues.length === 0 && !uploading;

  async function choose(folder: boolean) {
    setError(null);
    try {
      const next = await pickWordFiles(folder);
      if (!next) return;
      setLockSkipped(dropLockFiles(next.files).dropped);
      setPick(next);
    } catch (e) {
      setError(uploadErrorText(e));
    }
  }

  async function upload() {
    if (!pick || !home) return;
    const id = crypto.randomUUID();
    uploadId.current = id;
    setProgress({});
    setError(null);
    const stop = await onUploadProgress((event) => {
      if (event.uploadId === uploadId.current) setProgress((prev) => ({ ...(prev ?? {}), [event.index]: event }));
    });
    try {
      const { importId } = await uploadWordFiles(
        id,
        pick.pickId,
        files.map((file) => file.index),
        { homeId: home.id, targetDir, confidential: confidential ?? home.confidential },
      );
      await queryClient.invalidateQueries({ queryKey: api.wordImports.key() });
      onUploaded(importId);
    } catch (e) {
      setError(uploadErrorText(e));
      setProgress(null);
    } finally {
      stop();
    }
  }

  const sent = Object.values(progress ?? {}).reduce((sum, item) => sum + item.sent, 0);

  if (pending && homes.length === 0) return <p className="text-sm text-muted-foreground">{t.homeLoading}</p>;
  if (homesError) return <Alert variant="destructive">{importErrorText(homesError)}</Alert>;
  if (homes.length === 0)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{t.home}</EmptyTitle>
          <EmptyDescription>{t.homeNone}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );

  return (
    <div className="flex flex-col gap-5">
      <section aria-label={t.home} className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <label htmlFor={homeSelectId} className="text-sm font-medium">
            {t.home}
          </label>
          <NativeSelect
            id={homeSelectId}
            value={homeId}
            disabled={uploading}
            onChange={(e) => {
              setPickedHome(e.target.value);
              setDir(null);
              setConfidential(null);
            }}
          >
            {homes.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <label htmlFor={dirId} className="text-sm font-medium">
            {t.targetDir}
          </label>
          <Input
            id={dirId}
            value={dir ?? home?.root ?? ""}
            disabled={uploading}
            aria-invalid={!!dirIssue}
            aria-describedby={dirHintId}
            placeholder="docs/srs/"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setDir(e.target.value)}
          />
          <p id={dirHintId} className={dirIssue ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
            {dirIssue ?? t.targetDirHint}
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input
            type="checkbox"
            className="size-4"
            checked={confidential ?? home?.confidential ?? false}
            disabled={uploading}
            onChange={(e) => setConfidential(e.target.checked)}
          />
          {t.confidential}
        </label>
      </section>

      <section aria-label={t.pickFiles} className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" disabled={uploading} onClick={() => void choose(false)}>
            <FileTextIcon aria-hidden="true" />
            {t.pickFiles}
          </Button>
          <Button variant="outline" size="sm" disabled={uploading} onClick={() => void choose(true)}>
            <FolderOpenIcon aria-hidden="true" />
            {t.pickFolder}
          </Button>
          <span className="text-sm text-muted-foreground" aria-live="polite">
            {files.length > 0 ? t.picked(files.length, formatBytes(total)) : t.pickedEmpty}
          </span>
        </div>
        {pick?.root && <p className="break-all font-mono text-xs text-muted-foreground">{pick.root}</p>}
        {pick?.truncated && <Alert role="note">{t.truncated}</Alert>}
        {lockSkipped > 0 && <Alert role="note">{t.lockSkipped(lockSkipped)}</Alert>}
        {issues.length > 0 && (
          <Alert variant="destructive">
            <ul className="grid gap-1">
              {issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </Alert>
        )}
        {files.length > 0 && <PickedTable files={files} progress={progress} />}
      </section>

      {error && <Alert variant="destructive">{error}</Alert>}

      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={!canUpload} onClick={() => void upload()}>
          <UploadIcon aria-hidden="true" />
          {uploading ? t.uploading : t.upload}
        </Button>
        {uploading && (
          <span className="text-sm text-muted-foreground" aria-live="polite">
            {t.uploadProgress(formatBytes(sent), formatBytes(total))}
          </span>
        )}
      </div>

      {home && <RecentImports homeId={home.id} onOpen={onOpen} disabled={uploading} />}
    </div>
  );
}

function PickedTable({
  files,
  progress,
}: {
  files: PickedWordFile[];
  progress: Record<number, UploadProgress> | null;
}) {
  const t = useT(text);
  const rows = files.slice(0, MAX_ROWS);
  return (
    <div className="grid gap-2">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t.colFile}</TableHead>
            <TableHead className="w-28 text-right">{t.colSize}</TableHead>
            {progress && <TableHead className="w-48">{t.uploading}</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((file) => {
            const item = progress?.[file.index];
            return (
              <TableRow key={file.index}>
                <TableCell className="break-all font-mono text-xs">{file.relativePath}</TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">{formatBytes(file.size)}</TableCell>
                {progress && (
                  <TableCell>
                    <progress
                      className="h-2 w-full"
                      aria-label={t.fileProgress(file.name)}
                      value={item?.sent ?? 0}
                      max={item?.size ?? file.size}
                    />
                  </TableCell>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {files.length > rows.length && (
        <p className="text-sm text-muted-foreground">{t.moreRows(files.length - rows.length)}</p>
      )}
    </div>
  );
}

function RecentImports({
  homeId,
  onOpen,
  disabled,
}: {
  homeId: string;
  onOpen: (id: string) => void;
  disabled: boolean;
}) {
  const t = useT(text);
  const lang = useLang();
  const list = useQuery(api.wordImports.list.queryOptions({ input: { homeId } }));
  const items = list.data?.items ?? [];
  return (
    <section aria-label={t.recent} className="grid gap-2">
      <h2 className="text-sm font-medium">{t.recent}</h2>
      {list.isError && <Alert variant="destructive">{importErrorText(list.error)}</Alert>}
      {!list.isError && items.length === 0 && !list.isPending && (
        <p className="text-sm text-muted-foreground">{t.recentEmpty}</p>
      )}
      <ul className="grid gap-1">
        {items.slice(0, 8).map((item) => (
          <li key={item.id} className="flex flex-wrap items-center gap-3 text-sm">
            <span className="tabular-nums text-muted-foreground">
              {new Intl.DateTimeFormat(lang, { dateStyle: "short", timeStyle: "short" }).format(
                new Date(item.createdAt),
              )}
            </span>
            <span>{item.createdBy.name ?? ""}</span>
            <span className="text-muted-foreground">{t.importStates[item.state]}</span>
            <Button variant="link" size="sm" disabled={disabled} onClick={() => onOpen(item.id)}>
              {t.openImport}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ImportDetail({ importId, onLeave }: { importId: string; onLeave: () => void }) {
  const t = useT(text);
  const query = useQuery({
    ...api.wordImports.get.queryOptions({ input: { importId } }),
    refetchInterval: (q) => (stillWorking(q.state.data) ? POLL_MS : false),
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: api.wordImports.key() });
  const commit = useMutation({
    mutationFn: (fileIds: string[]) => api.wordImports.commit.call({ importId, fileIds }),
    onSuccess: async (_, fileIds) => {
      setNotice(query.data?.access === "propose" ? t.proposed(fileIds.length) : t.done(fileIds.length));
      await refresh();
    },
  });
  const cancel = useMutation({
    mutationFn: () => api.wordImports.cancel.call({ importId }),
    onSuccess: refresh,
  });

  if (query.isPending) return <p className="text-sm text-muted-foreground">{t.waiting}</p>;
  if (query.isError)
    return (
      <div className="grid gap-2">
        <Alert variant="destructive">{importErrorText(query.error)}</Alert>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            {t.retry}
          </Button>
          <Button variant="outline" size="sm" onClick={onLeave}>
            {t.another}
          </Button>
        </div>
      </div>
    );

  const data: WordImportGetOutput = query.data;
  const proposing = data.access === "propose";
  const chosen = data.files.filter(isCommittable);
  const working = stillWorking(data);
  const open = data.import.state === "ready" || data.import.state === "converting" || data.import.state === "uploading";
  const file = data.files.find((item) => item.id === selected) ?? null;
  const createOnly = data.import.mode === "create";

  return (
    <div className="flex flex-col gap-4">
      {!createOnly && <Alert role="note">{t.createOnlyDesktop}</Alert>}
      <div className="flex flex-wrap items-center gap-2">
        {createOnly && open && (
          <Button
            disabled={chosen.length === 0 || working || commit.isPending}
            onClick={() => commit.mutate(chosen.map((item) => item.id))}
          >
            {proposing ? t.propose(chosen.length) : t.commit(chosen.length)}
          </Button>
        )}
        {open && (
          <Button variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
            {t.cancel}
          </Button>
        )}
        <Button variant="outline" onClick={onLeave}>
          {t.another}
        </Button>
        {working && (
          <span className="text-sm text-muted-foreground" aria-live="polite">
            {t.waiting}
          </span>
        )}
      </div>
      {notice && (
        <Alert role="status">
          {notice} {proposing && t.needsWeb}
        </Alert>
      )}
      {commit.isError && <Alert variant="destructive">{importErrorText(commit.error)}</Alert>}
      {cancel.isError && <Alert variant="destructive">{importErrorText(cancel.error)}</Alert>}
      <Table>
        <caption className="sr-only">{t.captionFiles}</caption>
        <TableHeader>
          <TableRow>
            <TableHead>{t.colFile}</TableHead>
            <TableHead>{t.colPath}</TableHead>
            <TableHead>{t.colVersion}</TableHead>
            <TableHead>{t.colState}</TableHead>
            <TableHead className="text-right">{t.colWarnings}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.files.map((item) => (
            <TableRow key={item.id} data-state={item.id === selected ? "selected" : undefined}>
              <TableCell className="max-w-64 break-all">
                <button
                  type="button"
                  className="text-left font-mono text-xs underline-offset-2 hover:underline focus-visible:outline-2"
                  aria-pressed={item.id === selected}
                  onClick={() => setSelected(item.id === selected ? null : item.id)}
                >
                  {item.relativeDir ? `${item.relativeDir}/${item.fileName}` : item.fileName}
                </button>
              </TableCell>
              <TableCell className="break-all font-mono text-xs">
                {item.path ?? "—"}
                {item.exists && <span className="ml-2 text-destructive">({t.existsNote})</span>}
              </TableCell>
              <TableCell className="tabular-nums">{item.versionLabel ?? "—"}</TableCell>
              <TableCell>
                <Pill tone={STATE_TONE[item.state]}>{t.states[item.state]}</Pill>
              </TableCell>
              <TableCell className="text-right tabular-nums">{item.warnings.length}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {file && <FilePanel file={file} access={data.access} />}
    </div>
  );
}

function FilePanel({ file, access }: { file: WordImportFile; access: WordImportGetOutput["access"] }) {
  const t = useT(text);
  const converting = file.state === "queued" || file.state === "converting";
  const detail = useQuery({
    ...api.wordImports.file.queryOptions({ input: { fileId: file.id } }),
    // `updatedAt` đổi khi hub chuyển xong lại (đổi "Giữ phần trước tiêu đề đầu tiên"), nên đưa vào khoá để tải lại.
    queryKey: [...api.wordImports.file.queryOptions({ input: { fileId: file.id } }).queryKey, file.updatedAt],
    refetchOnWindowFocus: false,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: api.wordImports.key() });
  const acknowledge = useMutation({
    mutationFn: () =>
      api.wordImports.commit.call({ importId: file.importId, fileIds: [file.id], acknowledgeSecrets: true }),
    onSuccess: refresh,
  });
  const update = useMutation({
    mutationFn: (keepFront: boolean) => api.wordImports.update.call({ fileId: file.id, keepFront }),
    onSuccess: refresh,
  });
  const markdown = detail.data?.markdown ?? null;
  const preview = useMemo(() => (markdown === null ? null : previewMarkdown(markdown)), [markdown]);
  const shown = useMemo(
    () => referencedImages(markdown ?? "", detail.data?.images ?? []),
    [markdown, detail.data?.images],
  );
  // Ảnh tải qua Rust (token nằm trong keychain) thành `data:` vì CSP của app không cho `blob:`.
  const pictures = useQueries({
    queries: shown.map((image) => ({
      queryKey: ["word-import-image", image.url],
      queryFn: () => hubFetchImage(image.url),
      staleTime: Number.POSITIVE_INFINITY,
    })),
  });
  const canEdit = access === "manage" && !converting && file.state !== "done" && file.state !== "proposed";

  return (
    <section aria-label={t.detail} className="grid gap-3 rounded-lg border border-border p-4">
      <h2 className="break-all text-sm font-medium">{file.title ?? file.fileName}</h2>
      {file.error && <Alert variant="destructive">{file.error.message}</Alert>}
      {file.state === "blocked_secret" && (
        <div className="grid gap-2">
          <Alert variant="destructive">
            {t.secrets}: {file.findings.map((f) => t.findingLine(f.line, SECRET_KIND_LABELS[f.kind])).join("; ")}
          </Alert>
          {access === "manage" ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" disabled={acknowledge.isPending} onClick={() => acknowledge.mutate()}>
                {t.acknowledge}
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t.acknowledgeOnlyManage}</p>
          )}
          {acknowledge.isError && <Alert variant="destructive">{importErrorText(acknowledge.error)}</Alert>}
        </div>
      )}
      {file.warnings.length > 0 && (
        <div className="grid gap-2">
          <h3 className="text-sm font-medium">
            {t.warnings} ({file.warnings.length})
          </h3>
          <ul className="grid gap-2">
            {file.warnings.map((warning) => (
              <li key={warning.code}>
                <Alert role="note">{warningText(warning)}</Alert>
              </li>
            ))}
          </ul>
        </div>
      )}
      {canEdit && (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4"
            checked={file.keepFront}
            disabled={update.isPending}
            onChange={(e) => update.mutate(e.target.checked)}
          />
          <span className="grid gap-0.5">
            {t.keepFront}
            <span className="text-muted-foreground">{t.keepFrontHint}</span>
          </span>
        </label>
      )}
      {update.isError && <Alert variant="destructive">{importErrorText(update.error)}</Alert>}
      <div className="grid min-w-0 gap-2">
        <h3 className="text-sm font-medium">{t.preview}</h3>
        {(converting || detail.isPending) && <p className="text-sm text-muted-foreground">{t.previewLoading}</p>}
        {detail.isError && <Alert variant="destructive">{importErrorText(detail.error)}</Alert>}
        {preview !== null && !converting && (
          <div className="min-w-0 overflow-x-auto rounded-lg border border-border p-3">
            <Markdown content={preview} lang="vi" />
          </div>
        )}
        {markdown === null && !converting && !detail.isPending && !detail.isError && (
          <p className="text-sm text-muted-foreground">{t.noContent}</p>
        )}
      </div>
      {shown.length > 0 && (
        <div className="grid gap-2">
          <h3 className="text-sm font-medium">{t.images}</h3>
          <div className="flex flex-wrap gap-3">
            {shown.map((image, i) => {
              const src = pictures[i]?.data;
              return src ? (
                <img
                  key={image.name}
                  src={src}
                  alt={t.imageAlt(image.name)}
                  className="max-h-48 max-w-full rounded border border-border object-contain"
                />
              ) : null;
            })}
          </div>
        </div>
      )}
    </section>
  );
}
