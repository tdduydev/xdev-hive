import { z } from "zod";
import { id, orgRoute } from "./common.ts";
import { DOC_MAX_CHARS, docKey, docSecretErrors, projectRef, scopeView } from "./knowledge.ts";
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
  repoCommit: sha,
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
