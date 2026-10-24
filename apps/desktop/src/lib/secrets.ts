import {
  isReservedSecretName,
  isValidSecretName,
  normalizeSecretName,
  SECRET_NAME_MAX_LENGTH,
} from "@xdev-hive/contracts/local-secrets";
import { invoke } from "@/lib/tauri.ts";

/**
 * Bí mật tại máy (specs/031-local-secrets): app chỉ gọi lệnh Tauri, lệnh gọi `hive-worker secrets …` (contracts/
 * tauri-commands.md). Giá trị không có trong kiểu nào ở đây: chỉ `secretSave` gửi đi và `secretReveal` nhận về, và
 * không nơi nào được giữ nó trong query cache hay lưu xuống đĩa.
 */

/** Tình trạng kho của hệ điều hành (Keychain, Credential Manager, Secret Service). */
export interface StoreStatus {
  available: boolean;
  /** null khi kho không có hay chưa biết; true khi kho đang khoá (cần mở khoá ở hệ điều hành). */
  locked: boolean | null;
  backend: string;
  /** Lý do tiếng Việt khi `available` là false. */
  reason: string;
}

export interface SecretProject {
  localId: string;
  name: string;
  folder: string;
}

export interface SecretItem {
  name: string;
  description: string;
  createdAt: string;
  valueChangedAt: string;
  projects: SecretProject[];
  /**
   * Dùng cho mọi dự án, kể cả dự án thêm sau (FR-066); khi đó `projects` là mọi dự án đang có trên máy. Worker cũ chưa
   * trả trường này.
   */
  allProjects?: boolean | undefined;
  /** Số run đang chạy dùng bí mật này; > 0 thì xoá phải báo trước (FR-016). */
  inUseBy: number;
  /** Có tên trong danh mục mà kho không có giá trị (vd. người dùng xoá trong Keychain). Worker cũ chưa trả trường này. */
  missingInStore?: boolean | undefined;
}

export interface ReservedNames {
  exact: string[];
  prefixes: string[];
}

export interface SecretsList {
  secrets: SecretItem[];
  reserved: ReservedNames;
}

export type GrantKind = "run" | "terminal" | "reveal" | "export" | "import";

export interface GrantName {
  name: string;
  /** Bí mật đã xoá sau lần cấp này (FR-044). */
  deleted: boolean;
  /** Giá trị từng xuất hiện trong output của run và đã bị che (FR-037). */
  leaked: boolean;
}

export interface GrantEntry {
  id: string;
  at: string;
  kind: GrantKind;
  sessionId: string;
  project: string;
  projectName: string;
  names: GrantName[];
  policy: string;
  outcome: string;
  copy?: boolean | undefined;
}

export interface ApprovalRequest {
  id: string;
  runId: string;
  project: string;
  projectName: string;
  names: string[];
  expiresAt: string;
}

export interface DeleteResult {
  deleted: string;
  inUse: boolean;
}

export interface PurgeResult {
  removed: string[];
  left: string[];
}

export interface SecretSave {
  name: string;
  description: string;
  /** Bỏ trống khi sửa mà không đổi giá trị. */
  value?: string | undefined;
  /** localId các dự án được cấp; bỏ qua thì giữ nguyên. */
  projects?: string[] | undefined;
  /** Bật hay tắt cờ dùng cho mọi dự án; bỏ qua thì giữ nguyên. Bật thì worker bỏ các gán riêng. */
  allProjects?: boolean | undefined;
}

/** Kết quả xuất: đường dẫn file đã ghi và tên các bí mật trong file. */
export interface ExportResult {
  out: string;
  names: string[];
}

/** Tên đã có trên máy: bỏ qua (mặc định) hay ghi đè giá trị và mô tả (FR-068). */
export type OnConflict = "skip" | "overwrite";
export type ImportStatus = "new" | "same_name" | "same_value" | "invalid";
export type ImportAction = "create" | "overwrite" | "skip";

export interface ImportProject {
  localId: string;
  name: string;
}

/** Một bí mật trong file nhập. Không có giá trị: xem trước và kết quả chỉ có tên, trạng thái và dự án. */
export interface ImportItem {
  /** Rỗng khi dòng `.env` không đọc được tên. */
  name: string;
  status: ImportStatus;
  action: ImportAction;
  allProjects: boolean;
  /** Dự án sẽ được gán thêm (hay đã gán, khi không phải xem trước). */
  projects: ImportProject[];
  /** Dự án ghi trong file mà máy này không khớp được theo remote git hay tên. */
  unmatched: { name: string; remoteUrl?: string | undefined }[];
  /** Gán bị bỏ vì dự án đã đủ 64 bí mật (FR-005). */
  limited: ImportProject[];
  error?: { code: string; message: string } | undefined;
  /** Dòng trong file `.env`. */
  line?: number | undefined;
}

export interface ImportResult {
  dryRun: boolean;
  items: ImportItem[];
}

/** Đích gán khi nhập `.env`: không gán, một dự án (localId) hay mọi dự án (FR-069). */
export type EnvTarget = { kind: "none" } | { kind: "project"; localId: string } | { kind: "all" };

export const secretsStatus = () => invoke<StoreStatus>("secrets_status");
export const secretsList = (project?: string) => invoke<SecretsList>("secrets_list", project ? { project } : undefined);
export const secretSave = (input: SecretSave) => invoke<SecretItem>("secret_save", { ...input });
export const secretRename = (name: string, to: string) => invoke<SecretItem>("secret_rename", { name, to });
export const secretAssign = (name: string, project: string, assigned: boolean) =>
  invoke<SecretItem>("secret_assign", { name, project, assigned });
export const secretDelete = (name: string) => invoke<DeleteResult>("secret_delete", { name });
/** Giá trị chỉ về đây khi người dùng bấm Hiện; gọi qua mutation, không qua query cache. */
export const secretReveal = (name: string) => invoke<string>("secret_reveal", { name });
/** Chép vào clipboard ở phía Rust: giá trị không đi qua giao diện. Clipboard tự xoá sau 30 giây. */
export const secretCopy = (name: string) => invoke<null>("secret_copy", { name });
export const secretsLog = (filter: { name?: string; project?: string; limit?: number } = {}) =>
  invoke<{ entries: GrantEntry[] }>("secrets_log", { ...filter });
export const secretsLogClear = () => invoke<{ cleared: number }>("secrets_log_clear");
export const secretsPurge = (scope: { project: string } | { all: true }) =>
  invoke<PurgeResult>("secrets_purge", { ...scope });
export const secretApprovals = () => invoke<{ pending: ApprovalRequest[] }>("secret_approvals");
export const secretApprove = (id: string, allow: boolean) => invoke<null>("secret_approve", { id, allow });

/**
 * Xuất ra file `.hivesecrets` (FR-067). Mật khẩu chỉ đi qua lệnh Tauri tới stdin của worker; người gọi xoá ô mật khẩu
 * ngay sau đó. `force` chỉ bật khi người dùng đã xác nhận ghi đè.
 */
export const secretsExport = (input: { path: string; password: string; names: string[]; force: boolean }) =>
  invoke<ExportResult>("secrets_export", { ...input });
/** Xem trước file `.hivesecrets`: chạy đúng như nhập thật nhưng không ghi gì (FR-068). */
export const secretsImportPreview = (path: string, password: string, onConflict: OnConflict) =>
  invoke<ImportResult>("secrets_import_preview", { path, password, onConflict });
export const secretsImport = (path: string, password: string, onConflict: OnConflict) =>
  invoke<ImportResult>("secrets_import", { path, password, onConflict });
/** Nhập file `.env` (FR-069); `dryRun` là xem trước. */
export const secretsImportEnv = (path: string, dryRun: boolean, onConflict: OnConflict, target: EnvTarget) =>
  invoke<ImportResult>("secrets_import_env", {
    path,
    dryRun,
    onConflict,
    ...(target.kind === "project" ? { project: target.localId } : {}),
    ...(target.kind === "all" ? { allProjects: true } : {}),
  });

/** Phần mở rộng của file xuất (data-model.md §9). */
export const SECRETS_FILE_EXTENSION = "hivesecrets";

/** Hộp chọn file của hệ điều hành (tauri-plugin-dialog). `.env` không lọc đuôi vì tên file thường chỉ là `.env`. */
export async function pickSecretsFile(title: string, kind: "hivesecrets" | "env"): Promise<string | null> {
  const picked = await invoke<string | string[] | null>("plugin:dialog|open", {
    options: {
      title,
      multiple: false,
      directory: false,
      ...(kind === "hivesecrets" ? { filters: [{ name: "xDev Hive", extensions: [SECRETS_FILE_EXTENSION] }] } : {}),
    },
  });
  return Array.isArray(picked) ? (picked[0] ?? null) : picked;
}

/** Hộp lưu file của hệ điều hành; huỷ thì trả null. */
export const pickExportPath = (title: string, defaultPath: string) =>
  invoke<string | null>("plugin:dialog|save", {
    options: { title, defaultPath, filters: [{ name: "xDev Hive", extensions: [SECRETS_FILE_EXTENSION] }] },
  });

export { SECRET_NAME_MAX_LENGTH };

export type NameProblem = "empty" | "syntax" | "reserved";

/** Tên đã chuẩn hoá và lỗi nếu có; kiểm trước khi gọi để báo ngay trong form, worker kiểm lại (FR-003, FR-004). */
export function checkSecretName(raw: string): { name: string; problem: NameProblem | null } {
  const name = normalizeSecretName(raw);
  if (name === "") return { name, problem: "empty" };
  if (!isValidSecretName(name)) return { name, problem: "syntax" };
  if (isReservedSecretName(name)) return { name, problem: "reserved" };
  return { name, problem: null };
}

/** Giới hạn giá trị của worker (secretstore.MinValueLen, MaxValueLen): tối thiểu tính theo ký tự, tối đa theo byte. */
export const SECRET_VALUE_MIN_LENGTH = 8;
export const SECRET_VALUE_MAX_BYTES = 8 << 10;

export type ValueProblem = "short" | "long" | "nul";

/** Kiểm giá trị trước khi gửi để báo ngay trong form, thay vì đợi worker từ chối; worker vẫn kiểm lại. */
export function checkSecretValue(value: string): ValueProblem | null {
  // Đếm theo code point như utf8.RuneCountInString của Go, không theo UTF-16.
  if ([...value].length < SECRET_VALUE_MIN_LENGTH) return "short";
  if (new TextEncoder().encode(value).length > SECRET_VALUE_MAX_BYTES) return "long";
  if (value.includes("\0")) return "nul";
  return null;
}

/** Mật khẩu file xuất tối thiểu, như secretstore.MinPasswordLen của worker (đếm theo ký tự). */
export const SECRETS_PASSWORD_MIN_LENGTH = 12;

export type PasswordProblem = "short" | "mismatch";

/** Kiểm mật khẩu xuất trước khi gọi worker; worker vẫn kiểm lại độ dài. */
export function checkExportPassword(password: string, confirm: string): PasswordProblem | null {
  if ([...password].length < SECRETS_PASSWORD_MIN_LENGTH) return "short";
  if (password !== confirm) return "mismatch";
  return null;
}

/** Mục sẽ được ghi khi nhập thật: thêm mới hay ghi đè. */
export const importWrites = (item: ImportItem): boolean => item.action !== "skip";

/** Bí mật có tên trong danh mục nhưng không có giá trị trong kho: người dùng phải đặt lại. */
export const isMissingValue = (s: SecretItem): boolean => s.missingInStore === true;

/** Kho dùng được để lưu và đọc giá trị. */
export const storeUsable = (s: StoreStatus | undefined): boolean => !s || (s.available && s.locked !== true);

/** Địa chỉ màn Bí mật, lọc theo dự án (localId) khi có: `#/secrets/<localId>`. */
export const secretsHash = (localId?: string): string =>
  localId ? `#/secrets/${encodeURIComponent(localId)}` : "#/secrets";

/** localId đang lọc theo địa chỉ; rỗng là không lọc. */
export function secretsFilterFromHash(hash: string): string {
  const raw = hash.replace(/^#\/?/, "").split("/")[1] ?? "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
}

/** Ngày giờ ngắn theo ngôn ngữ app, vd. "23/10/2026, 08:30". Chuỗi không đọc được thì trả nguyên văn. */
export function formatWhen(iso: string, lang: "vi" | "en"): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString(lang === "vi" ? "vi-VN" : "en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
