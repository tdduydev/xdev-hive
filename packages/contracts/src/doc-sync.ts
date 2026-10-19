import { z } from "zod";
import { id, orgRoute, queryFlag } from "./common.ts";
import { DOC_MAX_CHARS, docKey, docSecretErrors, docTitle, projectRef, scopeView } from "./knowledge.ts";
import { docRepoPath, projectDocsSettings } from "./projects.ts";
import { repoOwner } from "./scm.ts";
import { secretFinding } from "./secret-scan.ts";

export const docHomeStatus = z.enum(["active", "paused", "error"]);
export const docSyncMode = z.enum(["pr", "direct", "off"]);
export const docSyncState = z.enum([
  "synced",
  "pending",
  "conflict",
  "failed",
  "deleted_in_repo",
  "blocked_secret",
  "excluded",
]);
export const docImportState = z.enum(["scanning", "ready", "importing", "done", "failed", "cancelled"]);
export const docImportFileState = z.enum(["pending", "done", "skipped", "blocked_secret", "failed"]);
export const docImportFileKind = z.enum(["markdown", "image", "office", "other"]);
export const docAssetState = z.enum(["available", "missing_lfs", "too_large", "pending_push"]);
export const docExtractState = z.enum(["pending", "review", "approved", "rejected", "failed"]);
export const docConflictState = z.enum(["open", "resolved"]);
export const docConflictChoice = z.enum(["hub", "repo", "manual"]);
/** Bên kia của xung đột: repo, hoặc bản Word mới khi cập nhật từ Word (spec 019, P2). */
export const docConflictOrigin = z.enum(["repo", "word"]);
export const docSyncBatchState = z.enum(["queued", "pushing", "done", "failed"]);

/** Mã nằm trong data.code để client không phải so khớp câu thông báo. */
export const DOCSYNC_ERRORS = {
  DOCSYNC_HOME_OVERLAP: { status: "CONFLICT", message: "Thư mục chồng với kho tài liệu, SDLC hoặc kho skill khác." },
  DOCSYNC_NO_ACCESS: { status: "FORBIDDEN", message: "Kết nối không có quyền đọc và ghi repo tài liệu." },
  DOCSYNC_BRANCH_PROTECTED: { status: "CONFLICT", message: "Nhánh được bảo vệ. Hãy chuyển sang chế độ mở PR." },
  DOCSYNC_ASSET_TOO_LARGE: { status: "BAD_REQUEST", message: "File đính kèm vượt giới hạn cho phép." },
  DOCSYNC_ORG_STORAGE_FULL: { status: "CONFLICT", message: "Tổ chức đã dùng hết dung lượng kho file." },
  DOCSYNC_CONFLICT_OPEN: { status: "CONFLICT", message: "Tài liệu còn xung đột cần giải quyết." },
  DOCSYNC_PAUSED: { status: "CONFLICT", message: "Đồng bộ đang tạm dừng. Hãy tiếp tục trước khi thử lại." },
} as const;
export type DocSyncErrorCode = keyof typeof DOCSYNC_ERRORS;
export const docSyncErrorCode = z.enum([
  "DOCSYNC_HOME_OVERLAP",
  "DOCSYNC_NO_ACCESS",
  "DOCSYNC_BRANCH_PROTECTED",
  "DOCSYNC_ASSET_TOO_LARGE",
  "DOCSYNC_ORG_STORAGE_FULL",
  "DOCSYNC_CONFLICT_OPEN",
  "DOCSYNC_PAUSED",
]);
export const docSyncErrorData = z.object({
  code: docSyncErrorCode,
  homeId: id.optional(),
  path: docRepoPath.optional(),
  limit: z.number().int().nonnegative().optional(),
});
const docSyncErrors = {
  FORBIDDEN: { message: "Bạn không có quyền đồng bộ tài liệu.", data: docSyncErrorData.optional() },
  CONFLICT: { message: "Không thể đồng bộ tài liệu lúc này.", data: docSyncErrorData.optional() },
  // Lỗi kiểm tra đầu vào của oRPC cũng dùng BAD_REQUEST, có issues thay vì code.
  BAD_REQUEST: {
    message: "Dữ liệu đồng bộ tài liệu không hợp lệ.",
    data: z.looseObject({ ...docSyncErrorData.shape, code: docSyncErrorCode.optional() }).optional(),
  },
};
const route = (method: "GET" | "POST" | "PATCH" | "DELETE", path: `/v1/${string}`, summary: string) =>
  orgRoute(method, path, summary, "docsync").errors(docSyncErrors);
const count = z.number().int().nonnegative();
const positiveVersion = z.number().int().min(1);
const content = z.string().max(DOC_MAX_CHARS);
const sha = z.string().regex(/^[0-9a-f]{40,64}$/, "Commit SHA không hợp lệ.");
const filePath = docRepoPath.refine((value) => !value.endsWith("/"), "Đường dẫn file không được kết thúc bằng /.");
const branch = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^(?!\/)(?!.*\.\.)(?!.*\/\/)(?!.*(?:^|\/)\.)(?!.*\.lock(?:\/|$))[\w./-]+(?<![/.])$/,
    "Tên nhánh không hợp lệ.",
  );
const homeInput = z.object({ homeId: id });
const itemInput = z.object({ id });
const ok = z.object({ ok: z.literal(true) });
const queued = z.object({ queued: z.boolean() });
const page = z.object({
  cursor: z.string().min(1).max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const paged = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export const docHome = z.object({
  id,
  scope: z.enum(["project", "org"]),
  projectId: id.nullable(),
  connectionId: id,
  owner: z.string(),
  name: z.string(),
  branch: z.string(),
  root: z.string(),
  assetsDir: z.string(),
  mode: docSyncMode,
  include: z.array(z.string()),
  exclude: z.array(z.string()),
  repoChangesNeedReview: z.boolean(),
  lastCommit: sha.nullable(),
  status: docHomeStatus,
  statusReason: z.string().nullable(),
  error: z.string().nullable(),
  webhookUrl: z.string().nullable(),
  prNumber: positiveVersion.nullable(),
  prUrl: z.url().nullable(),
  lfsPatterns: z.array(z.string()),
  /** Mặc định của ô "Tài liệu mật" khi nhập Word (Q15). Có mặc định vì hub chưa lưu cờ này vẫn trả nhà. */
  wordImportConfidential: z.boolean().default(false),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type DocHome = z.output<typeof docHome>;
export const docHomeGetInput = z.object({ project: projectRef.optional() });
export const docHomeConfigureProjectInput = z.object({ project: projectRef, settings: projectDocsSettings });
export const docHomeConfigureOrgInput = z.object({
  connectionId: id,
  owner: repoOwner,
  name: z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/, "Tên repo không hợp lệ."),
  // Không mặc định main: để provider chọn nhánh mặc định của repo hiện có.
  branch: branch.optional(),
  create: z.boolean().default(false),
  root: z.union([z.literal(""), docRepoPath]).default(""),
  assetsDir: projectDocsSettings.shape.assetsDir,
  mode: docSyncMode.default("direct"),
  include: projectDocsSettings.shape.include,
  exclude: projectDocsSettings.shape.exclude,
  repoChangesNeedReview: z.boolean().default(false),
  wordImportConfidential: projectDocsSettings.shape.wordImportConfidential,
});
export const docAdoptItem = z.object({
  key: docKey,
  repoPath: filePath,
  existsInRepo: z.boolean(),
  warnings: z.array(z.string()),
});
export const docHomeStatusOutput = z.object({
  home: docHome,
  counts: z.object({
    synced: count,
    pending: count,
    conflict: count,
    failed: count,
    deletedInRepo: count,
    blockedSecret: count,
    excluded: count,
  }),
  batches: z.array(
    z.object({
      id,
      state: docSyncBatchState,
      mode: docSyncMode,
      commitSha: sha.nullable(),
      prUrl: z.url().nullable(),
      error: z.string().nullable(),
    }),
  ),
});
export const docHomesContract = {
  get: route("GET", "/v1/docs/homes/item", "Nhà tài liệu dự án hoặc tổ chức")
    .input(docHomeGetInput)
    .output(docHome.nullable()),
  configureProject: route("POST", "/v1/docs/homes/project", "Cấu hình nhà tài liệu (quản trị dự án)")
    .input(docHomeConfigureProjectInput)
    .output(docHome),
  configureOrg: route("POST", "/v1/docs/homes/org", "Chọn hoặc tạo repo tài liệu riêng tư (quản trị tổ chức)")
    .input(docHomeConfigureOrgInput)
    .output(docHome),
  remove: route("DELETE", "/v1/docs/homes/{homeId}", "Gỡ nhà tài liệu, giữ nội dung trên hub")
    .input(homeInput)
    .output(ok),
  pause: route("POST", "/v1/docs/homes/{homeId}/pause", "Tạm dừng đồng bộ tài liệu").input(homeInput).output(docHome),
  resume: route("POST", "/v1/docs/homes/{homeId}/resume", "Tiếp tục đồng bộ tài liệu").input(homeInput).output(docHome),
  acceptBranch: route("POST", "/v1/docs/homes/{homeId}/accept-branch", "Xác nhận chuyển sang nhánh mặc định mới")
    .input(homeInput.extend({ branch }))
    .output(docHome),
  syncNow: route("POST", "/v1/docs/homes/{homeId}/sync", "Đồng bộ ngay hoặc thử lại lô lỗi")
    .input(homeInput)
    .output(queued),
  adoptPreview: route("GET", "/v1/docs/homes/{homeId}/adopt-preview", "Xem trước tài liệu hub chưa có trong repo")
    .input(homeInput.merge(page))
    .output(paged(docAdoptItem)),
  adopt: route("POST", "/v1/docs/homes/{homeId}/adopt", "Đưa tài liệu hub đã chọn vào một PR riêng")
    .input(homeInput.extend({ keys: z.array(docKey).min(1).max(5000) }))
    .output(z.object({ batchId: id })),
  status: route("GET", "/v1/docs/homes/{homeId}/status", "Trạng thái nhà và các lô đồng bộ")
    .input(homeInput)
    .output(docHomeStatusOutput),
};

export const docImportFile = z.object({
  path: filePath,
  blobSha: sha,
  key: docKey.nullable(),
  existingKey: docKey.nullable(),
  kind: docImportFileKind,
  size: count,
  warnings: z.array(z.string()),
  secretScan: z.enum(["pending", "clean", "found"]),
  findings: z.array(secretFinding),
  state: docImportFileState,
  docId: id.nullable(),
  assetId: id.nullable(),
  error: z.string().nullable(),
});
export const docImportReport = z.object({
  imported: count,
  skipped: count,
  blockedSecret: count,
  failed: count,
  warnings: z.array(z.string()),
});
export const docImport = z.object({
  id,
  homeId: id,
  commitSha: sha.nullable(),
  state: docImportState,
  include: z.array(z.string()),
  exclude: z.array(z.string()),
  progress: z.object({ done: count, total: count, cursor: z.string().nullable() }),
  report: docImportReport.nullable(),
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type DocImport = z.output<typeof docImport>;
export type DocImportFile = z.output<typeof docImportFile>;
export const docImportScanInput = homeInput.extend({
  include: projectDocsSettings.shape.include.unwrap().optional(),
  exclude: projectDocsSettings.shape.exclude.unwrap().optional(),
});
/** File bỏ qua không nằm trong paths; trùng key cần người dùng chọn trước khi nhập. */
export const docImportCollisionResolution = z.discriminatedUnion("action", [
  z.object({ path: filePath, action: z.literal("rename"), key: docKey }),
  z.object({
    path: filePath,
    action: z.literal("attach"),
    key: docKey,
    choice: z.enum(["hub", "repo"]),
    baseVersion: positiveVersion,
  }),
]);
export const docImportStartInput = z.object({
  importId: id,
  paths: z.array(filePath).min(1).max(10000),
  resolutions: z.array(docImportCollisionResolution).max(10000).optional(),
});
export const docImportConfirmSecretInput = z.object({ importId: id, path: filePath });
export const docImportsContract = {
  scan: route("POST", "/v1/docs/imports/scan", "Quét repo và tạo bản xem trước lần nhập")
    .input(docImportScanInput)
    .output(docImport),
  get: route("GET", "/v1/docs/imports/{id}", "Tiến độ và báo cáo lần nhập").input(itemInput).output(docImport),
  files: route("GET", "/v1/docs/imports/{id}/files", "Danh sách file và cảnh báo, có phân trang")
    .input(itemInput.merge(page).extend({ state: docImportFileState.optional() }))
    .output(paged(docImportFile)),
  start: route("POST", "/v1/docs/imports/start", "Nhập các file đã chọn").input(docImportStartInput).output(docImport),
  cancel: route("POST", "/v1/docs/imports/{id}/cancel", "Huỷ lần nhập, giữ file đã nhập xong")
    .input(itemInput)
    .output(docImport),
  confirmSecret: route("POST", "/v1/docs/imports/confirm-secret", "Xác nhận từng file có dấu hiệu bí mật (quản trị)")
    .input(docImportConfirmSecretInput)
    .output(queued),
  list: route("GET", "/v1/docs/imports", "Lịch sử nhập tài liệu của một nhà")
    .input(homeInput.merge(page))
    .output(paged(docImport)),
};

export const docConflict = z.object({
  id,
  homeId: id,
  docId: id,
  key: docKey,
  title: z.string(),
  repoPath: filePath,
  baseVersion: positiveVersion,
  hubVersion: positiveVersion,
  /** null khi bên kia là Word: bản mới chưa nằm trong commit nào. */
  repoCommit: sha.nullable(),
  /** Có mặc định vì xung đột ghi trước spec 019 chỉ có thể đến từ repo. */
  origin: docConflictOrigin.default("repo"),
  state: docConflictState,
  resolution: docConflictChoice.nullable(),
  resolvedVersion: positiveVersion.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const docConflictDetail = docConflict.extend({
  baseContent: content,
  hubContent: content,
  repoContent: content,
  merge: z.object({ content, conflicts: count }),
});
export const docConflictResolveInput = z.discriminatedUnion("choice", [
  z.object({ id, choice: z.literal("hub"), baseVersion: positiveVersion }),
  z.object({ id, choice: z.literal("repo"), baseVersion: positiveVersion }),
  z.object({
    id,
    choice: z.literal("manual"),
    baseVersion: positiveVersion,
    content,
    acknowledgeSecrets: z.boolean().optional(),
  }),
]);
export type DocConflict = z.output<typeof docConflict>;
export type DocConflictDetail = z.output<typeof docConflictDetail>;
export type DocConflictResolveInput = z.input<typeof docConflictResolveInput>;
export const docConflictsContract = {
  list: route("GET", "/v1/docs/conflicts", "Xung đột tài liệu mình được quản lý")
    .input(page.extend({ homeId: id.optional(), state: docConflictState.optional() }))
    .output(paged(docConflict)),
  get: route("GET", "/v1/docs/conflicts/{id}", "Ba bản tài liệu và kết quả hợp theo khối")
    .input(itemInput)
    .output(docConflictDetail),
  resolve: route("POST", "/v1/docs/conflicts/resolve", "Giải quyết xung đột bằng bản hub, repo hoặc sửa tay")
    .errors(docSecretErrors)
    .input(docConflictResolveInput)
    .output(z.object({ key: docKey, version: positiveVersion })),
};

export const docAsset = z.object({
  id,
  homeId: id,
  repoPath: filePath,
  mediaType: z.string(),
  size: count,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  lfs: z.boolean(),
  state: docAssetState,
  ownerDocId: id.nullable(),
});
export const docResolvedLink = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("doc"), href: z.string(), key: docKey }),
  z.object({ kind: z.literal("asset"), href: z.string(), assetId: id, url: z.string() }),
  z.object({ kind: z.literal("external"), href: z.string(), url: z.string() }),
  z.object({ kind: z.literal("missing"), href: z.string(), reason: z.string() }),
]);
/** Multipart và stream đi qua Hono; không đăng ký route oRPC trùng đường dẫn tải file. */
export const docAssetUploadOutput = z.object({ assetId: id, relativePath: filePath });
export const docAssetDownloadOutput = z.instanceof(Uint8Array);
export type DocAsset = z.output<typeof docAsset>;
export type DocResolvedLink = z.output<typeof docResolvedLink>;
export type DocAssetUploadOutput = z.output<typeof docAssetUploadOutput>;
export const docAssetsContract = {
  resolve: route("POST", "/v1/docs/assets/resolve", "Phân giải link tài liệu và đính kèm theo quyền đọc")
    .input(z.object({ docKey, hrefs: z.array(z.string().min(1).max(2000)).max(1000) }))
    .output(z.array(docResolvedLink)),
  list: route("GET", "/v1/docs/assets/list", "Đính kèm mình được đọc trong nhà tài liệu")
    .input(homeInput.merge(page).extend({ docKey: docKey.optional() }))
    .output(paged(docAsset)),
};

export const docExtractSummary = z.object({
  id,
  assetId: id,
  homeId: id,
  repoPath: filePath,
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  state: docExtractState,
  secretFlag: z.boolean(),
  error: z.string().nullable(),
  warnings: z.array(z.string()),
  reviewedBy: z.string().nullable(),
  reviewedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const docExtract = docExtractSummary.extend({ content, findings: z.array(secretFinding) });
export type DocExtract = z.output<typeof docExtract>;
export const docExtractUpdateInput = z.object({ id, content, updatedAt: z.iso.datetime() });
export const docExtractsContract = {
  list: route("GET", "/v1/docs/extracts", "Bản trích file văn phòng, gồm hàng chờ duyệt")
    .input(page.extend({ homeId: id.optional(), state: docExtractState.optional() }))
    .output(paged(docExtractSummary)),
  get: route("GET", "/v1/docs/extracts/{id}", "Nội dung bản trích và cảnh báo").input(itemInput).output(docExtract),
  update: route("PATCH", "/v1/docs/extracts/{id}", "Sửa bản trích trước khi duyệt")
    .input(docExtractUpdateInput)
    .output(docExtract),
  approve: route("POST", "/v1/docs/extracts/{id}/approve", "Duyệt bản trích để tìm kiếm và agent đọc")
    .errors(docSecretErrors)
    .input(z.object({ id, updatedAt: z.iso.datetime() }))
    .output(docExtract),
  reject: route("POST", "/v1/docs/extracts/{id}/reject", "Từ chối bản trích")
    .input(z.object({ id, updatedAt: z.iso.datetime() }))
    .output(docExtract),
  confirmSecret: route(
    "POST",
    "/v1/docs/extracts/{id}/confirm-secret",
    "Xác nhận dấu hiệu bí mật trước khi duyệt (quản trị)",
  )
    .input(z.object({ id, updatedAt: z.iso.datetime() }))
    .output(docExtract),
};

export const docTreeItem = z.object({
  homeId: id.nullable(),
  path: filePath.nullable(),
  key: docKey.nullable(),
  title: z.string(),
  kind: z.enum(["doc", "asset"]),
  state: z.union([docSyncState, docAssetState]).nullable(),
  prNumber: positiveVersion.nullable(),
  prUrl: z.url().nullable(),
  repoUrl: z.url().nullable(),
  repoCommit: sha.nullable(),
  docId: id.nullable(),
  assetId: id.nullable(),
  version: positiveVersion.nullable(),
  error: z.string().nullable(),
  scope: scopeView,
});
export const docTreeMoveInput = z.object({ key: docKey, repoPath: filePath, baseVersion: positiveVersion });
export type DocTreeItem = z.output<typeof docTreeItem>;
export const docTreeContract = {
  list: route("GET", "/v1/docs/tree", "Cây tài liệu theo đường dẫn repo và trạng thái đồng bộ")
    .input(
      page.extend({
        homeId: id.optional(),
        project: projectRef.optional(),
        prefix: z.string().max(1000).optional(),
        state: docSyncState.optional(),
      }),
    )
    .output(paged(docTreeItem)),
  move: route("POST", "/v1/docs/tree/move", "Di chuyển file trong nhà, giữ nguyên key tài liệu")
    .input(docTreeMoveInput)
    .output(docTreeItem),
};

// ---------------------------------------------------------------------------------------------------------------
// Nhập Word (specs/019-word-import)

export const wordImportFormat = z.enum(["docx", "odt", "doc"]);
export type WordImportFormat = z.output<typeof wordImportFormat>;

/** Đuôi quyết định cách đổi (`.doc` qua LibreOffice); hub vẫn kiểm nội dung theo byte. */
export function wordImportFormatOf(name: string): WordImportFormat | null {
  const ext = /\.(docx|odt|doc)$/i.exec(name)?.[1];
  return ext ? wordImportFormat.parse(ext.toLowerCase()) : null;
}

export const wordImportMode = z.enum(["create", "update", "link"]);
export const wordImportState = z.enum([
  "uploading",
  "converting",
  "ready",
  "committing",
  "done",
  "failed",
  "cancelled",
]);
export const wordImportFileState = z.enum([
  "queued",
  "converting",
  "ready",
  "skipped",
  "blocked_secret",
  "failed",
  "proposed",
  "cancelled",
  "done",
]);
/** Quyền của người hỏi ở phạm vi đích: `manage` thì giao diện hiện "Tạo", chỉ `propose` thì "Gửi duyệt" (Q2). */
export const wordImportAccess = z.enum(["manage", "propose"]);
export type WordImportMode = z.output<typeof wordImportMode>;
export type WordImportState = z.output<typeof wordImportState>;
export type WordImportFileState = z.output<typeof wordImportFileState>;

/** Mặc định của `HIVE_DOC_WORD_*`. Quản trị đổi được, nên giao diện chỉ dùng để chặn sớm; hub kiểm lại theo cấu hình. */
export const WORD_IMPORT_DEFAULT_LIMITS = {
  fileBytes: 50 * 1024 * 1024,
  batchFiles: 100,
  batchBytes: 500 * 1024 * 1024,
} as const;

// Bộ lọc Lua và hub chỉ ghi mã; web và desktop lấy chữ ở đây để hai nơi nói giống nhau.
export const wordImportWarningCode = z.enum([
  "nested_table",
  "equation",
  "footnote",
  "emf_image",
  "tracked_changes",
  "comments",
  "no_h1",
  "textbox",
  "skipped_older",
]);
export type WordImportWarningCode = z.output<typeof wordImportWarningCode>;
export const WORD_IMPORT_WARNINGS: Record<WordImportWarningCode, string> = {
  nested_table: "Có bảng lồng trong bảng. Bảng trong đã được dàn thành chữ trong ô, hãy kiểm lại ô đó.",
  equation: "Có công thức toán. Editor giữ công thức dạng chữ thô, hãy kiểm lại hoặc thay bằng ảnh.",
  footnote: "Có chú thích cuối trang. Editor giữ chú thích dạng chữ thô.",
  emf_image: "Có ảnh EMF/WMF. Ảnh được giữ làm file đính kèm kèm link tải, không hiện trong tài liệu.",
  tracked_changes: "File còn theo dõi thay đổi. Mọi thay đổi đã được chấp nhận khi chuyển.",
  comments: "File có bình luận. Bình luận đã bị bỏ khi chuyển.",
  no_h1: "Không có tiêu đề cấp 1 nên không bỏ được trang bìa và mục lục. Hãy kiểm lại phần đầu tài liệu.",
  textbox: "Có text box, hình vẽ, header hoặc footer. Phần này bị bỏ, hãy chép nội dung cần giữ ra đoạn văn thường.",
  skipped_older: "Bỏ qua vì lượt có bản mới hơn của cùng tài liệu.",
};
export const wordImportWarning = z.object({
  code: wordImportWarningCode,
  count: z.number().int().min(1),
  /** Ví dụ tên file của bản mới hơn với `skipped_older`. */
  detail: z.string().max(500).nullable(),
});
export type WordImportWarning = z.output<typeof wordImportWarning>;

/** Mã nằm trong data.code (lỗi ném ra) hoặc error.code của từng file; câu nói lý do rồi cách sửa (FR-022). */
export const WORD_IMPORT_ERRORS = {
  WORD_IMPORT_PASSWORD: {
    status: "BAD_REQUEST",
    message: "File có mật khẩu. Mở khoá trong Word, lưu lại rồi tải lên.",
  },
  WORD_IMPORT_NOT_WORD: {
    status: "BAD_REQUEST",
    message: "File hỏng hoặc không phải Word. Mở bằng Word, lưu lại dạng .docx rồi tải lên.",
  },
  WORD_IMPORT_FILE_TOO_LARGE: {
    status: "BAD_REQUEST",
    message: "File Word vượt giới hạn dung lượng. Nén ảnh trong Word hoặc tách thành nhiều file.",
  },
  WORD_IMPORT_BATCH_TOO_LARGE: {
    status: "BAD_REQUEST",
    message: "Lượt nhập vượt giới hạn số file hoặc dung lượng. Chia thành nhiều lượt nhỏ hơn.",
  },
  WORD_IMPORT_DOC_DISABLED: {
    status: "BAD_REQUEST",
    message:
      "Hub chưa bật nhận .doc. Mở file bằng Word, lưu thành .docx rồi tải lên, hoặc nhờ quản trị cài LibreOffice.",
  },
  WORD_IMPORT_DISABLED: {
    status: "CONFLICT",
    message: "Hub chưa bật nhập Word. Quản trị cần cài pandoc theo hướng dẫn tự host.",
  },
  WORD_IMPORT_TOO_LONG: {
    status: "BAD_REQUEST",
    message: "Tài liệu sau khi chuyển quá 200.000 ký tự. Tách file Word thành nhiều file nhỏ hơn.",
  },
  WORD_IMPORT_EXISTS: {
    status: "CONFLICT",
    message: "Đường dẫn này đã có tài liệu. Đổi tên, hoặc cập nhật tài liệu đó từ Word.",
  },
  WORD_IMPORT_DUPLICATE_PATH: {
    status: "CONFLICT",
    message: "Hai file trong lượt có cùng đường dẫn. Đổi tên một trong hai file trước khi tạo.",
  },
  WORD_IMPORT_OUTSIDE_HOME: {
    status: "BAD_REQUEST",
    message: "Thư mục đích nằm ngoài thư mục tài liệu của nhà. Chọn một thư mục trong nhà.",
  },
  WORD_IMPORT_NEEDS_MANAGE: {
    status: "FORBIDDEN",
    message: "Cần quyền quản lý tài liệu ở thư mục này. Gửi duyệt, hoặc nhờ quản trị đội nhập hộ.",
  },
  WORD_IMPORT_CONVERT_FAILED: {
    status: "BAD_REQUEST",
    message: "Không chuyển được file Word. Mở bằng Word, lưu lại rồi tải lên; vẫn lỗi thì gửi file cho quản trị.",
  },
  WORD_IMPORT_TIMEOUT: {
    status: "BAD_REQUEST",
    message: "Chuyển file quá thời gian cho phép. Tách file Word thành nhiều file nhỏ hơn rồi tải lại.",
  },
} as const;
export type WordImportErrorCode = keyof typeof WORD_IMPORT_ERRORS;
export const wordImportErrorCode = z.enum(
  Object.keys(WORD_IMPORT_ERRORS) as [WordImportErrorCode, ...WordImportErrorCode[]],
);
export const wordImportErrorData = z.object({
  code: wordImportErrorCode,
  importId: id.optional(),
  fileId: id.optional(),
  path: docRepoPath.optional(),
  limit: count.optional(),
});
/** Lỗi của một file lưu trong lượt, không ném ra: các file khác vẫn đi tiếp. */
export const wordImportFileError = z.object({
  code: wordImportErrorCode,
  message: z.string(),
  /** Vài dòng stderr của pandoc hoặc LibreOffice, đã bỏ đường dẫn tạm. */
  detail: z.string().max(2000).optional(),
});
// Lỗi của docsync (tạm dừng, hết dung lượng kho) cũng có thể ra từ các route này.
const wordImportAnyErrorData = z.union([wordImportErrorData, docSyncErrorData]);
const wordImportErrors = {
  FORBIDDEN: { message: "Bạn không có quyền nhập Word ở thư mục này.", data: wordImportAnyErrorData.optional() },
  CONFLICT: { message: "Không thể nhập Word lúc này.", data: wordImportAnyErrorData.optional() },
  // Lỗi kiểm tra đầu vào của oRPC cũng dùng BAD_REQUEST, có issues thay vì code.
  BAD_REQUEST: {
    message: "Dữ liệu nhập Word không hợp lệ.",
    data: z
      .looseObject({ ...wordImportErrorData.shape, code: z.union([wordImportErrorCode, docSyncErrorCode]).optional() })
      .optional(),
  },
};
const wordRoute = (method: "GET" | "POST" | "PATCH", path: `/v1/docs/word-imports${string}`, summary: string) =>
  orgRoute(method, path, summary, "docsync").errors(wordImportErrors);

/** Multipart đi qua Hono như `docs/assets`, nên không có route oRPC cùng đường dẫn. */
export const WORD_IMPORT_UPLOAD_PATH = "/api/v1/docs/word-imports";
/** Ảnh giữ tạm để xem trước; chỉ người tạo lượt và người `manage` ở phạm vi đích xem được. */
export function wordImportMediaPath(importId: string, fileId: string, name: string): string {
  return `${WORD_IMPORT_UPLOAD_PATH}/${importId}/files/${fileId}/media/${encodeURIComponent(name)}`;
}
/** File Word gốc; chỉ người đọc được tài liệu tạo ra từ nó tải được (FR-020). */
export function wordImportOriginalPath(importId: string, fileId: string): string {
  return `${WORD_IMPORT_UPLOAD_PATH}/${importId}/files/${fileId}/original`;
}

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const wordImportDir = z.union([z.literal(""), docRepoPath]);
const wordImportFileField = z
  .instanceof(File)
  .refine((file) => wordImportFormatOf(file.name) !== null, "Chỉ nhận file .docx, .odt, .doc.");
// Form gửi một file thì trường là giá trị đơn, nhiều file thì là mảng; hub không phải tự phân biệt.
const many = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]), schema);

/** Trường của `POST /api/v1/docs/word-imports` (multipart). Phần tử thứ i của các mảng đi với file thứ i. */
export const wordImportUploadInput = z
  .object({
    homeId: id,
    /** Thư mục trong repo, vd. `docs/srs/OPD/`; rỗng là gốc repo. Bắt buộc khi tạo, bỏ qua khi cập nhật hay gắn. */
    targetDir: wordImportDir.optional(),
    mode: wordImportMode.default("create"),
    /** Tài liệu cần cập nhật (US3) hoặc gắn với file Word (US6). */
    docKey: docKey.optional(),
    /** Bỏ trống thì theo `wordImportConfidential` của nhà (Q15). */
    confidential: queryFlag.optional(),
    files: many(z.array(wordImportFileField).min(1).max(1000)),
    /** Thư mục con của từng file dưới thư mục đích, không gồm tên file. Bỏ trống là mọi file nằm thẳng trong đích. */
    relativePaths: many(z.array(wordImportDir).max(1000)),
    /** Ngày sửa của từng file (ms từ epoch), để chọn bản khi tên và phiên bản trùng (FR-006). */
    lastModified: many(z.array(z.coerce.number().int().nonnegative()).max(1000)),
  })
  .superRefine((input, ctx) => {
    for (const field of ["relativePaths", "lastModified"] as const) {
      if (input[field].length > 0 && input[field].length !== input.files.length)
        ctx.addIssue({ code: "custom", path: [field], message: "Số phần tử phải bằng số file." });
    }
    if (input.mode === "create") {
      if (input.targetDir === undefined)
        ctx.addIssue({ code: "custom", path: ["targetDir"], message: "Chọn thư mục đích." });
      if (input.docKey !== undefined)
        ctx.addIssue({ code: "custom", path: ["docKey"], message: "Chỉ cập nhật hoặc gắn mới cần tài liệu đích." });
      return;
    }
    if (input.docKey === undefined)
      ctx.addIssue({ code: "custom", path: ["docKey"], message: "Chọn tài liệu cần cập nhật hoặc gắn." });
    if (input.files.length !== 1)
      ctx.addIssue({ code: "custom", path: ["files"], message: "Cập nhật hoặc gắn chỉ nhận đúng một file." });
  });
export type WordImportUploadInput = z.output<typeof wordImportUploadInput>;
export const wordImportUploadOutput = z.object({ importId: id });
export type WordImportUploadOutput = z.output<typeof wordImportUploadOutput>;

export const wordImportCounts = z.object({
  queued: count,
  converting: count,
  ready: count,
  skipped: count,
  blockedSecret: count,
  failed: count,
  proposed: count,
  cancelled: count,
  done: count,
});
export const wordImport = z.object({
  id,
  homeId: id,
  /** null khi cập nhật hay gắn: đường dẫn lấy theo tài liệu đích. */
  targetDir: wordImportDir.nullable(),
  mode: wordImportMode,
  docKey: docKey.nullable(),
  confidential: z.boolean(),
  state: wordImportState,
  counts: wordImportCounts,
  createdBy: z.object({ id: z.string(), name: z.string().nullable() }),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const wordImportStats = z.object({ headings: count, tables: count, images: count });
export const wordImportFile = z.object({
  id,
  importId: id,
  relativeDir: z.string(),
  fileName: z.string(),
  format: wordImportFormat,
  size: count,
  sha256,
  /** Phiên bản đọc từ tên file, vd. `1.1`; null khi tên không có. */
  versionLabel: z.string().nullable(),
  proposedPath: filePath.nullable(),
  proposedTitle: z.string().nullable(),
  /** Bản người nhập đã sửa nếu có, không thì bản đề xuất. */
  path: filePath.nullable(),
  title: z.string().nullable(),
  key: docKey.nullable(),
  /** Đường dẫn đích đã có tài liệu (FR-019). */
  exists: z.boolean(),
  keepFront: z.boolean(),
  excluded: z.boolean(),
  state: wordImportFileState,
  stats: wordImportStats.nullable(),
  warnings: z.array(wordImportWarning),
  findings: z.array(secretFinding),
  error: wordImportFileError.nullable(),
  /** Gắn (FR-028): kết quả chuyển có khớp nội dung hiện tại không; null khi chưa chuyển xong hoặc không phải gắn. */
  linkMatches: z.boolean().nullable(),
  docId: id.nullable(),
  /** null khi gắn xong: gắn không tạo phiên bản. */
  docVersion: positiveVersion.nullable(),
  /** Đề xuất đã gửi khi người nhập chỉ có quyền `propose` (P2). */
  proposalId: id.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const wordImportImage = z.object({
  name: z.string(),
  mediaType: z.string(),
  bytes: count,
  /** `wordImportMediaPath` của ảnh. */
  url: z.string(),
});
export const wordImportFileDetail = wordImportFile.extend({
  /** null khi chưa chuyển xong hoặc lỗi. */
  markdown: content.nullable(),
  images: z.array(wordImportImage),
  /** Gắn: nội dung hiện tại (bỏ front matter, link ảnh chuẩn về tên ảnh) để hiện khác biệt từng khối. */
  current: z.object({ content, version: positiveVersion }).nullable(),
});
export const wordImportGetOutput = z.object({
  import: wordImport,
  files: z.array(wordImportFile),
  access: wordImportAccess,
});
export type WordImport = z.output<typeof wordImport>;
export type WordImportFile = z.output<typeof wordImportFile>;
export type WordImportFileDetail = z.output<typeof wordImportFileDetail>;
export type WordImportGetOutput = z.output<typeof wordImportGetOutput>;

const importInput = z.object({ importId: id });
const fileInput = z.object({ fileId: id });
export const wordImportUpdateInput = fileInput
  .extend({
    path: filePath.refine((value) => /\.md$/i.test(value), "Đường dẫn tài liệu phải kết thúc bằng .md.").optional(),
    title: docTitle.optional(),
    /** Đổi thì hub chạy lại pandoc cho file này (Q5). */
    keepFront: z.boolean().optional(),
    excluded: z.boolean().optional(),
  })
  .refine(
    (input) =>
      input.path !== undefined ||
      input.title !== undefined ||
      input.keepFront !== undefined ||
      input.excluded !== undefined,
    "Không có trường nào để đổi.",
  );
export const wordImportCommitInput = importInput.extend({
  /** Bỏ trống là mọi file sẵn sàng và chưa bị loại. */
  fileIds: z.array(id).min(1).max(1000).optional(),
  acknowledgeSecrets: z.boolean().optional(),
});
export const wordImportApproveInput = importInput.extend({
  fileIds: z.array(id).min(1).max(1000),
  note: z.string().trim().max(500).optional(),
});
export type WordImportUpdateInput = z.input<typeof wordImportUpdateInput>;
export type WordImportCommitInput = z.input<typeof wordImportCommitInput>;
export type WordImportApproveInput = z.input<typeof wordImportApproveInput>;

export const wordImportsContract = {
  get: wordRoute("GET", "/v1/docs/word-imports/{importId}", "Lượt nhập Word, các file và quyền của mình")
    .input(importInput)
    .output(wordImportGetOutput),
  list: wordRoute("GET", "/v1/docs/word-imports/list", "Các lượt nhập Word của một nhà mình đọc được")
    .input(homeInput.merge(page).extend({ state: wordImportState.optional() }))
    .output(paged(wordImport)),
  file: wordRoute("GET", "/v1/docs/word-imports/files/{fileId}", "Markdown và ảnh của một file để xem trước")
    .input(fileInput)
    .output(wordImportFileDetail),
  update: wordRoute("PATCH", "/v1/docs/word-imports/files/{fileId}", "Sửa đường dẫn, tiêu đề hoặc cách chuyển một file")
    .input(wordImportUpdateInput)
    .output(wordImportFile),
  commit: wordRoute(
    "POST",
    "/v1/docs/word-imports/{importId}/commit",
    "Tạo tài liệu, hoặc gửi duyệt khi chỉ có quyền đề xuất",
  )
    .errors(docSecretErrors)
    .input(wordImportCommitInput)
    .output(wordImportGetOutput),
  cancel: wordRoute("POST", "/v1/docs/word-imports/{importId}/cancel", "Huỷ lượt nhập, giữ tài liệu đã tạo")
    .input(importInput)
    .output(wordImport),
  confirmLink: wordRoute(
    "POST",
    "/v1/docs/word-imports/files/{fileId}/confirm-link",
    "Lấy bản chuyển làm gốc khi gắn tài liệu có sẵn với file Word",
  )
    .input(fileInput)
    .output(wordImportFile),
  approve: wordRoute(
    "POST",
    "/v1/docs/word-imports/{importId}/approve",
    "Duyệt đề xuất của các file đã chọn (quản trị đội)",
  )
    .errors(docSecretErrors)
    .input(wordImportApproveInput)
    .output(wordImportGetOutput),
  ofDoc: wordRoute("GET", "/v1/docs/word-imports/of-doc", "Lần nhập Word gần nhất của một tài liệu")
    .input(z.object({ docKey }))
    .output(z.object({ import: wordImport, file: wordImportFile }).nullable()),
};
