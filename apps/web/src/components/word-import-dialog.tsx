import { useQueries, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  type DocTreeItem,
  docRepoPath,
  WORD_IMPORT_DEFAULT_LIMITS,
  WORD_IMPORT_ERRORS,
  WORD_IMPORT_UPLOAD_PATH,
  type WordImportErrorCode,
  type WordImportMode,
  wordImportFormatOf,
  wordImportUploadOutput,
} from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { Input } from "@xdev-hive/ui/input";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { FileTextIcon, FolderOpenIcon, UploadIcon, XIcon } from "lucide-react";
import { type DragEvent, useId, useRef, useState } from "react";
import { SwitchRow } from "@/components/page/settings.tsx";
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress.tsx";
import { LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { useWordImportSupport } from "@/lib/build-info.ts";
import { useDocTree } from "@/pages/knowledge/doc-tree.tsx";
import { useOrg } from "@/shell/org-context.ts";

/** Một file đã chọn; `dir` là thư mục con dưới thư mục đích (không có `/` cuối, không gồm tên file). */
export interface PickedFile {
  file: File;
  dir: string;
}

const LIMITS = WORD_IMPORT_DEFAULT_LIMITS;
/** Duyệt thư mục thả vào dừng ở đây để một ổ đĩa lỡ kéo vào không treo trình duyệt; vượt 100 file thì đằng nào cũng bị chặn. */
const MAX_WALKED = 5000;
const MAX_ROWS = 200;
const MAX_SUGGESTIONS = 200;

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 || Number.isInteger(value) ? String(value) : value.toFixed(1).replace(".", ",");
  return `${text} ${units[unit]}`;
}

const dirOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/** File từ ô chọn: ô "chọn thư mục" cho `webkitRelativePath` dạng `SRS/OPD/a.docx`, ô chọn file thì để trống. */
export function pickedFromFiles(files: Iterable<File>): PickedFile[] {
  return [...files].map((file) => ({ file, dir: dirOf(file.webkitRelativePath ?? "") }));
}

/**
 * File từ thao tác thả. Chỉ gọi `webkitGetAsEntry` trước lần `await` đầu tiên vì danh sách thả hết hiệu lực khi sự kiện
 * kết thúc; trình duyệt không có hàm này thì rơi về `files` (mất thư mục con nhưng vẫn nhận được file).
 */
export async function pickedFromDataTransfer(data: DataTransfer): Promise<PickedFile[]> {
  const items = [...data.items].filter((item) => item.kind === "file");
  const entries = items.map((item) => item.webkitGetAsEntry?.() ?? null);
  if (entries.length === 0 || entries.every((entry) => entry === null)) return pickedFromFiles(data.files);
  const out: PickedFile[] = [];
  const budget = { left: MAX_WALKED };
  for (const entry of entries) {
    if (entry) await walkEntry(entry, out, budget);
  }
  return out;
}

async function walkEntry(entry: FileSystemEntry, out: PickedFile[], budget: { left: number }): Promise<void> {
  if (budget.left <= 0) return;
  if (entry.isFile) {
    budget.left -= 1;
    const file = await new Promise<File | null>((resolve) =>
      (entry as FileSystemFileEntry).file(resolve, () => resolve(null)),
    );
    if (file) out.push({ file, dir: dirOf(entry.fullPath.replace(/^\//, "")) });
    return;
  }
  if (!entry.isDirectory) return;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  // readEntries trả từng lô (Chrome tối đa 100): đọc tới khi hết.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve) => reader.readEntries(resolve, () => resolve([])));
    if (batch.length === 0) return;
    for (const child of batch) await walkEntry(child, out, budget);
  }
}

export interface SkippedCounts {
  notWord: number;
  doc: number;
  temp: number;
}

/** Word tạo `~$tên.docx` làm file khoá khi đang mở tài liệu; không phải tài liệu nên bỏ lặng lẽ khỏi danh sách. */
const isLockFile = (name: string) => name.startsWith("~$");

export function filterWordFiles(
  picked: PickedFile[],
  options: { doc: boolean },
): { accepted: PickedFile[]; skipped: SkippedCounts } {
  const accepted: PickedFile[] = [];
  const skipped: SkippedCounts = { notWord: 0, doc: 0, temp: 0 };
  for (const item of picked) {
    const format = wordImportFormatOf(item.file.name);
    if (isLockFile(item.file.name)) skipped.temp += 1;
    else if (!format) skipped.notWord += 1;
    else if (format === "doc" && !options.doc) skipped.doc += 1;
    else accepted.push(item);
  }
  return { accepted, skipped };
}

const identity = (p: PickedFile) => `${p.dir}\n${p.file.name}\n${p.file.size}\n${p.file.lastModified}`;

export function mergePicked(current: PickedFile[], added: PickedFile[]): PickedFile[] {
  const seen = new Set(current.map(identity));
  const fresh = added.filter((item) => {
    if (seen.has(identity(item))) return false;
    seen.add(identity(item));
    return true;
  });
  return [...current, ...fresh];
}

/** Chặn sớm ở trình duyệt (FR-002). Hub vẫn kiểm lại, và giới hạn thật do quản trị đặt, nên đây chỉ là mặc định. */
export function selectionIssues(picked: PickedFile[], limits = LIMITS): string[] {
  const issues: string[] = [];
  const mb = formatBytes;
  if (picked.length > limits.batchFiles)
    issues.push(
      `Quá ${limits.batchFiles} file một lượt (đang chọn ${picked.length}). Bỏ bớt hoặc chia làm nhiều lượt.`,
    );
  const total = picked.reduce((sum, item) => sum + item.file.size, 0);
  if (total > limits.batchBytes)
    issues.push(
      `Tổng dung lượng ${mb(total)} vượt ${mb(limits.batchBytes)} một lượt. Bỏ bớt hoặc chia làm nhiều lượt.`,
    );
  const big = picked.filter((item) => item.file.size > limits.fileBytes);
  for (const item of big.slice(0, 3))
    issues.push(
      `${item.file.name} (${mb(item.file.size)}) vượt ${mb(limits.fileBytes)} một file. Nén ảnh trong Word hoặc tách thành nhiều file.`,
    );
  if (big.length > 3) issues.push(`Và ${big.length - 3} file khác cũng vượt ${mb(limits.fileBytes)} một file.`);
  const badDirs = [
    ...new Set(picked.map((item) => item.dir).filter((dir) => dir && !docRepoPath.safeParse(dir).success)),
  ];
  for (const dir of badDirs.slice(0, 3))
    issues.push(
      `Thư mục "${dir}" có ký tự hub không nhận (\\ : hoặc tên rỗng, "." , ".."). Đổi tên thư mục rồi chọn lại.`,
    );
  return issues;
}

export function skippedNotes(skipped: SkippedCounts): string[] {
  const notes: string[] = [];
  if (skipped.notWord) notes.push(`Bỏ qua ${skipped.notWord} file không phải Word (chỉ nhận .docx, .odt, .doc).`);
  if (skipped.doc)
    notes.push(
      `Bỏ qua ${skipped.doc} file .doc: hub chưa cài LibreOffice nên chỉ nhận .docx và .odt. Lưu lại thành .docx trong Word rồi chọn lại.`,
    );
  if (skipped.temp) notes.push(`Bỏ qua ${skipped.temp} file tạm của Word (tên bắt đầu bằng ~$).`);
  return notes;
}

/** `docs/srs` → `docs/srs/`; bỏ khoảng trắng, `./`, `/` đầu và đổi `\` thành `/`. Rỗng là gốc repo. */
export function normalizeTargetDir(input: string): string {
  const parts = input
    .trim()
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part !== "" && part !== ".");
  return parts.length ? `${parts.join("/")}/` : "";
}

export function targetDirIssue(dir: string, root: string): string | null {
  const home = normalizeTargetDir(root);
  if (dir && !docRepoPath.safeParse(dir).success)
    return "Đường dẫn thư mục không hợp lệ. Dùng dạng docs/srs/, không có .. và không có dấu \\ hay :.";
  if (!dir.startsWith(home)) return `Thư mục đích phải nằm trong ${home || "gốc repo"} của nhà tài liệu này.`;
  return null;
}

/** Gợi ý từ cây tài liệu: thư mục chứa tài liệu của nhà (và các thư mục cha) nằm trong gốc nhà. */
export function dirSuggestions(
  items: Pick<DocTreeItem, "homeId" | "path" | "kind">[],
  homeId: string,
  root: string,
): string[] {
  const home = normalizeTargetDir(root);
  const dirs = new Set<string>(home ? [home] : []);
  for (const item of items) {
    if (item.homeId !== homeId || item.kind !== "doc" || !item.path) continue;
    const parts = item.path.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i += 1) {
      const dir = `${parts.slice(0, i).join("/")}/`;
      if (dir.startsWith(home)) dirs.add(dir);
    }
  }
  return [...dirs].sort().slice(0, MAX_SUGGESTIONS);
}

export interface UploadFormInput {
  homeId: string;
  mode: WordImportMode;
  targetDir?: string;
  docKey?: string;
  confidential?: boolean;
  picked: PickedFile[];
}

/** Trường multipart đúng `wordImportUploadInput`; phần tử thứ i của `relativePaths`, `lastModified` đi với file thứ i. */
export function buildUploadForm(input: UploadFormInput): FormData {
  const form = new FormData();
  form.append("homeId", input.homeId);
  form.append("mode", input.mode);
  if (input.mode === "create") {
    form.append("targetDir", input.targetDir ?? "");
    // false cũng gửi: người nhập tắt ô thì phải thắng mặc định của nhà.
    if (input.confidential !== undefined) form.append("confidential", String(input.confidential));
  } else if (input.docKey) {
    form.append("docKey", input.docKey);
  }
  for (const item of input.picked) {
    form.append("files", item.file, item.file.name);
    form.append("relativePaths", item.dir);
    form.append("lastModified", String(item.file.lastModified));
  }
  return form;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * Câu báo lỗi cho phản hồi lỗi của route multipart. Hub trả dạng lỗi oRPC (đôi khi bọc trong `json`), nên thử cả hai.
 * Mã nghiệp vụ lấy câu có cách sửa từ hợp đồng; lỗi đã khai báo dùng câu của hub; còn lại đổi theo trạng thái HTTP vì
 * câu mặc định của oRPC là tiếng Anh.
 */
export function uploadErrorMessage(status: number, body: unknown): string {
  const root = isRecord(body) && isRecord(body.json) ? body.json : body;
  const data = isRecord(root) && isRecord(root.data) ? root.data : undefined;
  const code = typeof data?.code === "string" ? data.code : undefined;
  if (code && code in WORD_IMPORT_ERRORS) return WORD_IMPORT_ERRORS[code as WordImportErrorCode].message;
  if (isRecord(root) && root.defined === true && typeof root.message === "string" && root.message && status !== 401)
    return root.message;
  if (status === 0) return "Không kết nối được hub. Kiểm tra mạng rồi thử lại.";
  if (status === 401) return "Phiên đăng nhập đã hết hạn. Tải lại trang rồi đăng nhập lại.";
  if (status === 403) return "Bạn không có quyền nhập Word vào thư mục này.";
  if (status === 413) return "Lượt tải lên quá lớn so với giới hạn của hub. Chia thành nhiều lượt nhỏ hơn.";
  if (status >= 500) return "Hub đang gặp lỗi. Thử lại sau ít phút.";
  return `Không tải lên được (mã ${status}). Thử lại hoặc báo quản trị hub.`;
}

/**
 * Tải lên bằng XMLHttpRequest vì fetch chưa báo được tiến độ gửi. Đi cùng cookie phiên (cùng gốc) và header tổ chức.
 * `signal` huỷ thì promise bị từ chối bằng AbortError.
 */
export function uploadWordImport(options: {
  orgId: string;
  form: FormData;
  onProgress: (fraction: number) => void;
  signal?: AbortSignal;
}): Promise<{ importId: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", WORD_IMPORT_UPLOAD_PATH);
    xhr.setRequestHeader("x-hive-org", options.orgId);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) options.onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // Phản hồi không phải JSON (proxy trả HTML): chỉ còn mã trạng thái để nói.
      }
      if (xhr.status < 200 || xhr.status >= 300) return reject(new Error(uploadErrorMessage(xhr.status, body)));
      const parsed = wordImportUploadOutput.safeParse(isRecord(body) && isRecord(body.json) ? body.json : body);
      if (!parsed.success) return reject(new Error("Hub trả về dữ liệu lạ. Tải lại trang rồi thử lại."));
      resolve(parsed.data);
    };
    xhr.onerror = () => reject(new Error(uploadErrorMessage(0, null)));
    xhr.onabort = () => reject(new DOMException("Đã huỷ tải lên.", "AbortError"));
    options.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(options.form);
  });
}

interface HomeOption {
  id: string;
  scope: "org" | "project";
  label: string;
  root: string;
  confidential: boolean;
}

/** Nhà mà người dùng nhập vào được: kho tài liệu của tổ chức và của từng dự án bật tài liệu gắn repo. */
function useImportHomes(): { homes: HomeOption[]; pending: boolean; error: unknown; retry: () => void } {
  const { api, org } = useOrg();
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const orgHome = useQuery(api.docHomes.get.queryOptions({ input: {} }));
  const docProjects = (projects.data ?? []).filter((project) => project.settings.docs.enabled);
  const projectHomes = useQueries({
    queries: docProjects.map((project) => api.docHomes.get.queryOptions({ input: { project: project.key } })),
  });
  const homes: HomeOption[] = [];
  if (orgHome.data)
    homes.push({
      id: orgHome.data.id,
      scope: "org",
      label: org.name ? `Tổ chức ${org.name}` : "Tổ chức",
      root: orgHome.data.root,
      confidential: orgHome.data.wordImportConfidential,
    });
  docProjects.forEach((project, i) => {
    const home = projectHomes[i]?.data;
    if (home)
      homes.push({
        id: home.id,
        scope: "project",
        label: `Dự án ${project.name}`,
        root: home.root,
        confidential: home.wordImportConfidential,
      });
  });
  const failed = [projects, orgHome, ...projectHomes].find((query) => query.isError);
  return {
    homes,
    pending: projects.isPending || orgHome.isPending || projectHomes.some((query) => query.isPending),
    error: failed?.error,
    retry: () => {
      for (const query of [projects, orgHome, ...projectHomes]) if (query.isError) void query.refetch();
    },
  };
}

export interface WordImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `create` (mặc định) tạo tài liệu mới; `update` cập nhật từ Word (T011), `link` gắn tài liệu có sẵn (T018). */
  mode?: WordImportMode;
  /** Tài liệu đích của `update` và `link`. */
  docKey?: string;
  /** Cố định nhà (cài đặt tài liệu dự án; `update`, `link`). Bỏ trống thì cho chọn. */
  homeId?: string;
  /** Thư mục đích ban đầu, mặc định gốc nhà. */
  targetDir?: string;
  /** Sau khi tải lên xong; mặc định mở trang lượt nhập. */
  onUploaded?: (importId: string) => void;
}

export function WordImportDialog({ open, onOpenChange, ...props }: WordImportDialogProps) {
  const navigate = useNavigate();
  if (!open) return null;
  const onUploaded =
    props.onUploaded ?? ((id: string) => void navigate({ to: "/knowledge/docs/word-imports/$id", params: { id } }));
  return <WordImportBody {...props} onUploaded={onUploaded} onClose={() => onOpenChange(false)} />;
}

function WordImportBody({
  mode = "create",
  docKey,
  homeId: fixedHomeId,
  targetDir: initialDir,
  onUploaded,
  onClose,
}: Omit<WordImportDialogProps, "open" | "onOpenChange"> & { onUploaded: (id: string) => void; onClose: () => void }) {
  const { org } = useOrg();
  const support = useWordImportSupport();
  const { homes, pending, error, retry } = useImportHomes();
  const tree = useDocTree();
  const id = useId();
  const create = mode === "create";
  const [pickedHome, setPickedHome] = useState<string | null>(null);
  const [typedDir, setTypedDir] = useState<string | null>(null);
  const [picked, setPicked] = useState<PickedFile[]>([]);
  const [skipped, setSkipped] = useState<SkippedCounts>({ notWord: 0, doc: 0, temp: 0 });
  const [pickedConfidential, setPickedConfidential] = useState<boolean | null>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const homeId = fixedHomeId ?? pickedHome ?? homes[0]?.id ?? "";
  const home = homes.find((item) => item.id === homeId);
  const dir = normalizeTargetDir(typedDir ?? initialDir ?? home?.root ?? "");
  const dirIssue = create && home ? targetDirIssue(dir, home.root) : null;
  const confidential = pickedConfidential ?? home?.confidential ?? false;
  const uploading = progress !== null;
  const issues = [
    ...selectionIssues(picked),
    ...(!create && picked.length > 1 ? ["Cập nhật hoặc gắn chỉ nhận đúng một file."] : []),
  ];
  const total = picked.reduce((sum, item) => sum + item.file.size, 0);
  const ready =
    picked.length > 0 && issues.length === 0 && !dirIssue && !uploading && homeId !== "" && (!create || !!home);
  const accept = support.doc ? ".docx,.odt,.doc" : ".docx,.odt";
  const suggestions = create && home ? dirSuggestions(tree.data ?? [], home.id, home.root) : [];

  function add(items: PickedFile[]) {
    const { accepted, skipped: dropped } = filterWordFiles(items, { doc: support.doc });
    setSkipped((old) => ({
      notWord: old.notWord + dropped.notWord,
      doc: old.doc + dropped.doc,
      temp: old.temp + dropped.temp,
    }));
    setPicked((old) => (create ? mergePicked(old, accepted) : accepted.length ? accepted : old));
    setFailure(null);
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragging(false);
    if (uploading) return;
    void pickedFromDataTransfer(event.dataTransfer).then(add);
  }

  async function submit() {
    if (!ready) return;
    const controller = new AbortController();
    abort.current = controller;
    setFailure(null);
    setProgress(0);
    try {
      const form = buildUploadForm({
        homeId,
        mode,
        picked,
        ...(create ? { targetDir: dir, confidential } : {}),
        ...(docKey ? { docKey } : {}),
      });
      const { importId } = await uploadWordImport({
        orgId: org.id,
        form,
        onProgress: setProgress,
        signal: controller.signal,
      });
      onUploaded(importId);
      onClose();
    } catch (cause) {
      setProgress(null);
      setFailure(
        cause instanceof DOMException && cause.name === "AbortError"
          ? "Đã huỷ tải lên."
          : cause instanceof Error
            ? cause.message
            : uploadErrorMessage(0, null),
      );
    }
  }

  const notes = skippedNotes(skipped);
  const percent = Math.round((progress ?? 0) * 100);
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !uploading) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogTitle>{create ? "Nhập Word" : mode === "update" ? "Cập nhật từ Word" : "Gắn với file Word"}</DialogTitle>
        <DialogDescription>
          {create
            ? "Chọn file Word hoặc cả thư mục. Hub đổi thành tài liệu Markdown có ảnh và bảng, bạn xem lại trước khi tạo."
            : "Chọn đúng một file Word. Hub đổi file rồi cho bạn xem lại trước khi áp dụng."}
        </DialogDescription>
        {pending && <LoadingState label="Đang tải nhà tài liệu…" />}
        {!pending && !!error && <LoadFailure error={error} retry={retry} />}
        {!pending && !error && create && homes.length === 0 && (
          <Alert role="note">
            Chưa có nhà tài liệu nào. Bật tài liệu gắn repo ở cài đặt dự án, hoặc chọn kho tài liệu tổ chức.
          </Alert>
        )}
        {create && homes.length > 0 && (
          <div className="grid gap-3">
            {fixedHomeId ? (
              <p className="text-sm">
                Nhà tài liệu: <strong>{home?.label ?? "Nhà đã chọn"}</strong>
              </p>
            ) : (
              <label htmlFor={`${id}-home`} className="grid gap-1.5 text-sm">
                Nhà tài liệu
                <NativeSelect
                  id={`${id}-home`}
                  value={homeId}
                  disabled={uploading}
                  onChange={(e) => {
                    setPickedHome(e.target.value);
                    setTypedDir(homes.find((item) => item.id === e.target.value)?.root ?? "");
                    setPickedConfidential(null);
                  }}
                >
                  {homes.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </NativeSelect>
              </label>
            )}
            <label htmlFor={`${id}-dir`} className="grid gap-1.5 text-sm">
              Thư mục đích
              <Input
                id={`${id}-dir`}
                className="font-mono"
                list={`${id}-dirs`}
                value={typedDir ?? initialDir ?? home?.root ?? ""}
                disabled={uploading}
                aria-invalid={!!dirIssue}
                aria-describedby={`${id}-dir-hint`}
                onChange={(e) => setTypedDir(e.target.value)}
              />
              <datalist id={`${id}-dirs`}>
                {suggestions.map((value) => (
                  <option key={value} value={value} />
                ))}
              </datalist>
              <span
                id={`${id}-dir-hint`}
                className={dirIssue ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
              >
                {dirIssue ??
                  (home?.scope === "org"
                    ? `Tài liệu mới nằm trong ${dir || "gốc repo"}. Tài liệu tổ chức nằm trong org/, tài liệu đội trong teams/<slug đội>/.`
                    : `Tài liệu mới nằm trong ${dir || "gốc repo"}. Thư mục con của file được giữ nguyên.`)}
              </span>
            </label>
          </div>
        )}
        <section
          aria-label="Chọn file Word"
          onDragOver={(e) => {
            e.preventDefault();
            if (!uploading) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`grid min-w-0 justify-items-center gap-3 rounded-lg border border-dashed px-3 py-5 text-center text-sm ${dragging ? "border-primary bg-muted" : "border-border"}`}
        >
          <UploadIcon aria-hidden="true" className="size-5 text-muted-foreground" />
          <p className="text-muted-foreground">
            {create ? "Kéo thả file hoặc thư mục Word vào đây" : "Kéo thả file Word vào đây"}
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button type="button" variant="outline" disabled={uploading} onClick={() => filesInput.current?.click()}>
              <FileTextIcon aria-hidden="true" />
              {create ? "Chọn file" : "Chọn file Word"}
            </Button>
            {create && (
              <Button type="button" variant="outline" disabled={uploading} onClick={() => folderInput.current?.click()}>
                <FolderOpenIcon aria-hidden="true" />
                Chọn thư mục
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {support.doc ? ".docx, .odt, .doc" : ".docx, .odt"} · tối đa {LIMITS.batchFiles} file,{" "}
            {formatBytes(LIMITS.batchBytes)} một lượt, {formatBytes(LIMITS.fileBytes)} một file
          </p>
          <input
            ref={filesInput}
            type="file"
            className="sr-only"
            tabIndex={-1}
            aria-label="File Word"
            accept={accept}
            multiple={create}
            onChange={(e) => {
              add(pickedFromFiles(e.currentTarget.files ?? []));
              e.currentTarget.value = "";
            }}
          />
          {create && (
            <input
              ref={(el) => {
                folderInput.current = el;
                el?.setAttribute("webkitdirectory", "");
              }}
              type="file"
              className="sr-only"
              tabIndex={-1}
              aria-label="Thư mục Word"
              multiple
              onChange={(e) => {
                add(pickedFromFiles(e.currentTarget.files ?? []));
                e.currentTarget.value = "";
              }}
            />
          )}
        </section>
        {notes.map((note) => (
          <Alert key={note} role="note">
            {note}
          </Alert>
        ))}
        {picked.length > 0 && (
          <section aria-label="File đã chọn" className="grid min-w-0 gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p role="status" className="text-sm font-medium">
                {picked.length} file · {formatBytes(total)}
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={uploading}
                onClick={() => {
                  setPicked([]);
                  setSkipped({ notWord: 0, doc: 0, temp: 0 });
                }}
              >
                Bỏ chọn hết
              </Button>
            </div>
            <ul className="max-h-48 divide-y divide-border overflow-y-auto rounded-lg border border-border">
              {picked.slice(0, MAX_ROWS).map((item) => (
                <li key={identity(item)} className="flex min-w-0 items-center gap-2 px-2.5 py-1.5 text-sm">
                  <span className="min-w-0 flex-1 break-all">
                    {item.dir && <span className="text-muted-foreground">{item.dir}/</span>}
                    {item.file.name}
                  </span>
                  <span
                    className={`shrink-0 text-xs tabular-nums ${item.file.size > LIMITS.fileBytes ? "text-destructive" : "text-muted-foreground"}`}
                  >
                    {formatBytes(item.file.size)}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    disabled={uploading}
                    aria-label={`Bỏ ${item.file.name}`}
                    onClick={() => setPicked((old) => old.filter((entry) => entry !== item))}
                  >
                    <XIcon aria-hidden="true" />
                  </Button>
                </li>
              ))}
              {picked.length > MAX_ROWS && (
                <li className="px-2.5 py-1.5 text-xs text-muted-foreground">
                  Và {picked.length - MAX_ROWS} file khác.
                </li>
              )}
            </ul>
          </section>
        )}
        {issues.map((issue) => (
          <Alert key={issue} variant="destructive">
            {issue}
          </Alert>
        ))}
        {create && (
          <SwitchRow
            label="Tài liệu mật"
            hint="Tài liệu tạo ra có confidential: true và không gửi đi tạo embedding. Mặc định theo cài đặt của nhà."
            checked={confidential}
            disabled={uploading}
            onChange={setPickedConfidential}
          />
        )}
        {uploading && (
          <Progress value={percent}>
            <ProgressLabel>{percent >= 100 ? "Hub đang nhận file…" : "Đang tải lên"}</ProgressLabel>
            <ProgressValue />
          </Progress>
        )}
        {failure && <Alert variant="destructive">{failure}</Alert>}
        <DialogActions className="sticky bottom-0 -mx-4 -mb-4 border-t border-border bg-popover p-4">
          {uploading ? (
            <Button variant="outline" onClick={() => abort.current?.abort()}>
              Huỷ tải lên
            </Button>
          ) : (
            <Button variant="outline" onClick={onClose}>
              Đóng
            </Button>
          )}
          <Button disabled={!ready} onClick={() => void submit()}>
            {picked.length > 1 ? `Tải lên ${picked.length} file` : "Tải lên"}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Nút mở hộp thoại, ẩn khi hub không nhận Word (FR-023). `variant="link"` cho chỗ đặt cạnh liên kết, như "Nhập từ
 * repo" ở cài đặt tài liệu.
 */
export function WordImportButton({
  variant = "outline",
  ...dialog
}: { variant?: "outline" | "link" } & Omit<WordImportDialogProps, "open" | "onOpenChange">) {
  const support = useWordImportSupport();
  const [open, setOpen] = useState(false);
  if (support.state !== "on") return null;
  return (
    <>
      <Button
        type="button"
        variant={variant}
        className={variant === "link" ? "h-auto self-center px-0" : undefined}
        onClick={() => setOpen(true)}
      >
        Nhập Word
      </Button>
      <WordImportDialog open={open} onOpenChange={setOpen} {...dialog} />
    </>
  );
}
