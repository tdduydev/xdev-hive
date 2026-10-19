import { describe, expect, it } from "vitest";
import {
  DOCSYNC_ERRORS,
  docAssetDownloadOutput,
  docAssetUploadOutput,
  docConflict,
  docConflictResolveInput,
  docHome,
  docHomeConfigureOrgInput,
  docHomeConfigureProjectInput,
  docHomeGetInput,
  docHomeStatus,
  docImportConfirmSecretInput,
  docImportScanInput,
  docImportStartInput,
  docImportState,
  docResolvedLink,
  docSyncErrorData,
  docSyncState,
  docTreeItem,
  docTreeMoveInput,
  WORD_IMPORT_ERRORS,
  WORD_IMPORT_UPLOAD_PATH,
  WORD_IMPORT_WARNINGS,
  wordImportCommitInput,
  wordImportErrorCode,
  wordImportErrorData,
  wordImportFile,
  wordImportFileState,
  wordImportFormatOf,
  wordImportGetOutput,
  wordImportMediaPath,
  wordImportOriginalPath,
  wordImportState,
  wordImportUpdateInput,
  wordImportUploadInput,
  wordImportUploadOutput,
  wordImportWarning,
  wordImportWarningCode,
} from "./doc-sync.ts";
import { contract, healthOutput } from "./index.ts";
import {
  DOC_MAX_CHARS,
  docAssetGetInput,
  docListInput,
  docSaveInput,
  docSearchInput,
  docSearchMcpInput,
  docSearchOutput,
  docSecretErrorData,
  docVersion,
  docVersionSource,
  proposal,
} from "./knowledge.ts";
import { notificationChannelEvent, notificationEvent } from "./notify.ts";
import { docRepoPath } from "./projects.ts";

const id = "00000000-0000-4000-8000-000000000001";
const orgConfig = { connectionId: id, owner: "group/subgroup", name: "org-docs" };

describe("hợp đồng nhà tài liệu", () => {
  it("nhà tổ chức mặc định direct, không đoán nhánh repo, có thể tạo repo", () => {
    expect(docHomeConfigureOrgInput.parse(orgConfig)).toMatchObject({
      create: false,
      mode: "direct",
      root: "",
      assetsDir: "assets",
      repoChangesNeedReview: false,
    });
    expect(docHomeConfigureOrgInput.parse(orgConfig).branch).toBeUndefined();
    expect(
      docHomeConfigureOrgInput.parse({ ...orgConfig, create: true, branch: "docs/main", mode: "pr" }),
    ).toMatchObject({ create: true, branch: "docs/main", mode: "pr" });
    expect(docHomeGetInput.parse({})).toEqual({});
    expect(docHomeGetInput.parse({ project: "hive" })).toEqual({ project: "hive" });
  });

  it("nhà dự án dùng settings docs có mặc định và nhận dự án bằng key hoặc id", () => {
    for (const project of ["hive", id]) {
      expect(docHomeConfigureProjectInput.parse({ project, settings: {} }).settings).toMatchObject({
        enabled: false,
        root: "docs/",
        repoSync: "pr",
        assetsDir: "assets",
      });
    }
    expect(docHomeConfigureProjectInput.safeParse({ settings: {} }).success).toBe(false);
    expect(docHomeConfigureOrgInput.safeParse({ ...orgConfig, mode: "auto" }).success).toBe(false);
  });

  it("giữ tên Unicode và khoảng trắng, từ chối đường dẫn thoát repo", () => {
    for (const path of ["docs/", "Tài liệu/Thiết kế.md", "docs/assets/image.png"]) {
      expect(docRepoPath.parse(path)).toBe(path);
    }
    for (const path of [
      "",
      "/docs",
      "../docs",
      "docs/../file.md",
      "./docs",
      "docs//a",
      "docs\\a",
      "C:/docs",
      "docs/\u0000a",
    ]) {
      expect(docRepoPath.safeParse(path).success, path).toBe(false);
    }
    for (const branch of ["../main", "/main", "a//b", "main.lock", "main ", "a."]) {
      expect(docHomeConfigureOrgInput.safeParse({ ...orgConfig, branch }).success, branch).toBe(false);
    }
  });
});

describe("nhập, xung đột, file và cây", () => {
  it("nhập chỉ chọn file, xác nhận bí mật theo từng đường dẫn", () => {
    expect(docImportScanInput.parse({ homeId: id })).toEqual({ homeId: id });
    expect(docImportStartInput.parse({ importId: id, paths: ["docs/API.md"] }).paths).toEqual(["docs/API.md"]);
    for (const paths of [[], ["../secret.md"], ["docs/"]]) {
      expect(docImportStartInput.safeParse({ importId: id, paths }).success).toBe(false);
    }
    expect(docImportConfirmSecretInput.safeParse({ importId: id }).success).toBe(false);
    expect(docImportConfirmSecretInput.parse({ importId: id, path: "docs/API.md" }).path).toBe("docs/API.md");
  });

  it("trùng key phải chọn key mới hoặc bản dùng để gắn tài liệu hub", () => {
    const input = { importId: id, paths: ["docs/API.md"] };
    const rename = { path: "docs/API.md", action: "rename", key: "org/api-2" };
    expect(docImportStartInput.parse({ ...input, resolutions: [rename] }).resolutions).toEqual([rename]);
    const attach = { path: "docs/API.md", action: "attach", key: "org/api", choice: "repo", baseVersion: 2 };
    expect(docImportStartInput.parse({ ...input, resolutions: [attach] }).resolutions).toEqual([attach]);
    const { choice: _, ...missingChoice } = attach;
    expect(docImportStartInput.safeParse({ ...input, resolutions: [missingChoice] }).success).toBe(false);
    expect(docImportStartInput.safeParse({ ...input, resolutions: [{ ...rename, key: "../escape" }] }).success).toBe(
      false,
    );
  });

  it("sửa tay cần nội dung và phiên bản, chấp nhận xoá hết nội dung", () => {
    const base = { id, baseVersion: 3 };
    for (const choice of ["hub", "repo"] as const)
      expect(docConflictResolveInput.parse({ ...base, choice }).choice).toBe(choice);
    expect(docConflictResolveInput.safeParse({ ...base, choice: "manual" }).success).toBe(false);
    expect(
      docConflictResolveInput.parse({ ...base, choice: "manual", content: "", acknowledgeSecrets: true }),
    ).toMatchObject({ content: "", acknowledgeSecrets: true });
    expect(
      docConflictResolveInput.safeParse({ ...base, choice: "manual", content: "x".repeat(DOC_MAX_CHARS + 1) }).success,
    ).toBe(false);
    expect(docConflictResolveInput.safeParse({ id, choice: "hub", baseVersion: 0 }).success).toBe(false);
  });

  it("di chuyển giữ key, cần phiên bản và đường dẫn file", () => {
    expect(docTreeMoveInput.parse({ key: "project/hive/api", baseVersion: 2, repoPath: "docs/new/API.md" }).key).toBe(
      "project/hive/api",
    );
    expect(docTreeMoveInput.safeParse({ key: "project/hive/api", baseVersion: 2, repoPath: "docs/new/" }).success).toBe(
      false,
    );
  });

  it("cây vẫn trả tài liệu hub chưa có nhà để hiện nhãn và không giấu nội dung cũ", () => {
    expect(
      docTreeItem.parse({
        homeId: null,
        path: null,
        key: "org/old-doc",
        title: "Tài liệu cũ",
        kind: "doc",
        state: null,
        docId: id,
        assetId: null,
        version: 1,
        error: null,
        prNumber: null,
        prUrl: null,
        repoUrl: null,
        repoCommit: null,
        scope: { level: "org", teamId: null, projectId: null },
      }),
    ).toMatchObject({ key: "org/old-doc", homeId: null, path: null, state: null });
    const schema = contract.docTree.list["~orpc"].inputSchema;
    if (!schema) throw new Error("Thiếu schema cây tài liệu.");
    expect(schema.parse({ project: "hive" })).toEqual({ project: "hive", limit: 50 });
  });

  it("khai báo phản hồi Hono mà không trùng route tải file của oRPC", () => {
    expect(docAssetUploadOutput.parse({ assetId: id, relativePath: "assets/image.png" })).toEqual({
      assetId: id,
      relativePath: "assets/image.png",
    });
    expect(docAssetDownloadOutput.parse(new Uint8Array([0, 255]))).toEqual(new Uint8Array([0, 255]));
    expect(Object.keys(contract.docAssets).sort()).toEqual(["list", "resolve"]);
    for (const value of [
      { kind: "doc", href: "./intro.md", key: "org/intro" },
      { kind: "asset", href: "assets/a.png", assetId: id, url: "/api/v1/docs/assets/test" },
      { kind: "external", href: "https://example.com", url: "https://example.com" },
      { kind: "missing", href: "removed.png", reason: "Không tìm thấy file." },
    ])
      expect(docResolvedLink.parse(value)).toEqual(value);
    expect(docAssetGetInput.parse({ docKey: "org/intro", path: "assets/a.png" }).path).toBe("assets/a.png");
  });
});

describe("tìm kiếm và bí mật", () => {
  it("REST và MCP có giới hạn 20, câu tìm không được rỗng", () => {
    expect(docSearchInput.parse({ query: "  thiết kế  ", limit: "20" })).toEqual({ query: "thiết kế", limit: 20 });
    expect(docSearchMcpInput.parse({ query: "thiết kế" }).limit).toBe(10);
    for (const input of [
      { query: " " },
      { query: "a", limit: 21 },
      { query: "a", limit: 0 },
      { query: "a", scope: "private" },
    ]) {
      expect(docSearchInput.safeParse(input).success).toBe(false);
    }
    expect(docSearchOutput.parse({ mode: "keyword", hits: [] })).toEqual({ mode: "keyword", hits: [] });
    expect(docSearchOutput.safeParse({ mode: "vector", hits: [] }).success).toBe(false);
  });

  it("lọc tài liệu lưu trữ nhận boolean và query string, thao tác cần phiên bản đã lưu", () => {
    expect(docListInput.parse({})).toEqual({});
    expect(docListInput.parse({ archived: "true" }).archived).toBe(true);
    expect(docListInput.parse({ archived: "false" }).archived).toBe(false);
    for (const name of ["archive", "restore"] as const) {
      const schema = contract.docs[name]["~orpc"].inputSchema;
      if (!schema) throw new Error("Thiếu schema lưu trữ tài liệu.");
      expect(schema.parse({ key: "org/test", baseVersion: 1 })).toEqual({ key: "org/test", baseVersion: 1 });
      expect(schema.safeParse({ key: "org/test", baseVersion: 0 }).success).toBe(false);
    }
  });

  it("save cũ vẫn hợp lệ, xác nhận bí mật tường minh, lỗi chỉ gồm loại và dòng", () => {
    const save = { key: "org/test", content: "nội dung", baseVersion: 0 };
    expect(docSaveInput.parse(save)).toEqual(save);
    expect(docSaveInput.parse({ ...save, acknowledgeSecrets: true }).acknowledgeSecrets).toBe(true);
    expect(docSaveInput.safeParse({ ...save, acknowledgeSecrets: "true" }).success).toBe(false);
    expect(
      docSecretErrorData.parse({
        code: "DOC_SECRET_FOUND",
        findings: [{ kind: "github_token", line: 4, value: "redacted" }],
      }),
    ).toEqual({ code: "DOC_SECRET_FOUND", findings: [{ kind: "github_token", line: 4 }] });
    expect(
      docSecretErrorData.safeParse({ code: "DOC_SECRET_FOUND", findings: [{ kind: "github_token", line: 0 }] }).success,
    ).toBe(false);
  });
});

describe("đăng ký hợp đồng", () => {
  it("đủ mọi endpoint T003", () => {
    const groups = {
      docHomes: [
        "get",
        "configureProject",
        "configureOrg",
        "remove",
        "pause",
        "resume",
        "acceptBranch",
        "syncNow",
        "adoptPreview",
        "adopt",
        "status",
      ],
      docImports: ["scan", "get", "files", "start", "cancel", "confirmSecret", "list"],
      docConflicts: ["list", "get", "resolve"],
      docAssets: ["resolve", "list"],
      docExtracts: ["list", "get", "update", "approve", "reject", "confirmSecret"],
      docTree: ["list", "move"],
      wordImports: ["get", "list", "file", "update", "commit", "cancel", "confirmLink", "approve", "ofDoc"],
    } as const;
    for (const group of Object.keys(groups) as (keyof typeof groups)[]) {
      expect(Object.keys(contract[group]).sort()).toEqual([...groups[group]].sort());
    }
    for (const name of ["search", "archive", "restore", "save"] as const) expect(contract.docs[name]).toBeDefined();
  });

  it("phân trang nhận query string và giới hạn kích thước", () => {
    const schema = contract.docImports.files["~orpc"].inputSchema;
    if (!schema) throw new Error("Thiếu schema danh sách file nhập.");
    expect(schema.parse({ id, limit: "200", cursor: "next" })).toEqual({ id, limit: 200, cursor: "next" });
    for (const limit of [0, 201, 1.5]) expect(schema.safeParse({ id, limit }).success).toBe(false);
  });

  it("trạng thái và mã lỗi nghiệp vụ ổn định", () => {
    expect(docHomeStatus.options).toEqual(["active", "paused", "error"]);
    expect(docImportState.options).toContain("cancelled");
    for (const state of ["blocked_secret", "deleted_in_repo", "conflict"])
      expect(docSyncState.parse(state)).toBe(state);
    for (const [code, error] of Object.entries(DOCSYNC_ERRORS)) {
      expect(docSyncErrorData.parse({ code })).toEqual({ code });
      expect(error.message.length).toBeGreaterThan(10);
    }
    expect(docSyncErrorData.safeParse({ code: "UNKNOWN" }).success).toBe(false);
  });

  it("sáu thông báo được chọn cho kênh tổ chức", () => {
    for (const event of [
      "docsync.sync_failed",
      "docsync.conflict",
      "docsync.paused",
      "docsync.import_done",
      "docsync.deleted_in_repo",
      "docsync.extract_review",
    ]) {
      expect(notificationEvent.parse(event)).toBe(event);
      expect(notificationChannelEvent.parse(event)).toBe(event);
    }
  });
});

describe("nhập Word", () => {
  const word = (name: string) => new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], name);
  const upload = { homeId: id, targetDir: "docs/srs/OPD/" };
  const fileId = "00000000-0000-4000-8000-000000000002";

  it("multipart nhận trường đơn hay lặp lại như nhau, cờ mật để trống thì theo cài đặt nhà", () => {
    const one = wordImportUploadInput.parse({
      ...upload,
      files: word("eHosV2i_SRS_OPD.OPD02_v1.1.docx"),
      relativePaths: "",
      lastModified: "1760000000000",
      confidential: "true",
    });
    expect(one).toMatchObject({
      mode: "create",
      relativePaths: [""],
      lastModified: [1760000000000],
      confidential: true,
    });
    expect(one.files).toHaveLength(1);
    expect(wordImportUploadInput.parse({ ...upload, files: [word("a.docx")] }).confidential).toBeUndefined();
    const many = wordImportUploadInput.parse({
      ...upload,
      files: [word("a.docx"), word("B.ODT"), word("c.doc")],
      relativePaths: ["", "OPD", "Thư mục con/OPD"],
      lastModified: [1, 2, 3],
    });
    expect(many.relativePaths).toEqual(["", "OPD", "Thư mục con/OPD"]);
    expect(wordImportUploadInput.parse({ homeId: id, targetDir: "", files: word("a.docx") }).targetDir).toBe("");
    expect(wordImportUploadOutput.parse({ importId: id })).toEqual({ importId: id });
  });

  it("multipart chặn sai đuôi, thiếu file, lệch số phần tử, thư mục thoát repo", () => {
    for (const input of [
      { ...upload, files: [] },
      { ...upload },
      { ...upload, files: word("srs.pdf") },
      { ...upload, files: word("docx") },
      { ...upload, files: "a.docx" },
      { ...upload, files: [word("a.docx"), word("b.docx")], relativePaths: [""] },
      { ...upload, files: [word("a.docx")], lastModified: [1, 2] },
      { ...upload, files: word("a.docx"), relativePaths: "../ngoai" },
      { ...upload, files: word("a.docx"), relativePaths: "/tuyet-doi" },
      { ...upload, targetDir: "../docs", files: word("a.docx") },
      { ...upload, files: word("a.docx"), lastModified: "-1" },
      { homeId: "khong-phai-uuid", targetDir: "docs/", files: word("a.docx") },
    ]) {
      expect(wordImportUploadInput.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
  });

  it("tạo cần thư mục đích và không nhận docKey; cập nhật và gắn cần docKey và đúng một file", () => {
    expect(wordImportUploadInput.safeParse({ homeId: id, files: word("a.docx") }).success).toBe(false);
    expect(wordImportUploadInput.safeParse({ ...upload, docKey: "org/a", files: word("a.docx") }).success).toBe(false);
    for (const mode of ["update", "link"] as const) {
      expect(
        wordImportUploadInput.parse({ homeId: id, mode, docKey: "project/ehis/srs/opd/opd02", files: word("a.docx") }),
      ).toMatchObject({ mode, docKey: "project/ehis/srs/opd/opd02" });
      expect(wordImportUploadInput.safeParse({ homeId: id, mode, files: word("a.docx") }).success).toBe(false);
      expect(
        wordImportUploadInput.safeParse({ homeId: id, mode, docKey: "org/a", files: [word("a.docx"), word("b.docx")] })
          .success,
      ).toBe(false);
    }
    expect(wordImportUploadInput.safeParse({ ...upload, mode: "replace", files: word("a.docx") }).success).toBe(false);
  });

  it("định dạng đọc theo đuôi, không phân biệt hoa thường", () => {
    expect(wordImportFormatOf("SRS v1.1.DOCX")).toBe("docx");
    expect(wordImportFormatOf("a.odt")).toBe("odt");
    expect(wordImportFormatOf("cu.doc")).toBe("doc");
    for (const name of ["a.pdf", "a.docx.zip", "docx", "a.dotx", ""]) expect(wordImportFormatOf(name), name).toBeNull();
  });

  it("trạng thái lượt và file theo spec, thêm proposed và cancelled", () => {
    expect(wordImportState.options).toEqual([
      "uploading",
      "converting",
      "ready",
      "committing",
      "done",
      "failed",
      "cancelled",
    ]);
    expect(wordImportFileState.options).toEqual([
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
  });

  it("mã cảnh báo cố định, mỗi mã có chữ tiếng Việt dùng chung", () => {
    expect(wordImportWarningCode.options).toEqual([
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
    expect(Object.keys(WORD_IMPORT_WARNINGS).sort()).toEqual([...wordImportWarningCode.options].sort());
    for (const text of Object.values(WORD_IMPORT_WARNINGS)) expect(text.length).toBeGreaterThan(20);
    expect(wordImportWarning.parse({ code: "footnote", count: 3, detail: null })).toEqual({
      code: "footnote",
      count: 3,
      detail: null,
    });
    expect(wordImportWarning.safeParse({ code: "unknown", count: 1, detail: null }).success).toBe(false);
    expect(wordImportWarning.safeParse({ code: "footnote", count: 0, detail: null }).success).toBe(false);
  });

  it("lỗi WORD_IMPORT_* tiếng Việt kèm cách sửa, data mang mã ổn định", () => {
    expect([...wordImportErrorCode.options].sort()).toEqual(
      [
        "WORD_IMPORT_PASSWORD",
        "WORD_IMPORT_NOT_WORD",
        "WORD_IMPORT_FILE_TOO_LARGE",
        "WORD_IMPORT_BATCH_TOO_LARGE",
        "WORD_IMPORT_DOC_DISABLED",
        "WORD_IMPORT_DISABLED",
        "WORD_IMPORT_TOO_LONG",
        "WORD_IMPORT_EXISTS",
        "WORD_IMPORT_DUPLICATE_PATH",
        "WORD_IMPORT_OUTSIDE_HOME",
        "WORD_IMPORT_NEEDS_MANAGE",
        "WORD_IMPORT_CONVERT_FAILED",
        "WORD_IMPORT_TIMEOUT",
      ].sort(),
    );
    expect(Object.keys(WORD_IMPORT_ERRORS).sort()).toEqual([...wordImportErrorCode.options].sort());
    for (const [code, error] of Object.entries(WORD_IMPORT_ERRORS)) {
      expect(wordImportErrorData.parse({ code })).toEqual({ code });
      // Câu lỗi nói cả lý do lẫn cách sửa: ít nhất hai câu.
      expect(error.message.split(". ").length, code).toBeGreaterThan(1);
    }
    expect(WORD_IMPORT_ERRORS.WORD_IMPORT_NEEDS_MANAGE.status).toBe("FORBIDDEN");
    expect(WORD_IMPORT_ERRORS.WORD_IMPORT_EXISTS.status).toBe("CONFLICT");
    expect(WORD_IMPORT_ERRORS.WORD_IMPORT_PASSWORD.status).toBe("BAD_REQUEST");
    expect(wordImportErrorData.parse({ code: "WORD_IMPORT_FILE_TOO_LARGE", fileId, limit: 52428800 })).toMatchObject({
      limit: 52428800,
    });
    expect(wordImportErrorData.safeParse({ code: "DOCSYNC_PAUSED" }).success).toBe(false);
  });

  it("sửa file trong lượt cần ít nhất một trường; đường dẫn là file .md trong repo", () => {
    expect(wordImportUpdateInput.parse({ fileId, path: "docs/srs/OPD/OPD02.md" }).path).toBe("docs/srs/OPD/OPD02.md");
    expect(wordImportUpdateInput.parse({ fileId, keepFront: true, excluded: false })).toEqual({
      fileId,
      keepFront: true,
      excluded: false,
    });
    expect(wordImportUpdateInput.parse({ fileId, title: "  OPD02  " }).title).toBe("OPD02");
    for (const input of [
      { fileId },
      { fileId, path: "docs/srs/OPD/OPD02.docx" },
      { fileId, path: "../OPD02.md" },
      { fileId, path: "docs/srs/OPD/" },
      { fileId, title: " " },
      { fileId, keepFront: "true" },
    ]) {
      expect(wordImportUpdateInput.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
  });

  it("tạo nhận danh sách file tuỳ chọn và xác nhận bí mật tường minh", () => {
    expect(wordImportCommitInput.parse({ importId: id })).toEqual({ importId: id });
    expect(wordImportCommitInput.parse({ importId: id, fileIds: [fileId], acknowledgeSecrets: true })).toEqual({
      importId: id,
      fileIds: [fileId],
      acknowledgeSecrets: true,
    });
    for (const input of [
      { importId: id, fileIds: [] },
      { importId: id, acknowledgeSecrets: "true" },
    ]) {
      expect(wordImportCommitInput.safeParse(input).success).toBe(false);
    }
  });

  const counts = {
    queued: 0,
    converting: 0,
    ready: 1,
    skipped: 0,
    blockedSecret: 0,
    failed: 0,
    proposed: 0,
    cancelled: 0,
    done: 0,
  };
  const lot = {
    id,
    homeId: id,
    targetDir: "docs/srs/OPD/",
    mode: "create",
    docKey: null,
    confidential: false,
    state: "ready",
    counts,
    createdBy: { id: "user-1", name: "BA" },
    createdAt: "2026-10-19T00:00:00.000Z",
    updatedAt: "2026-10-19T00:00:00.000Z",
  };
  const item = {
    id: fileId,
    importId: id,
    relativeDir: "",
    fileName: "eHosV2i_SRS_OPD.OPD02_v1.1.docx",
    format: "docx",
    size: 3_000_000,
    sha256: "a".repeat(64),
    versionLabel: "1.1",
    proposedPath: "docs/srs/OPD/OPD02.md",
    proposedTitle: "OPD02",
    path: "docs/srs/OPD/OPD02.md",
    title: "OPD02",
    key: "project/ehis/srs/opd/opd02",
    exists: false,
    keepFront: false,
    excluded: false,
    state: "ready",
    stats: { headings: 41, tables: 32, images: 33 },
    warnings: [{ code: "tracked_changes", count: 2, detail: null }],
    findings: [],
    error: null,
    linkMatches: null,
    docId: null,
    docVersion: null,
    proposalId: null,
    createdAt: "2026-10-19T00:00:00.000Z",
    updatedAt: "2026-10-19T00:00:00.000Z",
  };

  it("xem lượt trả quyền của người hỏi ở phạm vi đích để chọn Tạo hay Gửi duyệt", () => {
    for (const access of ["manage", "propose"] as const) {
      expect(wordImportGetOutput.parse({ import: lot, files: [item], access }).access).toBe(access);
    }
    expect(wordImportGetOutput.safeParse({ import: lot, files: [item], access: "read" }).success).toBe(false);
    expect(
      wordImportFile.parse({
        ...item,
        state: "failed",
        stats: null,
        error: { code: "WORD_IMPORT_PASSWORD", message: WORD_IMPORT_ERRORS.WORD_IMPORT_PASSWORD.message },
      }).error,
    ).toMatchObject({ code: "WORD_IMPORT_PASSWORD" });
  });

  it("xung đột nguồn Word không có commit repo; xung đột cũ mặc định nguồn repo", () => {
    const conflict = {
      id,
      homeId: id,
      docId: id,
      key: "org/a",
      title: "A",
      repoPath: "docs/a.md",
      baseVersion: 1,
      hubVersion: 2,
      repoCommit: "a".repeat(40),
      state: "open",
      resolution: null,
      resolvedVersion: null,
      createdAt: "2026-10-19T00:00:00.000Z",
      updatedAt: "2026-10-19T00:00:00.000Z",
    };
    expect(docConflict.parse(conflict).origin).toBe("repo");
    expect(docConflict.parse({ ...conflict, origin: "word", repoCommit: null })).toMatchObject({
      origin: "word",
      repoCommit: null,
    });
    expect(docConflict.safeParse({ ...conflict, origin: "sharepoint" }).success).toBe(false);
  });

  it("nhà có wordImportConfidential mặc định tắt, quản trị tổ chức bật được", () => {
    expect(docHomeConfigureOrgInput.parse(orgConfig).wordImportConfidential).toBe(false);
    expect(docHomeConfigureOrgInput.parse({ ...orgConfig, wordImportConfidential: true }).wordImportConfidential).toBe(
      true,
    );
    const shape = docHome.shape.wordImportConfidential;
    expect(shape.parse(undefined)).toBe(false);
    expect(shape.parse(true)).toBe(true);
  });

  it("phiên bản có nguồn word; đề xuất cũ không có origin vẫn hợp lệ", () => {
    expect(docVersionSource.options).toEqual(["hub", "repo", "import", "merge", "word"]);
    const v = { version: 1, title: "A", author: { userId: "u", runId: null }, message: null, proposalId: null };
    expect(docVersion.parse({ ...v, chars: 1, createdAt: "2026-10-19T00:00:00.000Z" }).source).toBeUndefined();
    expect(docVersion.parse({ ...v, chars: 1, createdAt: "2026-10-19T00:00:00.000Z", source: "word" }).source).toBe(
      "word",
    );
    const p = {
      id,
      kind: "doc",
      target: "org/a",
      scope: { level: "org", teamId: null, projectId: null },
      baseVersion: 0,
      title: null,
      description: null,
      content: "",
      reason: null,
      status: "pending",
      author: { userId: "u", runId: null },
      createdAt: "2026-10-19T00:00:00.000Z",
      decidedBy: null,
      decidedAt: null,
      decisionNote: null,
      resultVersion: null,
    };
    expect(proposal.parse(p).origin).toBeUndefined();
    expect(proposal.parse({ ...p, origin: { kind: "word", importFileId: fileId } }).origin).toEqual({
      kind: "word",
      importFileId: fileId,
    });
    expect(proposal.safeParse({ ...p, origin: { kind: "word" } }).success).toBe(false);
  });

  it("health báo nhập Word và .doc, hub cũ không trả vẫn hợp lệ", () => {
    const base = { status: "ok", version: "abc", time: "2026-10-19T00:00:00.000Z" };
    expect(healthOutput.parse(base)).toEqual(base);
    expect(healthOutput.parse({ ...base, wordImport: true, wordImportDoc: false })).toMatchObject({
      wordImport: true,
      wordImportDoc: false,
    });
  });

  it("route tải lên, ảnh giữ tạm và file gốc nằm ngoài oRPC", () => {
    expect(WORD_IMPORT_UPLOAD_PATH).toBe("/api/v1/docs/word-imports");
    expect(wordImportMediaPath(id, fileId, "9527ba12e6da.png")).toBe(
      `/api/v1/docs/word-imports/${id}/files/${fileId}/media/9527ba12e6da.png`,
    );
    expect(wordImportMediaPath(id, fileId, "a b.png")).toMatch(/media\/a%20b\.png$/);
    expect(wordImportOriginalPath(id, fileId)).toBe(`/api/v1/docs/word-imports/${id}/files/${fileId}/original`);
    const paths = Object.values(contract.wordImports).map((r) => r["~orpc"].route.path);
    expect(paths).not.toContain("/v1/docs/word-imports");
  });
});
