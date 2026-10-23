import { z } from "zod";
import { id, orgErrors, orgRoute, queryFlag } from "./common.ts";
import { docKey } from "./knowledge.ts";
import { projectKey } from "./projects.ts";
import { checkRepoPath, SDLC_PATH_ERROR } from "./sdlc.ts";
import { secretFinding } from "./secret-scan.ts";

/**
 * Artifact (specs/012, ADR 0023): sản phẩm agent hay người tạo ra để xem (sơ đồ, trang tương tác, tài liệu nháp), có
 * phiên bản, phạm vi và link công khai. Chính sách tổ chức ở `orgArtifactPolicy` (policies.ts), thẻ trong chat ở
 * `chatMessage.artifact` (leader.ts), bộ quét bí mật ở secret-scan.ts.
 */

// ---- Giá trị liệt kê -----------------------------------------------------------------------------------------------

export const ARTIFACT_TYPES = [
  "markdown",
  "code",
  "html",
  "react",
  "svg",
  "mermaid",
  "csv",
  "json",
  "image",
  "pdf",
] as const;
export const artifactType = z.enum(ARTIFACT_TYPES);
export type ArtifactType = z.output<typeof artifactType>;
/** Loại bật mặc định (PO chốt 2026-10-14); loại khác có trình xem sau MVP. */
export const ARTIFACT_MVP_TYPES: readonly ArtifactType[] = ["markdown", "code", "html", "mermaid", "react"];
/** Loại chạy trong khung cách ly ở hub và app; trên trang công khai mọi loại đều vào khung (FR-144). */
export const ARTIFACT_FRAME_TYPES: readonly ArtifactType[] = ["html", "react", "svg", "mermaid", "csv", "image", "pdf"];

export const artifactScope = z.enum(["private", "project", "team", "org"]);
export type ArtifactScope = z.output<typeof artifactScope>;
export const ARTIFACT_MVP_SCOPES: readonly ArtifactScope[] = ["private", "project"];

export const artifactOrigin = z.enum(["leader", "terminal", "run", "mcp", "manual"]);
export type ArtifactOrigin = z.output<typeof artifactOrigin>;

export const artifactLinkKind = z.enum(["chat_thread", "terminal_session", "run", "task", "sdlc_item", "doc"]);
export type ArtifactLinkKind = z.output<typeof artifactLinkKind>;

export const artifactTheme = z.enum(["light", "dark"]);
export type ArtifactTheme = z.output<typeof artifactTheme>;

export const artifactPublicLinkRevokeReason = z.enum([
  "manual",
  "deleted",
  "owner_changed",
  "tombstoned",
  "owner_left",
  "org_disabled",
]);
export type ArtifactPublicLinkRevokeReason = z.output<typeof artifactPublicLinkRevokeReason>;

// ---- Giới hạn ------------------------------------------------------------------------------------------------------

const MIB = 1024 * 1024;

/**
 * Mặc định của C10 và các trần cố định. Trần người vận hành (`HIVE_ARTIFACT_*`) và chính sách tổ chức chỉ hạ các giá trị
 * `default*`; hub kiểm cỡ chính xác (byte UTF-8) và trả `ARTIFACT_TOO_LARGE`, nên trần ký tự ở schema chỉ chặn thân yêu
 * cầu khổng lồ trước khi tới nghiệp vụ.
 */
export const ARTIFACT_LIMITS = {
  defaultVersionBytes: MIB,
  defaultBlobBytes: 20 * MIB,
  defaultMaxVersions: 200,
  maxVersionsCeiling: 1000,
  defaultRunArtifacts: 20,
  defaultRunVersions: 100,
  defaultOrgQuotaBytes: 2048 * MIB,
  /** Trần cứng cho chính sách và biến môi trường; vượt thì hub hạ về đây. */
  versionBytesCeiling: 16 * MIB,
  blobBytesCeiling: 512 * MIB,
  orgQuotaBytesCeiling: 1024 * 1024 * MIB,
  contentChars: 16 * MIB,
  titleChars: 200,
  messageChars: 500,
  versionNameChars: 80,
  pageErrors: 20,
  pageErrorChars: 2000,
  fixNoteChars: 2000,
  publicLinkMaxDays: 30,
  publicLinkDefaultDays: 7,
  activePublicLinks: 10,
} as const;

// ---- Lỗi -----------------------------------------------------------------------------------------------------------

type ArtifactErrorStatus = "BAD_REQUEST" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT";

/**
 * Mã lỗi nghiệp vụ (đi trong `data.code`) và lỗi oRPC tương ứng. Câu ở đây là câu mặc định; hub được ghi câu cụ thể hơn
 * (vd. "Artifact quá lớn (1,4 MiB > 1 MiB).") nhưng giữ mã, vì client và agent phân biệt lý do bằng mã.
 */
export const ARTIFACT_ERRORS = {
  ARTIFACT_NOT_FOUND: { status: "NOT_FOUND", message: "Không tìm thấy artifact." },
  ARTIFACT_VERSION_CONFLICT: { status: "CONFLICT", message: "Artifact đã có bản mới hơn. Đọc lại rồi sửa." },
  ARTIFACT_VERSION_LIMIT: {
    status: "CONFLICT",
    message: "Artifact đã đủ số phiên bản tối đa. Nhân bản thành artifact mới để sửa tiếp.",
  },
  ARTIFACT_TOO_LARGE: { status: "BAD_REQUEST", message: "Artifact quá lớn." },
  ARTIFACT_RUN_LIMIT: { status: "CONFLICT", message: "Run đã tạo đủ số artifact hoặc phiên bản cho phép." },
  ARTIFACT_QUOTA_EXCEEDED: { status: "CONFLICT", message: "Tổ chức đã dùng hết dung lượng artifact." },
  ARTIFACT_SECRET_FOUND: {
    status: "BAD_REQUEST",
    message: "Có chuỗi giống bí mật trong nội dung. Xoá rồi lưu lại.",
  },
  ARTIFACT_TYPE_DISABLED: { status: "FORBIDDEN", message: "Loại artifact này đang tắt trong chính sách của tổ chức." },
  ARTIFACT_SCOPE_DISABLED: { status: "FORBIDDEN", message: "Phạm vi này đang tắt trong chính sách của tổ chức." },
  ARTIFACT_SCOPE_TOO_NARROW: {
    status: "CONFLICT",
    message: "Phạm vi của artifact hẹp hơn nơi gắn. Chia sẻ cho dự án trước khi gắn.",
  },
  ARTIFACT_LINK_FORBIDDEN: { status: "FORBIDDEN", message: "Không gắn được artifact vào đây." },
  ARTIFACT_RUN_KIND: { status: "FORBIDDEN", message: "Loại run này không tạo hay sửa được artifact." },
  ARTIFACT_IMPORT_NOT_ALLOWED: {
    status: "BAD_REQUEST",
    message: "Trang import thư viện không có trong bộ thư viện đóng gói của hub.",
  },
  ARTIFACTS_DISABLED: { status: "FORBIDDEN", message: "Artifact đang tắt trong tổ chức." },
  ARTIFACT_LINK_OWNER_ONLY: { status: "FORBIDDEN", message: "Chỉ chủ artifact tạo được link công khai." },
  ARTIFACT_LINK_LIMIT: {
    status: "CONFLICT",
    message: `Artifact đã có ${ARTIFACT_LIMITS.activePublicLinks} link công khai còn hiệu lực. Thu hồi bớt rồi tạo lại.`,
  },
  ARTIFACT_PUBLIC_LINKS_DISABLED: {
    status: "FORBIDDEN",
    message: "Link công khai đang tắt trong chính sách của tổ chức.",
  },
  ARTIFACT_LINK_EXPIRY_INVALID: { status: "BAD_REQUEST", message: "Hạn link vượt mức tối đa của tổ chức." },
} as const satisfies Record<string, { status: ArtifactErrorStatus; message: string }>;
export type ArtifactErrorCode = keyof typeof ARTIFACT_ERRORS;

const artifactErrorDetail = {
  /** `ARTIFACT_SECRET_FOUND`: dòng và loại, không có chuỗi. */
  findings: z.array(secretFinding).optional(),
  /** `ARTIFACT_VERSION_CONFLICT`: bản mới nhất để agent hay người gộp. `content` null khi bản đó đã bị xoá vì bí mật. */
  latest: z.object({ version: z.int().min(1), content: z.string().nullable() }).optional(),
  /** `ARTIFACT_IMPORT_NOT_ALLOWED`: tên module không có trong bộ đóng gói. */
  imports: z.array(z.string()).optional(),
  /** Giới hạn đã chạm (`*_LIMIT`, `ARTIFACT_TOO_LARGE`, `ARTIFACT_QUOTA_EXCEEDED`), để giao diện ghi số. */
  limit: z.number().optional(),
};
export const artifactErrorData = z.object({ code: z.string(), ...artifactErrorDetail }).optional();
export type ArtifactErrorData = z.output<typeof artifactErrorData>;

const artifactErrors = {
  FORBIDDEN: { message: orgErrors.FORBIDDEN.message, data: artifactErrorData },
  NOT_FOUND: { message: orgErrors.NOT_FOUND.message, data: artifactErrorData },
  CONFLICT: { message: orgErrors.CONFLICT.message, data: artifactErrorData },
  // Lỗi kiểm đầu vào của oRPC mang `issues` và không có `code`; schema chặt thì oRPC coi lỗi đó là lỗi lạ.
  BAD_REQUEST: {
    message: orgErrors.BAD_REQUEST.message,
    data: z.looseObject({ code: z.string().optional(), ...artifactErrorDetail }).optional(),
  },
};

const artifactRoute = (method: "GET" | "POST" | "PATCH" | "DELETE", path: `/v1/${string}`, summary: string) =>
  orgRoute(method, path, summary, "artifacts").errors(artifactErrors);

// ---- Trường dùng chung ---------------------------------------------------------------------------------------------

/** Số phiên bản trong path hay query là chuỗi; coerce để REST và OpenAPI nhận được số. */
const versionNumber = z.coerce.number().int().min(1);
const artifactTitle = z
  .string()
  .trim()
  .min(1, "Tiêu đề không được để trống.")
  .max(ARTIFACT_LIMITS.titleChars, `Tiêu đề dài tối đa ${ARTIFACT_LIMITS.titleChars} ký tự.`);
const artifactContent = z.string().max(ARTIFACT_LIMITS.contentChars, "Nội dung quá lớn.");
const artifactLanguage = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9+#._-]+$/, "Tên ngôn ngữ chỉ gồm chữ, số và + # . _ -");
const versionMessage = z
  .string()
  .trim()
  .max(ARTIFACT_LIMITS.messageChars, `Lời nhắn dài tối đa ${ARTIFACT_LIMITS.messageChars} ký tự.`);
const versionName = z
  .string()
  .trim()
  .min(1, "Tên phiên bản không được để trống.")
  .max(ARTIFACT_LIMITS.versionNameChars, `Tên phiên bản dài tối đa ${ARTIFACT_LIMITS.versionNameChars} ký tự.`);
const userRef = z.object({ id: z.string(), name: z.string() });
const cursor = z.string().max(200);

/** Đường dẫn web của một phiên bản; agent dán vào chữ trả lời, thẻ trong chat mở bằng đường dẫn này. */
export const artifactWebPath = (artifactId: string, version?: number) =>
  version === undefined ? `/artifacts/${artifactId}` : `/artifacts/${artifactId}/v/${version}`;

/** Phạm vi `project` cần dự án, `team` cần đội; phạm vi khác bỏ qua hai trường đó. */
function requireScopeTarget(
  value: { scope?: ArtifactScope | undefined; projectKey?: string | undefined; teamId?: string | undefined },
  ctx: z.RefinementCtx,
) {
  if (value.scope === "project" && !value.projectKey)
    ctx.addIssue({ code: "custom", path: ["projectKey"], message: "Chọn dự án cho phạm vi dự án." });
  if (value.scope === "team" && !value.teamId)
    ctx.addIssue({ code: "custom", path: ["teamId"], message: "Chọn đội cho phạm vi đội." });
}

// ---- Đối tượng -----------------------------------------------------------------------------------------------------

/** Một dòng thư viện, không có nội dung. */
export const artifactSummary = z.object({
  id,
  title: z.string(),
  type: artifactType,
  /** Chỉ cho `code`. */
  language: z.string().nullable(),
  scope: artifactScope,
  teamId: id.nullable(),
  project: z.object({ id, key: z.string(), name: z.string() }).nullable(),
  /** Dự án của chat/run sinh ra artifact: chỉ để gợi ý khi chia sẻ, không cấp quyền đọc. */
  originProjectId: id.nullable(),
  owner: userRef,
  origin: artifactOrigin,
  latestVersion: z.int().min(1),
  /** Tổng cỡ các phiên bản (kể cả bản biên dịch), tính vào dung lượng tổ chức. */
  sizeBytes: z.number().int().nonnegative(),
  duplicatedFrom: z.object({ id, version: z.int().min(1) }).nullable(),
  deletedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ArtifactSummary = z.output<typeof artifactSummary>;

export const artifactVersionMeta = z.object({
  version: z.int().min(1),
  sha256: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  /** Ảnh và PDF: tệp nằm ở kho file của nền tảng, `content` luôn null. */
  hasBlob: z.boolean(),
  /** Tác giả là người hoặc run, không bao giờ cả hai. */
  authorUser: userRef.nullable(),
  authorRunId: id.nullable(),
  origin: artifactOrigin,
  message: z.string().nullable(),
  name: z.string().nullable(),
  restoredFrom: z.int().min(1).nullable(),
  /** Có lỗi biên dịch (`react`); chữ lỗi ở `artifactVersion.compileError`. */
  hasCompileError: z.boolean(),
  /** Bản bị xoá vì bí mật: còn số và tác giả, mất nội dung. */
  tombstonedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type ArtifactVersionMeta = z.output<typeof artifactVersionMeta>;

export const artifactVersion = artifactVersionMeta.extend({
  /** null khi bản đã bị xoá vì bí mật (hoặc là ảnh/PDF: xem `hasBlob`). */
  content: z.string().nullable(),
  compileError: z.string().nullable(),
});
export type ArtifactVersion = z.output<typeof artifactVersion>;

/** Quyền của người đang xem, để giao diện ẩn nút thay vì để hub từ chối. */
export const artifactAccess = z.object({
  /** Tạo phiên bản, đổi tiêu đề. */
  write: z.boolean(),
  /** Đổi phạm vi, chuyển chủ, xoá, khôi phục, xoá phiên bản. */
  manage: z.boolean(),
  /** Chủ: tạo link công khai. */
  owner: z.boolean(),
});
export type ArtifactAccess = z.output<typeof artifactAccess>;

export const artifactDetail = z.object({ artifact: artifactSummary, version: artifactVersion, access: artifactAccess });
export type ArtifactDetail = z.output<typeof artifactDetail>;

export const artifactWriteResult = z.object({
  artifact: artifactSummary,
  version: artifactVersionMeta,
  /** Lỗi biên dịch `react`: phiên bản vẫn được lưu, trang hiện lỗi thay cho nội dung. */
  compileError: z.string().nullable(),
});
export type ArtifactWriteResult = z.output<typeof artifactWriteResult>;

export const artifactLink = z.object({
  targetKind: artifactLinkKind,
  targetId: id,
  /** Tên đích để hiện (tiêu đề cuộc trò chuyện, key task…); null khi người xem không đọc được đích hay đích đã mất. */
  title: z.string().nullable(),
  createdByUserId: z.string().nullable(),
  createdByRunId: id.nullable(),
  createdAt: z.iso.datetime(),
});
export type ArtifactLink = z.output<typeof artifactLink>;

export const artifactPublicLink = z.object({
  id,
  artifactId: id,
  version: z.int().min(1),
  createdBy: z.string(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
  revokedBy: z.string().nullable(),
  revokeReason: artifactPublicLinkRevokeReason.nullable(),
  viewCount: z.number().int().nonnegative(),
  lastViewedAt: z.iso.datetime().nullable(),
  /** Chưa hết hạn, chưa thu hồi. Chính sách tắt link không đổi cờ này (link chạy lại khi bật). */
  active: z.boolean(),
});
export type ArtifactPublicLink = z.output<typeof artifactPublicLink>;

/** Dòng ở màn Link công khai của quản trị: chỉ metadata, không mở được nội dung (C5). */
export const artifactPublicLinkOrgItem = artifactPublicLink.extend({
  artifactTitle: z.string(),
  artifactType: artifactType,
  owner: userRef,
});
export type ArtifactPublicLinkOrgItem = z.output<typeof artifactPublicLinkOrgItem>;

export const artifactUsage = z.object({
  usedBytes: z.number().int().nonnegative(),
  quotaBytes: z.number().int().nonnegative(),
  artifacts: z.number().int().nonnegative(),
  byProject: z.array(
    z.object({
      project: z.object({ id, key: z.string(), name: z.string() }),
      bytes: z.number().int().nonnegative(),
      artifacts: z.number().int().nonnegative(),
    }),
  ),
  /** Theo chủ, chỉ số liệu: quản trị không đọc nội dung `private` của người khác (C5). */
  byUser: z.array(
    z.object({
      user: userRef,
      bytes: z.number().int().nonnegative(),
      artifacts: z.number().int().nonnegative(),
    }),
  ),
});
export type ArtifactUsage = z.output<typeof artifactUsage>;

/** Chính sách đang áp (đã hạ theo trần người vận hành) mà mọi thành viên đọc được để ẩn loại, phạm vi, nút link. */
export const artifactSettings = z.object({
  enabled: z.boolean(),
  types: z.array(artifactType),
  scopes: z.array(artifactScope),
  maxVersionBytes: z.number().int().positive(),
  maxVersions: z.int().min(1),
  publicLinks: z.object({ enabled: z.boolean(), maxDays: z.int().min(1).max(ARTIFACT_LIMITS.publicLinkMaxDays) }),
});
export type ArtifactSettings = z.output<typeof artifactSettings>;

/** Lỗi chạy của trang trong khung cách ly, gửi kèm "Nhờ Leader sửa" (C18). Là dữ liệu không tin cậy do trang viết. */
export const artifactPageErrorKind = z.enum(["error", "console", "compile"]);
export const artifactPageError = z.object({
  kind: artifactPageErrorKind,
  message: z
    .string()
    .trim()
    .min(1)
    .max(ARTIFACT_LIMITS.pageErrorChars, `Mỗi lỗi dài tối đa ${ARTIFACT_LIMITS.pageErrorChars} ký tự.`),
});
export type ArtifactPageError = z.output<typeof artifactPageError>;
export const artifactPageErrors = z
  .array(artifactPageError)
  .max(ARTIFACT_LIMITS.pageErrors, `Gửi tối đa ${ARTIFACT_LIMITS.pageErrors} lỗi.`);

// ---- Đầu vào -------------------------------------------------------------------------------------------------------

const artifactCreateShape = {
  type: artifactType,
  title: artifactTitle,
  content: artifactContent,
  language: artifactLanguage.optional(),
  /** Bỏ trống là `private` của người tạo. */
  scope: artifactScope.optional(),
  projectKey: projectKey.optional(),
  teamId: id.optional(),
  message: versionMessage.optional(),
  /** Nhân bản từ một phiên bản đọc được (người chỉ đọc sửa bản riêng của mình). */
  duplicateOf: z.object({ id, version: z.int().min(1) }).optional(),
};
export const artifactCreate = z.object(artifactCreateShape).superRefine(requireScopeTarget);
export type ArtifactCreate = z.input<typeof artifactCreate>;

const artifactUpdateShape = {
  id,
  content: artifactContent,
  /** Khoá lạc quan; thiếu thì hub chỉ nhận khi người gọi là tác giả bản mới nhất (FR-005). */
  baseVersion: z.int().min(1).optional(),
  title: artifactTitle.optional(),
  message: versionMessage.optional(),
};
export const artifactUpdate = z.object(artifactUpdateShape);
export type ArtifactUpdate = z.input<typeof artifactUpdate>;

const artifactListShape = {
  scope: artifactScope.optional(),
  type: artifactType.optional(),
  origin: artifactOrigin.optional(),
  projectKey: projectKey.optional(),
  threadId: id.optional(),
  terminalSessionId: id.optional(),
  runId: id.optional(),
  taskId: id.optional(),
  /** Chỉ artifact tôi là chủ ("Của tôi"). */
  mine: queryFlag.default(false),
  /** Tìm theo tiêu đề và nội dung bản mới nhất. */
  query: z.string().trim().min(1).max(200).optional(),
  cursor: cursor.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
};
export const artifactListQuery = z.object({
  ...artifactListShape,
  /** Thùng rác: artifact đã xoá mềm trong 30 ngày, chỉ những cái tôi được khôi phục. */
  trash: queryFlag.default(false),
});
export type ArtifactListQuery = z.input<typeof artifactListQuery>;
export const artifactListPage = z.object({ items: z.array(artifactSummary), nextCursor: cursor.nullable() });
export type ArtifactListPage = z.output<typeof artifactListPage>;

export const artifactSetScopeInput = z
  .object({ id, scope: artifactScope, projectKey: projectKey.optional(), teamId: id.optional() })
  .superRefine(requireScopeTarget);

export const artifactPublicLinkCreate = z.object({
  id,
  version: versionNumber,
  /** Hub còn hạ theo `publicLinks.maxDays` của tổ chức và `HIVE_ARTIFACT_LINK_MAX_DAYS` (`ARTIFACT_LINK_EXPIRY_INVALID`). */
  expiresInDays: z
    .int()
    .min(1, "Hạn link ít nhất 1 ngày.")
    .max(ARTIFACT_LIMITS.publicLinkMaxDays, `Hạn link tối đa ${ARTIFACT_LIMITS.publicLinkMaxDays} ngày.`)
    .default(ARTIFACT_LIMITS.publicLinkDefaultDays),
});

export const artifactAskLeaderFix = z.object({
  id,
  version: versionNumber,
  /** Người xem sửa/xoá được trước khi gửi, nên có thể rỗng khi chỉ còn lời nhắn. */
  errors: artifactPageErrors,
  note: z
    .string()
    .trim()
    .max(ARTIFACT_LIMITS.fixNoteChars, `Lời nhắn dài tối đa ${ARTIFACT_LIMITS.fixNoteChars} ký tự.`)
    .optional(),
  /** Cuộc trò chuyện của người gọi đang mở artifact; bỏ trống thì hub tạo cuộc trò chuyện mới. */
  threadId: id.optional(),
});
export type ArtifactAskLeaderFix = z.input<typeof artifactAskLeaderFix>;

/** Đường dẫn trong repo cho "Lưu vào repo": như tài liệu AI SDLC (spec 011 FR-003) nhưng không có biến khuôn. */
const artifactRepoPath = z
  .string()
  .refine((path) => !/[{}]/.test(path) && checkRepoPath(path) === null, SDLC_PATH_ERROR);

// ---- MCP -----------------------------------------------------------------------------------------------------------

/**
 * `artifact_create`. Phạm vi của agent chỉ `private` (người mở chat/phiên/token) hoặc `project` (dự án của run); dự án
 * không chọn được vì lấy từ run (FR-032).
 */
export const artifactToolCreate = z.object({
  type: artifactType,
  title: artifactTitle,
  content: artifactContent,
  language: artifactLanguage.optional(),
  scope: z.enum(["private", "project"]).optional(),
  /** Cuộc trò chuyện của run `leader` đang gọi; hub thêm thẻ vào đó. */
  threadId: id.optional(),
  /** Phiên Terminal Leader của principal. */
  terminalSessionId: id.optional(),
  message: versionMessage.optional(),
  duplicateOf: artifactCreateShape.duplicateOf,
});
export type ArtifactToolCreate = z.input<typeof artifactToolCreate>;

/** `artifact_update`: cùng đầu vào với route. */
export const artifactToolUpdate = artifactUpdate;

/** `artifact_get` (`readOnly`). */
export const artifactToolGet = z.object({ id, version: z.int().min(1).optional() });

/** `artifact_list` (`readOnly`): như thư viện, không có thùng rác. */
export const artifactToolList = z.object(artifactListShape);

/** Kết quả của `artifact_create` và `artifact_update`. */
export const artifactToolResult = z.object({
  id,
  version: z.int().min(1),
  /** `artifactWebPath`. */
  url: z.string(),
  compileError: z.string().optional(),
});
export type ArtifactToolResult = z.output<typeof artifactToolResult>;

// ---- Route ---------------------------------------------------------------------------------------------------------

const versionRef = z.object({ id, version: versionNumber });

export const artifactsContract = {
  settings: artifactRoute("GET", "/v1/artifact-settings", "Chính sách artifact đang áp của tổ chức").output(
    artifactSettings,
  ),
  list: artifactRoute("GET", "/v1/artifacts", "Thư viện artifact người gọi đọc được")
    .input(artifactListQuery)
    .output(artifactListPage),
  get: artifactRoute("GET", "/v1/artifacts/{id}", "Một artifact và một phiên bản (mặc định bản mới nhất)")
    .input(z.object({ id, version: versionNumber.optional() }))
    .output(artifactDetail),
  create: artifactRoute("POST", "/v1/artifacts", "Tạo artifact (phiên bản 1)")
    .input(artifactCreate)
    .output(artifactWriteResult),
  update: artifactRoute("POST", "/v1/artifacts/{id}/versions", "Lưu phiên bản mới")
    .input(artifactUpdate)
    .output(artifactWriteResult),
  rename: artifactRoute("POST", "/v1/artifacts/{id}/rename", "Đổi tiêu đề artifact")
    .input(z.object({ id, title: artifactTitle }))
    .output(artifactSummary),
  setScope: artifactRoute("POST", "/v1/artifacts/{id}/scope", "Đổi phạm vi artifact (chủ, quản trị phạm vi)")
    .input(artifactSetScopeInput)
    .output(artifactSummary),
  transferOwner: artifactRoute("POST", "/v1/artifacts/{id}/owner", "Chuyển chủ artifact; thu hồi mọi link công khai")
    .input(z.object({ id, userId: z.string().min(1).max(100) }))
    .output(artifactSummary),
  duplicate: artifactRoute("POST", "/v1/artifacts/{id}/duplicate", "Nhân bản thành artifact riêng của người gọi")
    .input(z.object({ id, version: versionNumber.optional(), title: artifactTitle.optional() }))
    .output(artifactWriteResult),
  delete: artifactRoute("DELETE", "/v1/artifacts/{id}", "Đưa artifact vào thùng rác; thu hồi mọi link công khai")
    .input(z.object({ id }))
    .output(artifactSummary),
  restore: artifactRoute("POST", "/v1/artifacts/{id}/restore", "Khôi phục artifact từ thùng rác")
    .input(z.object({ id }))
    .output(artifactSummary),
  versions: {
    list: artifactRoute("GET", "/v1/artifacts/{id}/versions", "Lịch sử phiên bản, mới nhất trước")
      .input(z.object({ id }))
      .output(z.array(artifactVersionMeta)),
    rename: artifactRoute("POST", "/v1/artifacts/{id}/versions/{version}/rename", "Đặt hoặc bỏ tên phiên bản")
      .input(versionRef.extend({ name: versionName.nullable() }))
      .output(artifactVersionMeta),
    /** Khôi phục là phiên bản mới có `restoredFrom`, không xoá bản giữa. */
    restore: artifactRoute("POST", "/v1/artifacts/{id}/versions/{version}/restore", "Khôi phục nội dung một phiên bản")
      .input(versionRef.extend({ baseVersion: z.int().min(1).optional() }))
      .output(artifactWriteResult),
    tombstone: artifactRoute(
      "POST",
      "/v1/artifacts/{id}/versions/{version}/tombstone",
      "Xoá nội dung một phiên bản vì bí mật; thu hồi link công khai của bản đó",
    )
      .input(versionRef)
      .output(artifactVersionMeta),
  },
  links: {
    list: artifactRoute("GET", "/v1/artifacts/{id}/links", "Nơi artifact được gắn")
      .input(z.object({ id }))
      .output(z.array(artifactLink)),
    add: artifactRoute("POST", "/v1/artifacts/{id}/links", "Gắn artifact vào task, run, tài liệu…")
      .input(z.object({ id, targetKind: artifactLinkKind, targetId: id }))
      .output(artifactLink),
    remove: artifactRoute("POST", "/v1/artifacts/{id}/links/remove", "Bỏ gắn artifact")
      .input(z.object({ id, targetKind: artifactLinkKind, targetId: id }))
      .output(z.object({ removed: z.boolean() })),
  },
  frameUrl: artifactRoute("GET", "/v1/artifacts/{id}/versions/{version}/frame-url", "Vé ngắn hạn của khung cách ly")
    .input(versionRef.extend({ theme: artifactTheme.default("light") }))
    .output(z.object({ url: z.string(), expiresAt: z.iso.datetime() })),
  preview: artifactRoute("POST", "/v1/artifacts/preview", "Xem trước nội dung chưa lưu trong khung cách ly")
    .input(z.object({ type: artifactType, content: artifactContent, theme: artifactTheme.default("light") }))
    .output(z.object({ url: z.string(), expiresAt: z.iso.datetime(), compileError: z.string().nullable() })),
  frameDocument: artifactRoute(
    "GET",
    "/v1/artifacts/{id}/versions/{version}/frame-document",
    "Tài liệu khung đã dựng, để app desktop đệm và mở offline",
  )
    .input(versionRef.extend({ theme: artifactTheme.default("light") }))
    .output(z.object({ html: z.string(), csp: z.string() })),
  usage: artifactRoute(
    "GET",
    "/v1/artifact-usage",
    "Dung lượng artifact theo dự án và người (quản trị tổ chức)",
  ).output(artifactUsage),
  publicLinks: {
    create: artifactRoute("POST", "/v1/artifacts/{id}/public-links", "Tạo link công khai cho một phiên bản (chỉ chủ)")
      .input(artifactPublicLinkCreate)
      // `url` chứa mã link và chỉ có ở đây: hub chỉ lưu sha256 nên không trả lại được.
      .output(z.object({ link: artifactPublicLink, url: z.string() })),
    list: artifactRoute("GET", "/v1/artifacts/{id}/public-links", "Link công khai của artifact (chủ)")
      .input(z.object({ id }))
      .output(z.array(artifactPublicLink)),
    revoke: artifactRoute("POST", "/v1/artifact-public-links/{linkId}/revoke", "Thu hồi link công khai")
      .input(z.object({ linkId: id }))
      .output(artifactPublicLink),
    orgList: artifactRoute("GET", "/v1/artifact-public-links", "Link công khai còn hiệu lực của tổ chức (quản trị)")
      .input(z.object({ cursor: cursor.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }))
      .output(z.object({ items: z.array(artifactPublicLinkOrgItem), nextCursor: cursor.nullable() })),
  },
  askLeaderFix: artifactRoute("POST", "/v1/artifacts/{id}/ask-leader-fix", "Gửi lỗi của trang cho Leader sửa")
    .input(artifactAskLeaderFix)
    .output(z.object({ threadId: id, messageId: id, runId: id.nullable() })),
  /** Sau MVP (US11): tạo đề xuất tài liệu `knowledge`, chỉ loại `markdown`. */
  toDoc: artifactRoute("POST", "/v1/artifacts/{id}/to-doc", "Chuyển phiên bản thành đề xuất tài liệu")
    .input(versionRef.extend({ key: docKey, title: artifactTitle.optional() }))
    .output(z.object({ proposalId: id })),
  /** Sau MVP (US11): một PR một artifact một phiên bản, đi chính sách kết quả của dự án. */
  toRepo: artifactRoute("POST", "/v1/artifacts/{id}/to-repo", "Mở PR lưu phiên bản vào repo của dự án")
    .input(versionRef.extend({ projectKey, path: artifactRepoPath, message: versionMessage.optional() }))
    .output(z.object({ branch: z.string(), prUrl: z.url().nullable() })),
};
